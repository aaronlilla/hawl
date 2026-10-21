import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { b64url } from "@hawl/protocol/src/hash.ts";
import type { Signer } from "./keys.ts";

/** Extension to the declared mime the relay accepts (apps/relay/src/files/uploads.ts). */
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  zip: "application/zip",
  json: "application/json",
  xml: "application/xml",
  ndjson: "application/x-ndjson",
  txt: "text/plain",
  md: "text/plain",
  log: "text/plain",
  csv: "text/csv",
};

type Doer = typeof fetch;

/** A 60 s client assertion signed by the worker key, exchanged for a 10 min AgentToken (04 3.2). */
export async function agentToken(
  relayUrl: string,
  residentId: string,
  signer: Signer,
  doFetch: Doer = fetch,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => b64url(Buffer.from(JSON.stringify(o)));
  const head = enc({ alg: "EdDSA", typ: "JWT", kid: signer.kid });
  const body = enc({
    iss: residentId,
    sub: residentId,
    aud: relayUrl.replace(/\/+$/, ""),
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
  });
  const sig = b64url(signer.sign(Buffer.from(`${head}.${body}`)));
  const res = await doFetch(new URL("/v1/auth/token", relayUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_assertion: `${head}.${body}.${sig}` }),
  });
  if (!res.ok)
    throw new Error(`relay refused the worker token (${res.status})`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** An AgentToken that is renewed a minute before it lapses (it lives 10 minutes). */
export function tokenSource(
  relayUrl: string,
  residentId: string,
  signer: Signer,
  doFetch: Doer = fetch,
): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && Date.now() < cached.until) return cached.token;
    const token = await agentToken(relayUrl, residentId, signer, doFetch);
    cached = { token, until: Date.now() + 8 * 60_000 };
    return token;
  };
}

const mb = (n: number) => `${Math.max(1, Math.round(n / (1024 * 1024)))} MB`;
/** A file just over the limit rounds up, so "26 MB" never reads as "25 MB" next to a 25 MB limit. */
const mbUp = (n: number) => `${Math.max(1, Math.ceil(n / (1024 * 1024)))} MB`;

/**
 * Why the relay refused to start an upload, in words. A 413 names the size and, when the relay
 * sends the cap (`details.max_bytes`), the limit.
 */
export async function refusalText(
  res: Pick<Response, "status" | "json">,
  size: number,
): Promise<string> {
  let err: { message?: string; details?: { max_bytes?: unknown } } | undefined;
  try {
    err = ((await res.json()) as { error?: typeof err }).error;
  } catch {
    // no JSON body
  }
  if (res.status === 413) {
    const max = err?.details?.max_bytes;
    return typeof max === "number" && max > 0
      ? `File is too large: ${mbUp(size)}. The limit is ${mb(max)}.`
      : `File is too large: ${mbUp(size)}. It is over the file size limit of this site's plan.`;
  }
  return err?.message
    ? `upload refused: ${err.message} (${res.status})`
    : `upload refused (${res.status})`;
}

/**
 * `file_put {path}`: the daemon reads the local file and sends the bytes up (the relay never
 * reads a worker's disk). Returns the relay's upload id. The same bytes from the same worker
 * answer with the first upload, so polling `file_put` shows the scan result without re-sending.
 */
