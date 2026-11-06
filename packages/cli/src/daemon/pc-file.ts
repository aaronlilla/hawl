import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { b64url } from "@hawl/protocol/src/hash.ts";
import {
  checkPcApproval,
  hasKeys,
  type KeyListing,
  lockPins,
  pinOnFirstUse,
  readPins,
  writePins,
} from "./passkey.ts";

/**
 * The helper's half of file_from_pc (a chat app sends a file on its owner's PC). The relay may
 * only ask about one absolute path at a time: `stat` reads nothing but the file's size and
 * identity; `hash` and `put` come only with the owner's passkey-signed Allow for this exact request,
 * verified here against keys pinned on this PC (passkey.ts), and read the file only when it is
 * still the same file (size, mtime, inode) through the same real path. No links, no folders,
 * no listing. `put` sends to this helper's own relay, once per request.
 */

export type PcFileFrame = {
  t: "pcfile";
  id: string;
  op: "stat" | "hash" | "put";
  path: string;
  bytes?: number;
  mtime_ms?: number;
  ino?: string;
  sha256?: string;
  url?: string;
  /** hash and put: the request (pcf_), the recipient (res_) and the owner's signed approval. */
  request_id?: string;
  to?: string;
  approval?: unknown;
};

type Result = Record<string, unknown>;

const win = process.platform === "win32";
const samePath = (a: string, b: string) =>
  win ? a.toLowerCase() === b.toLowerCase() : a === b;

type Id = { bytes: number; mtime_ms: number; ino: string };
const idOf = (s: BigIntStats): Id => ({
  bytes: Number(s.size),
  mtime_ms: Number(s.mtimeMs),
  ino: String(s.ino),
});

class Refused extends Error {}

/** The one file at `path`, as a regular file reached through no link. Reads nothing. */
async function look(path: string): Promise<Id> {
  // Two leading separators (UNC, \\?\, \\.\, //host, mixed) make Windows open a network session
  // and send the owner's NetNTLM hash; refused before any disk call. On Windows only X:\ or X:/.
  if (
    !isAbsolute(path) ||
    /^[\\/]{2}/.test(path) ||
    (win && !/^[A-Za-z]:[\\/]/.test(path))
  )
    throw new Refused(
      "path must be the file's full path, for example C:\\Users\\sam\\Documents\\report.csv.",
    );
  let st: BigIntStats;
  try {
    st = await lstat(path, { bigint: true });
  } catch {
    throw new Refused(`There is no file at ${path} on your owner's PC.`);
  }
  if (st.isSymbolicLink())
    throw new Refused(
      `${path} is a link. Hawl sends only a file named by its own path.`,
    );
  if (!st.isFile())
    throw new Refused(
      `${path} is a folder or not a regular file. Name one file.`,
    );
  // A link in a parent folder (symlink, junction) would make the path read somewhere else.
  const real = await realpath(path).catch(() => "");
  if (!samePath(real, resolve(path)))
    throw new Refused(
      `${path} goes through a linked folder. Hawl sends only a file named by its real path.`,
    );
  return idOf(st);
}

const CHANGED =
  "the file changed after your owner allowed it, so it was not sent. Ask again to send the new version.";

/** The approved file's bytes: same identity before and after open, exactly the approved size. */
async function readSame(f: PcFileFrame): Promise<Buffer> {
  const want = { bytes: f.bytes, mtime_ms: f.mtime_ms, ino: f.ino };
  const same = (x: Id) =>
    x.bytes === want.bytes &&
    x.mtime_ms === want.mtime_ms &&
    x.ino === want.ino;
  if (!same(await look(f.path))) throw new Refused(CHANGED);
  // O_NOFOLLOW where the OS has it: a link swapped in after the look is not followed.
  const fh = await open(
    f.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!same(idOf(await fh.stat({ bigint: true }))))
      throw new Refused(CHANGED);
    const data = await fh.readFile();
    if (data.length !== want.bytes) throw new Refused(CHANGED);
    return data;
  } finally {
    await fh.close();
  }
}

/**
 * Answer one `pcfile` frame with its `pcfile.result`. `sent` holds the upload links already
 * used, so one approved upload is sent once even if the relay asks twice.
 */
export async function answerPcFile(
  f: PcFileFrame,
  o: {
    relayUrl: string;
    sent: Set<string>;
    /** Where the pinned passkeys live, and the helper (res_) this frame came to. */
    stateDir: string;
    residentId: string;
    /** The owner's passkeys as the relay lists them, for pairing (passkey.ts pinOnFirstUse). */
    pinKeys?: () => Promise<KeyListing>;
    doFetch?: typeof fetch;
    now?: () => number;
  },
): Promise<Result> {
  const out = (r: Result): Result => ({ t: "pcfile.result", id: f.id, ...r });
  try {
    if (f.op === "stat") return out({ ok: true, ...(await look(f.path)) });
    // Nothing is read unless the owner's own passkey signed this exact request.
    // No owner key pinned yet (paired before the owner had a passkey): pin the first listed now.
    if (o.pinKeys && !hasKeys(readPins(o.stateDir), o.residentId))
      await pinOnFirstUse(o.stateDir, o.residentId, o.pinKeys).catch(() => {});
    // Check and record under the file lock: no other hawl process can write in between.
    const no = await lockPins(o.stateDir, () => {
      const pins = readPins(o.stateDir);
      const why = checkPcApproval({
        pins,
        residentId: o.residentId,
        op: f.op,
        fields: {
          request_id: String(f.request_id ?? ""),
          path: f.path,
          bytes: f.bytes ?? -1,
          mtime_ms: f.mtime_ms ?? -1,
          ino: f.ino ?? "",
          to_id: String(f.to ?? ""),
        },
        approval: f.approval,
        now: (o.now ?? Date.now)(),
      });
      if (!why) writePins(o.stateDir, pins);
      return why;
    });
    if (no) throw new Refused(no);
    const data = await readSame(f);
    const sha256 = b64url(createHash("sha256").update(data).digest());
    if (f.op === "hash") return out({ ok: true, sha256 });
    if (sha256 !== f.sha256) throw new Refused(CHANGED);
    let url: URL;
    try {
      url = new URL(String(f.url));
    } catch {
      throw new Refused("the upload link was not valid.");
    }
    if (url.origin !== new URL(o.relayUrl).origin)
      throw new Refused("the upload link was not on this helper's relay.");
    const key = `${url.pathname}|${f.path}`;
    if (o.sent.has(key)) throw new Refused("it was already sent once.");
    o.sent.add(key);
    const res = await (o.doFetch ?? fetch)(url, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(data),
    });
    if (!res.ok) {
      let msg = `the relay refused the upload (${res.status}).`;
      try {
        const j = (await res.json()) as { error?: { message?: string } };
        if (j.error?.message) msg = j.error.message;
      } catch {
        // keep the status
      }
      throw new Refused(msg);
    }
    return out({ ok: true });
  } catch (e) {
    return out({
      ok: false,
      reason: (e instanceof Refused
        ? e.message
        : `the helper could not read ${f.path} (${(e as NodeJS.ErrnoException).code ?? "error"}).`
      ).slice(0, 500),
    });
  }
}
