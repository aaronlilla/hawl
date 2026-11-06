import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { newId } from "@hawl/protocol/src/ids.ts";
import {
  generateWorkerKey,
  keyAgeDir,
  keyIsFresh,
  MemoryKeyStore,
  openKeyStore,
  pruneKeys,
} from "./keys.ts";
import { startDaemon } from "./main.ts";
import { ManifestStore } from "./manifest.ts";
import {
  forgetSessionAgentsOf,
  rememberSessionAgent,
} from "./session-agents.ts";
import { makeRoot, tmpState } from "./testkit.ts";

const RELAY = "http://127.0.0.1:9";
const agent = (n: number, parent = "res_parent") => ({
  resident_id: `res_a${n}`,
  parent_id: parent,
  relay_url: RELAY,
  platform: "claude_code",
  session_key: `k${n}`,
  handle: `h${n}`,
  display_name: `H${n}`,
});

test("pushing a session agent out of the list (cap 200) reports its id so its key can go", () => {
  const dir = tmpState();
  let dropped: string[] = [];
  for (let i = 0; i < 202; i++)
    dropped = dropped.concat(rememberSessionAgent(dir, agent(i)));
  assert.deepEqual(dropped, ["res_a0", "res_a1"]);
});

test("forgetting a folder's session agents reports their ids", () => {
  const dir = tmpState();
  rememberSessionAgent(dir, agent(1));
  rememberSessionAgent(dir, agent(2, "res_other"));
  assert.deepEqual(forgetSessionAgentsOf(dir, "res_parent"), ["res_a1"]);
});

test("pruneKeys deletes res_ keys not in keep, never the kept or foreign ones", async () => {
  const s = new MemoryKeyStore();
  for (const a of ["res_live", "res_stale", "other"])
    await s.set(a, generateWorkerKey().privateJwk);
  assert.deepEqual(await pruneKeys(s, () => new Set(["res_live"])), [
    "res_stale",
  ]);
  assert.deepEqual((await s.list()).sort(), ["other", "res_live"]);
});

test("the daemon prunes stale keys at startup when asked", async () => {
  const stateDir = tmpState();
  const keyStore = new MemoryKeyStore();
  const live = newId("res");
  const stale = newId("res");
  await keyStore.set(live, generateWorkerKey().privateJwk);
  await keyStore.set(stale, generateWorkerKey().privateJwk);
  writeFileSync(
    join(stateDir, "workers.json"),
    JSON.stringify({
      v: 1,
      workers: [
        { relay_url: RELAY, resident_id: live, platform: "claude_code" },
      ],
    }),
  );
  const d = await startDaemon({
    stateDir,
    keyStore,
    manifests: new ManifestStore(stateDir, makeRoot().roots),
    fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch,
    idleWakeSweepMs: 0,
    pruneStaleKeys: true,
    pruneDelayMs: 0,
  });
  try {
    for (let i = 0; i < 50 && (await keyStore.get(stale)); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(await keyStore.get(stale), null);
    assert.ok(await keyStore.get(live));
  } finally {
    await d.stop();
  }
});

test("a key whose record lands mid-prune survives (keep is re-read before each delete)", async () => {
  const s = new MemoryKeyStore();
  for (const a of ["res_a", "res_b"])
    await s.set(a, generateWorkerKey().privateJwk);
  const records = new Set<string>();
  const del = s.delete.bind(s);
  // A join saves res_b's record while res_a is being deleted.
  s.delete = async (a) => {
    await del(a);
    records.add("res_b");
  };
  assert.deepEqual(await pruneKeys(s, () => new Set(records)), ["res_a"]);
  assert.ok(await s.get("res_b"));
});

test("a key written in the last 10 minutes is never pruned, an old one is", async () => {
  const stateDir = tmpState();
  const store = await openKeyStore({
    stateDir,
    fileOnly: true,
    passphrase: "x",
  });
  await store.set("res_new", generateWorkerKey().privateJwk);
  await store.set("res_old", generateWorkerKey().privateJwk);
  const old = new Date(Date.now() - 11 * 60_000);
  utimesSync(join(keyAgeDir(stateDir), "res_old"), old, old);
  const gone = await pruneKeys(
    store,
    () => new Set(),
    (a) => keyIsFresh(stateDir, a),
  );
  assert.deepEqual(gone, ["res_old"]);
  assert.ok(await store.get("res_new"));
});
