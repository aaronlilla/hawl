import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "../test-tmp.ts";
import { join } from "node:path";
import { test } from "node:test";
import { fileMeta, refusalText, uploadFile, uploadPath } from "./upload.ts";

const MB = 1024 * 1024;
const res = (status: number, body: unknown) => ({
  status,
  json: async () => body,
});

test("a 413 says the size and the limit in plain words", async () => {
  assert.equal(
    await refusalText(
      res(413, {
        error: {
          message: "File over the plan limit.",
          details: { max_bytes: 25 * MB },
        },
      }),
      26 * MB,
    ),
    "File is too large: 26 MB. The limit is 25 MB.",
  );
});

test("a file one byte over the cap reads as over, not equal", async () => {
  const t = await refusalText(
    res(413, { error: { message: "x", details: { max_bytes: 25 * MB } } }),
    25 * MB + 1,
  );
  assert.equal(t, "File is too large: 26 MB. The limit is 25 MB.");
});

test("a 413 without a cap still says it is too large, never a bare status", async () => {
  const t = await refusalText(res(413, { error: { message: "x" } }), 26 * MB);
  assert.match(t, /^File is too large: 26 MB\./);
  assert.doesNotMatch(t, /413/);
});

test("other refusals keep the relay's words and a non-JSON body does not throw", async () => {
  assert.equal(
    await refusalText(res(429, { error: { message: "Too many uploads." } }), 1),
    "upload refused: Too many uploads. (429)",
  );
  assert.equal(
    await refusalText(
      {
        status: 502,
        json: async () => {
          throw new Error("html");
        },
      },
      1,
    ),
    "upload refused (502)",
  );
});

test("file_put on a missing file says so plainly, without Node's message or the absolute path", async () => {
  await assert.rejects(
    uploadFile({
      relayUrl: "http://127.0.0.1:1",
      residentId: "res_x",
      signer: {} as never,
      path: "no-such-file-xyz.txt",
      seen: new Map(),
    }),
    { message: "file not found: no-such-file-xyz.txt" },
  );
});

test("file_put declares text/plain for source files the scanner allows, and still refuses svg", async () => {
  const dir = await mkdtemp(join(tmpdir(), "put-"));
  const declared: Record<string, string> = {};
  const doFetch = (async (url: URL, init?: RequestInit) => {
    const u = String(url);
    const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b });
    if (u.endsWith("/v1/auth/token")) return ok({ access_token: "t" });
    if (u.endsWith("/v1/files/uploads")) {
      const b = JSON.parse(String(init?.body));
      declared[b.name] = b.mime;
      return ok({ upl_id: "upl_1", put_url: "/put" });
    }
    return ok({});
  }) as unknown as typeof fetch;
  const signer = { kid: "k", sign: () => Buffer.from("s") } as never;
  const put = (name: string) =>
    uploadFile({
      relayUrl: "http://relay.test",
      residentId: "res_x",
      signer,
      path: join(dir, name),
      seen: new Map(),
      doFetch,
    });
  try {
    for (const name of ["a.js", "a.py", "a.html", "a.yaml"]) {
      await writeFile(join(dir, name), `// ${name}`);
      await put(name);
      assert.equal(declared[name], "text/plain", name);
    }
    await writeFile(join(dir, "a.svg"), "<svg/>");
    await assert.rejects(put("a.svg"), { message: "file type not allowed" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file_meta rides out a short 503 outage (spec H9)", async () => {
  let hits = 0;
  const meta = {
    file_id: "fil_1",
    name: "a.txt",
    mime: "text/plain",
    bytes: 1,
    sha256: "x",
    state: "clean",
    release_state: "released",
  };
  const json = (status: number, b: unknown) =>
    new Response(JSON.stringify(b), { status });
  const doFetch = (async (u: URL | string) => {
    if (String(u).endsWith("/v1/auth/token"))
      return json(200, { access_token: "t" });
    return ++hits < 3 ? json(503, {}) : json(200, meta);
  }) as typeof fetch;
  const got = await fileMeta({
    relayUrl: "http://relay.test",
    residentId: "res_x",
    signer: { kid: "k", sign: () => Buffer.from("s") } as never,
    fileId: "fil_1",
    doFetch,
  });
  assert.equal(got.file_id, "fil_1");
  assert.equal(hits, 3);
});

test("file_put resolves a relative path from the session's folder; fenced, nothing outside it goes", async () => {
  const root = await mkdtemp(join(tmpdir(), "hawl-fp-"));
  const folder = join(root, "recipe-box");
  const outside = join(root, "secret.txt");
  await mkdir(join(folder, "notes"), { recursive: true });
  await writeFile(join(folder, "notes", "a.md"), "a");
  await writeFile(outside, "s");
  try {
    // not fenced (plain `hawl join`): relative from the folder, absolute as given
    assert.equal(
      await uploadPath("notes/a.md", folder, false),
      join(folder, "notes", "a.md"),
    );
    assert.equal(await uploadPath(outside, folder, false), outside);
    // fenced: inside is fine, a missing file inside is left to "file not found"
    assert.equal(
      await uploadPath("notes/a.md", folder, true),
      join(folder, "notes", "a.md"),
    );
    assert.equal(
      await uploadPath("notes/new.md", folder, true),
      join(folder, "notes", "new.md"),
    );
    const refused = {
      message:
        "That file is outside this folder, so it was not sent. Only files inside the connected folder can be sent.",
    };
    await assert.rejects(uploadPath(outside, folder, true), refused);
    await assert.rejects(uploadPath("../secret.txt", folder, true), refused);
    await assert.rejects(uploadPath("../nope.txt", folder, true), refused);
    // a link inside the folder that points outside
    await symlink(root, join(folder, "up"), "junction");
    await assert.rejects(uploadPath("up/secret.txt", folder, true), refused);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
