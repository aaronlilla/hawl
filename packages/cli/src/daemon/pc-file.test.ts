import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "../test-tmp.ts";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { b64url } from "@hawl/protocol/src/hash.ts";
import { writePins } from "./passkey.ts";
import { fakePasskey } from "./passkey-fake.ts";
import { answerPcFile, type PcFileFrame } from "./pc-file.ts";

// Real files on the real disk. The "relay" is a local HTTP server that records every PUT.
let dir: string;
let stateDir: string;
let relayUrl: string;
const HELPER = "res_helper";
const ORIGIN = "https://hawl.ai";
const key = fakePasskey();
const puts: { path: string; body: Buffer }[] = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    puts.push({ path: req.url ?? "", body: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});

before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "hawl-pcfile-cli-")));
  stateDir = await mkdtemp(join(tmpdir(), "hawl-pcfile-state-"));
  writePins(stateDir, {
    v: 1,
    owners: {
      usr_owner: {
        origin: ORIGIN,
        keys: [
          { id: key.credential_id, cose: key.cose, name: "k", counter: 0 },
        ],
      },
    },
    residents: { [HELPER]: "usr_owner" },
    used: {},
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  relayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** One frame to the helper; hash and put carry the owner's signed approval for that file. */
const ask = (f: Partial<PcFileFrame>, sent = new Set<string>()) => {
  const frame: PcFileFrame = {
    t: "pcfile",
    id: "req_1",
    op: "stat",
    path: "",
    ...f,
  };
  if (frame.op !== "stat") {
    frame.request_id ??= `pcf_${frame.path}`;
    frame.to ??= "res_sam";
    frame.approval = key.approve(
      {
        request_id: frame.request_id,
        helper_id: HELPER,
        path: frame.path,
        bytes: frame.bytes ?? -1,
        mtime_ms: frame.mtime_ms ?? -1,
        ino: frame.ino ?? "",
        to_id: frame.to,
        exp: Date.now() + 60_000,
      },
      { origin: ORIGIN },
    );
  }
  return answerPcFile(frame, { relayUrl, sent, stateDir, residentId: HELPER });
};
const sha = (s: string) => b64url(createHash("sha256").update(s).digest());

test("stat reads size and identity only; hash and put send exactly that file, once", async () => {
  const path = join(dir, "a.csv");
  await writeFile(path, "x,y\n1,2\n");
  const st = await ask({ op: "stat", path });
  assert.equal(st.t, "pcfile.result");
  assert.equal(st.id, "req_1");
  assert.equal(st.ok, true, String(st.reason));
  assert.equal(st.bytes, 8);
  assert.equal(typeof st.ino, "string");
  const same = {
    path,
    bytes: st.bytes as number,
    mtime_ms: st.mtime_ms as number,
    ino: st.ino as string,
  };
  const h = await ask({ op: "hash", ...same });
  assert.equal(h.sha256, sha("x,y\n1,2\n"));
  const sent = new Set<string>();
  const url = `${relayUrl}/v1/files/uploads/upl_1?sig=s`;
  const put = await ask(
    { op: "put", ...same, sha256: h.sha256 as string, url },
    sent,
  );
  assert.equal(put.ok, true, String(put.reason));
  assert.equal(puts.length, 1);
  assert.equal(puts[0]?.body.toString(), "x,y\n1,2\n");
  // The same upload link again: refused, nothing more sent.
  const twice = await ask(
    { op: "put", ...same, sha256: h.sha256 as string, url },
    sent,
  );
  assert.equal(twice.ok, false);
  assert.match(String(twice.reason), /already used|already sent once/);
  assert.equal(puts.length, 1);
});

test("a file that changed since the stat is refused before anything is sent", async () => {
  const path = join(dir, "b.txt");
  await writeFile(path, "one");
  const st = await ask({ op: "stat", path });
  const same = {
    path,
    bytes: st.bytes as number,
    mtime_ms: st.mtime_ms as number,
    ino: st.ino as string,
  };
  // Same size, new time: still a different file than the owner allowed.
  await writeFile(path, "two");
  await utimes(path, new Date(), new Date(Date.now() + 5000));
  const before = puts.length;
  const h = await ask({ op: "hash", ...same });
  assert.equal(h.ok, false);
  assert.match(String(h.reason), /changed after your owner allowed it/);
  const put = await ask({
    op: "put",
    ...same,
    sha256: sha("one"),
    url: `${relayUrl}/v1/files/uploads/upl_2?sig=s`,
  });
  assert.equal(put.ok, false);
  assert.equal(puts.length, before);
});

test("missing files, folders, relative paths and links are refused; nothing is listed", async () => {
  const miss = await ask({ op: "stat", path: join(dir, "nope.txt") });
  assert.match(String(miss.reason), /There is no file at/);
  const folder = await ask({ op: "stat", path: dir });
  assert.match(String(folder.reason), /folder or not a regular file/);
  const rel = await ask({ op: "stat", path: "a.csv" });
  assert.match(String(rel.reason), /full path/);
  assert.equal(Object.hasOwn(folder, "entries"), false);

  const target = join(dir, "real.txt");
  await writeFile(target, "real");
  // A link to a file needs a privilege on Windows; a junction to a folder does not.
  try {
    await symlink(target, join(dir, "link.txt"), "file");
    const l = await ask({ op: "stat", path: join(dir, "link.txt") });
    assert.match(String(l.reason), /is a link/);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
  }
  await mkdir(join(dir, "inner"));
  await writeFile(join(dir, "inner", "deep.txt"), "deep");
  await symlink(join(dir, "inner"), join(dir, "via"), "junction");
  const via = await ask({ op: "stat", path: join(dir, "via", "deep.txt") });
  assert.equal(via.ok, false);
  assert.match(String(via.reason), /linked folder/);
});

test("put goes only to this helper's own relay", async () => {
  const path = join(dir, "c.txt");
  await writeFile(path, "c");
  const st = await ask({ op: "stat", path });
  const before = puts.length;
  const out = await ask({
    op: "put",
    path,
    bytes: st.bytes as number,
    mtime_ms: st.mtime_ms as number,
    ino: st.ino as string,
    sha256: sha("c"),
    url: "https://elsewhere.example/v1/files/uploads/upl_3?sig=s",
  });
  assert.equal(out.ok, false);
  assert.match(String(out.reason), /not on this helper's relay/);
  assert.equal(puts.length, before);
});

test("network and device paths (UNC, \\\\?\\, \\\\.\\, //host) are refused before any disk access, even with a signed Allow", async () => {
  const paths = [
    "\\\\evil.example\\s\\a.txt",
    "//evil.example/s/a.txt",
    "/\\evil.example\\s\\a.txt",
    "\\/evil.example/s/a.txt",
    "\\\\?\\UNC\\evil.example\\s\\a.txt",
    "\\\\.\\C:\\a.txt",
  ];
  for (const path of paths)
    for (const op of ["stat", "hash"] as const) {
      const r = await ask({ op, path, bytes: 1, mtime_ms: 1, ino: "1" });
      assert.equal(r.ok, false, `${op} ${path}`);
      assert.match(String(r.reason), /full path/, `${op} ${path}`);
    }
});
