import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { b64url } from "@hawl/protocol/src/hash.ts";
import type { Signer } from "./keys.ts";
import { downloadFile, fileMeta, unavailable } from "./upload.ts";

const FIL = "fil_01926f3a-0000-7000-8000-000000000003";
const signer = {
  kid: "key_t",
  sign: () => Buffer.alloc(64),
} as unknown as Signer;
const sha = (b: Buffer) => b64url(createHash("sha256").update(b).digest());

type Meta = {
  name?: string;
  state?: string;
  release_state?: string;
  sha256?: string;
  bytes?: number;
};

/** A relay that answers the token, the file metadata and the content. */
function relay(data: Buffer, over: Meta = {}, status = 200) {
  const calls: string[] = [];
  const doFetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/auth/token")
      return Response.json({ access_token: "tok" });
    if (url.pathname === `/v1/files/${FIL}`) {
      if (status === 404) return new Response("{}", { status: 404 });
      return Response.json({
        file_id: FIL,
        name: "out.txt",
        mime: "text/plain",
        bytes: data.length,
        sha256: sha(data),
        state: "clean",
        release_state: "released",
        ...over,
      });
    }
    if (url.pathname === `/v1/files/${FIL}/content`) {
      return new Response(data);
    }
    return new Response("no", { status: 500 });
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

const base = (doFetch: typeof fetch, dir: string) => ({
  relayUrl: "http://relay.test",
  residentId: "res_x",
  signer,
  fileId: FIL,
  dir,
  doFetch,
});
const tmp = () => mkdtempSync(join(tmpdir(), "hawl-dl-"));

test("file_get downloads, checks the sha256 and writes name, path and size", async () => {
  const data = Buffer.from("test output\n");
  const dir = join(tmp(), ".hawl", "files");
  const r = await downloadFile(base(relay(data).doFetch, dir));
  assert.equal(r.path, join(dir, "out.txt"));
  assert.equal(r.name, "out.txt");
  assert.equal(r.bytes, data.length);
  assert.equal(r.sha256, sha(data));
  assert.equal(readFileSync(r.path, "utf8"), "test output\n");
});

test("save_to names the file, or a folder the file goes into", async () => {
  const data = Buffer.from("x");
  const root = tmp();
  const dir = join(root, "d");
  const file = join(dir, "a", "copy.txt");
  const a = await downloadFile({
    ...base(relay(data).doFetch, dir),
    saveTo: file,
  });
  assert.equal(a.path, file);
  const folder = join(dir, "folder");
  mkdirSync(folder);
  const b = await downloadFile({
    ...base(relay(data).doFetch, dir),
    saveTo: folder,
  });
  assert.equal(b.path, join(folder, "out.txt"));
});

test("SEC save_to cannot leave .hawl/files: ../, absolute, symlink and overwrite are refused", async () => {
  const data = Buffer.from("payload");
  const root = tmp();
  const dir = join(root, ".hawl", "files");
  const victim = join(root, "victim.txt");
  writeFileSync(victim, "keep me");
  const run = (saveTo: string) =>
    downloadFile({ ...base(relay(data).doFetch, dir), saveTo });
  await assert.rejects(run(join(dir, "..", "..", "victim.txt")), /inside/);
  await assert.rejects(run(victim), /inside/);
  await assert.rejects(run(join(root, "elsewhere", "x.txt")), /inside/);
  assert.equal(readFileSync(victim, "utf8"), "keep me");
  assert.equal(existsSync(join(root, "elsewhere")), false);
  // A symlink inside the folder that points out is not a way out.
  const link = join(dir, "link");
  try {
    symlinkSync(root, link, "junction");
    await assert.rejects(run(join(link, "victim.txt")), /inside/);
    assert.equal(readFileSync(victim, "utf8"), "keep me");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
  }
  // An existing file inside the folder is never overwritten.
  const mine = join(dir, "mine.txt");
  writeFileSync(mine, "other bytes");
  await assert.rejects(run(mine), /already at that path/);
  assert.equal(readFileSync(mine, "utf8"), "other bytes");
});

test("a different file with the same name is kept apart, the same bytes are reused", async () => {
  const dir = tmp();
  const one = await downloadFile(base(relay(Buffer.from("one")).doFetch, dir));
  const two = await downloadFile(base(relay(Buffer.from("two")).doFetch, dir));
  assert.equal(one.path, join(dir, "out.txt"));
  assert.notEqual(two.path, one.path);
  assert.equal(readFileSync(one.path, "utf8"), "one");
  assert.equal(readFileSync(two.path, "utf8"), "two");
  const again = await downloadFile(
    base(relay(Buffer.from("one")).doFetch, dir),
  );
  assert.equal(again.path, one.path);
});

test("bytes that do not match the sha256 are refused and nothing is written", async () => {
  const dir = tmp();
  const bad = relay(Buffer.from("tampered"), { sha256: sha(Buffer.from("x")) });
  await assert.rejects(downloadFile(base(bad.doFetch, dir)), /sha256/);
  assert.equal(existsSync(join(dir, "out.txt")), false);
});

test("a blocked, unscanned, held or own file answers why and downloads nothing", async () => {
  const data = Buffer.from("x");
  const cases: [Meta, RegExp][] = [
    [{ state: "blocked" }, /scanner blocked/],
    [{ state: "rejected" }, /scanner rejected/],
    [{ state: "scan_unavailable" }, /could not check/],
    [{ state: "gate_check" }, /still being checked/],
    [{ release_state: "held" }, /waiting for its owner's approval/],
    [{ release_state: "self" }, /your own upload/],
  ];
  for (const [over, re] of cases) {
    const r = relay(data, over);
    await assert.rejects(downloadFile(base(r.doFetch, tmp())), re);
    assert.equal(
      r.calls.some((c) => c.endsWith("/content")),
      false,
      JSON.stringify(over),
    );
  }
  assert.equal(
    unavailable({ state: "clean", release_state: "released" }),
    null,
  );
  assert.equal(
    unavailable({ state: "flagged", release_state: "released" }),
    null,
  );
});

test("an unknown file says it was not sent to you", async () => {
  const r = relay(Buffer.from("x"), {}, 404);
  await assert.rejects(
    downloadFile(base(r.doFetch, tmp())),
    /never sent to you/,
  );
  await assert.rejects(
    fileMeta({
      relayUrl: "http://relay.test",
      residentId: "res_x",
      signer,
      fileId: FIL,
      doFetch: r.doFetch,
    }),
    /dm_send or thread_reply/,
  );
});

test("fileMeta returns the part fields a signed message needs", async () => {
  const data = Buffer.from("meta");
  const m = await fileMeta({
    relayUrl: "http://relay.test",
    residentId: "res_x",
    signer,
    fileId: FIL,
    doFetch: relay(data).doFetch,
  });
  assert.deepEqual(
    [m.name, m.mime, m.bytes, m.sha256],
    ["out.txt", "text/plain", data.length, sha(data)],
  );
});
