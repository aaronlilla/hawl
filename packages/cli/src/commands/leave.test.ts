import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateWorkerKey, MemoryKeyStore } from "../daemon/keys.ts";
import {
  addWorker,
  newTownFile,
  readTownFile,
  writeTownFile,
} from "../town-file.ts";
import { joinLocal } from "./join-local.ts";
import { flushRevokes, leave, readRevokeQueue } from "./leave.ts";

test("leave reports each local worker once when two hosts share its handle", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "hawl-leave-local-"));
  const stateDir = mkdtempSync(join(tmpdir(), "hawl-leave-state-"));
  const first = await joinLocal({
    projectDir,
    dir: stateDir,
    handle: "@shared",
  });
  await joinLocal({
    projectDir,
    dir: stateDir,
    handle: "@shared",
    host: "codex",
  });
  const result = await leave({ projectDir }, { stateDir, print: () => {} });
  assert.deepEqual(result.left, [first.resident_id]);
  assert.equal(result.removed, 2);
});

const RELAY = "https://relay.test";
const RID = "wrk_01TEST";

async function world() {
  const root = mkdtempSync(join(tmpdir(), "hawl-leave-"));
  const projectDir = join(root, "app");
  const stateDir = join(root, "state");
  const home = join(root, "home");
  for (const d of [projectDir, stateDir, home])
    mkdirSync(d, { recursive: true });
  const key = generateWorkerKey();
  const keyStore = new MemoryKeyStore();
  await keyStore.set(RID, key.privateJwk);
  const town = newTownFile("app");
  addWorker(
    town,
    { town_id: "twn_01TEST", town_slug: "acme", relay_url: RELAY },
    { resident_id: RID, platform: "claude_code", kid: key.kid },
  );
  writeTownFile(projectDir, town);
  const lines: string[] = [];
  let online = false;
  const calls: string[] = [];
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (!online) throw new TypeError("fetch failed");
    if (url.endsWith("/v1/auth/token"))
      return new Response(JSON.stringify({ access_token: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const deps = {
    fetch: fetchFn,
    print: (l: string) => lines.push(l),
    stateDir,
    home,
    keyStore,
    daemon: () => ({
      async call(): Promise<unknown> {
        throw new Error("hawl daemon is not running");
      },
    }),
  };
  return {
    projectDir,
    stateDir,
    keyStore,
    deps,
    lines,
    calls,
    goOnline: () => {
      online = true;
    },
  };
}

test("leave offline: cleans up here and queues the revoke", async () => {
  const w = await world();
  const r = await leave({ projectDir: w.projectDir }, w.deps);
  assert.deepEqual(r.left, [RID]);
  assert.equal(readTownFile(w.projectDir), null);
  assert.equal(existsSync(join(w.projectDir, ".hawl")), false);
  const q = readRevokeQueue(w.stateDir);
  assert.equal(q.length, 1);
  assert.equal(q[0]?.resident_id, RID);
  // The queue file holds no key material.
  assert.equal(JSON.stringify(q).includes('"d"'), false);
  // The key stays until the relay has been told.
  assert.ok(await w.keyStore.get(RID));
  assert.match(
    w.lines.join("\n"),
    /Offline: removed everything on this machine/,
  );
});

test("queued revoke goes through once online, then the key is deleted", async () => {
  const w = await world();
  await leave({ projectDir: w.projectDir }, w.deps);
  assert.equal(await flushRevokes(w.deps), 0);
  assert.equal(readRevokeQueue(w.stateDir).length, 1);
  w.goOnline();
  assert.equal(await flushRevokes(w.deps), 1);
  assert.equal(readRevokeQueue(w.stateDir).length, 0);
  assert.equal(await w.keyStore.get(RID), null);
  assert.ok(
    w.calls.some((c) => c.startsWith(`DELETE ${RELAY}/v1/residents/me`)),
  );
});

test("leave online: revokes at once, nothing queued, key deleted", async () => {
  const w = await world();
  w.goOnline();
  await leave({ projectDir: w.projectDir }, w.deps);
  assert.equal(readRevokeQueue(w.stateDir).length, 0);
  assert.equal(await w.keyStore.get(RID), null);
});

test("a 5xx from the relay counts as offline", async () => {
  const w = await world();
  const deps = {
    ...w.deps,
    fetch: (async () =>
      new Response("bad gateway", { status: 502 })) as typeof fetch,
  };
  await leave({ projectDir: w.projectDir }, deps);
  assert.equal(readRevokeQueue(w.stateDir).length, 1);
});

test("last membership left offline: a later leave with no membership still flushes the revoke", async () => {
  const w = await world();
  await leave({ projectDir: w.projectDir }, w.deps);
  assert.equal(readTownFile(w.projectDir), null);
  assert.equal(readRevokeQueue(w.stateDir).length, 1);
  w.goOnline();
  await assert.rejects(
    leave({ projectDir: w.projectDir }, w.deps),
    /no hawl membership/,
  );
  assert.equal(readRevokeQueue(w.stateDir).length, 0);
  assert.equal(await w.keyStore.get(RID), null);
});