export async function uploadFile(o: {
  relayUrl: string;
  residentId: string;
  signer: Signer;
  path: string;
  seen: Map<string, string>;
  doFetch?: Doer;
}): Promise<string> {
  const doFetch = o.doFetch ?? fetch;
  const bytes = await readFile(o.path);
  const sha = b64url(createHash("sha256").update(bytes).digest());
  const key = `${o.residentId}|${sha}`;
  const known = o.seen.get(key);
  if (known) return known;
  const name = basename(o.path);
  const mime = MIME[extname(name).slice(1).toLowerCase()];
  if (!mime) throw new Error("file type not allowed");
  const token = await agentToken(o.relayUrl, o.residentId, o.signer, doFetch);
  const auth = { authorization: `Bearer ${token}` };
  const made = await doFetch(new URL("/v1/files/uploads", o.relayUrl), {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ name, mime, bytes: bytes.length, sha256: sha }),
  });
  if (!made.ok) throw new Error(await refusalText(made, bytes.length));
  const { upl_id, put_url } = (await made.json()) as {
    upl_id: string;
    put_url: string;
  };
  const put = await doFetch(new URL(put_url, o.relayUrl), {
    method: "PUT",
    headers: { ...auth, "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (!put.ok) throw new Error(`upload failed (${put.status})`);
  o.seen.set(key, upl_id);
  return upl_id;
}

/** What the relay knows about a file this worker may see (GET /v1/files/{fil}). */
export type FileMeta = {
  file_id: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  state: string;
  release_state: string;
};

/** Why bytes cannot be taken, in a sentence the agent can act on. */
export function unavailable(
  m: Pick<FileMeta, "state" | "release_state">,
): string | null {
  if (m.release_state === "self")
    return "This is your own upload. Only a recipient of a message that carries it can download it.";
  if (m.release_state !== "released")
    return "The message that carries this file is waiting for its owner's approval, so the file cannot be downloaded yet.";
  if (m.state === "blocked" || m.state === "rejected")
    return `The scanner ${m.state === "blocked" ? "blocked" : "rejected"} this file, so it cannot be downloaded.`;
  if (m.state === "scan_unavailable")
    return "The scanner could not check this file yet, so it cannot be downloaded. Try again later.";
  if (m.state !== "clean" && m.state !== "flagged")
    return "The file is still being checked. Try again in a few seconds.";
  return null;
}

/** Metadata of a file by id, for the signed file part of a message or a download. */
export async function fileMeta(o: {
  relayUrl: string;
  residentId: string;
  signer: Signer;
  fileId: string;
  doFetch?: Doer;
}): Promise<FileMeta> {
  const doFetch = o.doFetch ?? fetch;
  const token = await agentToken(o.relayUrl, o.residentId, o.signer, doFetch);
  const res = await doFetch(new URL(`/v1/files/${o.fileId}`, o.relayUrl), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404)
    throw new Error(
      "No such file, or it was never sent to you. Ask the sender to attach it to a message (the files argument of dm_send or thread_reply).",
    );
  if (!res.ok) throw new Error(`relay ${res.status} reading the file`);
  return (await res.json()) as FileMeta;
}

const safeName = (n: string): string =>
  basename(n)
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/^\.+/, "_") || "file";

/** `target` must resolve, through real directories, to a place inside `root` (already real). */
async function assertInside(root: string, target: string): Promise<void> {
  let probe = target;
  const rest: string[] = [];
  for (;;) {
    try {
      probe = await realpath(probe);
      break;
    } catch {
      const up = dirname(probe);
      if (up === probe) throw new Error("save_to is outside .hawl/files");
      rest.unshift(basename(probe));
      probe = up;
    }
  }
  const real = join(probe, ...rest);
  const rel = relative(root, real);
  if (
    rel === "" ||
    rel.startsWith(`..${sep}`) ||
    rel === ".." ||
    isAbsolute(rel)
  )
    throw new Error(
      "save_to must stay inside this project's .hawl/files folder.",
    );
}

/**
 * `file_get`: download a released file, check its sha256 and write it. The default place is
 * `<dir>/<name>` (the project's .hawl/files); a different file already there gets the id as a
 * prefix instead of being overwritten. A blocked, held or unscanned file answers why.
 */
export async function downloadFile(o: {
  relayUrl: string;
  residentId: string;
  signer: Signer;
  fileId: string;
  dir: string;
  saveTo?: string;
  doFetch?: Doer;
}): Promise<{ path: string; sha256: string; name: string; bytes: number }> {
  const doFetch = o.doFetch ?? fetch;
  const meta = await fileMeta(o);
  const why = unavailable(meta);
  if (why) throw new Error(why);
  const token = await agentToken(o.relayUrl, o.residentId, o.signer, doFetch);
  const res = await doFetch(
    new URL(`/v1/files/${o.fileId}/content`, o.relayUrl),
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`relay ${res.status} downloading the file`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha = b64url(createHash("sha256").update(bytes).digest());
  if (sha !== meta.sha256 || bytes.length !== meta.bytes)
    throw new Error(
      "The downloaded bytes do not match the file's sha256, so nothing was saved.",
    );
  const name = safeName(meta.name);
  let path = join(o.dir, name);
  // Whatever the agent passed as save_to, bytes only ever land inside `dir` (the project's
  // .hawl/files), never through a `..`, an absolute path or a symlink, and never over a file.
  await mkdir(o.dir, { recursive: true });
  const root = await realpath(o.dir);
  if (o.saveTo) {
    path = resolve(root, o.saveTo);
    if ((await stat(path).catch(() => null))?.isDirectory())
      path = join(path, name);
    await assertInside(root, path);
  } else {
    const have = await readFile(path).catch(() => null);
    if (
      have &&
      b64url(createHash("sha256").update(have).digest()) !== meta.sha256
    )
      path = join(o.dir, `${o.fileId.slice(4, 12)}-${name}`);
  }
  await mkdir(dirname(path), { recursive: true });
  if (o.saveTo) await assertInside(root, path);
  try {
    // Exclusive create: an existing file (or a symlink planted at the path) is never written.
    await writeFile(path, bytes, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const have = await readFile(path).catch(() => null);
    const same =
      have && b64url(createHash("sha256").update(have).digest()) === sha;
    if (!same)
      throw new Error(
        "A file is already at that path; nothing was overwritten. Pick another save_to.",
      );
  }
  return { path, sha256: sha, name: meta.name, bytes: bytes.length };
}
