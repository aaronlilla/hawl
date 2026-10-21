import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Spool } from "./spool.ts";
import { makeEnvelope, makeRelayKey, tmpState } from "./testkit.ts";

const me = "res_01928f3e-7a10-7c3b-8a55-1f2e3d4c5b6a";

test("put is durable, ordered by inbox_seq, deduped, and tracks read state", () => {
  const dir = tmpState();
  const relay = makeRelayKey();
  const s = new Spool(dir, me);
  const e2 = makeEnvelope(relay.privateKey, me, { seq: 2 }).env;
  const e1 = makeEnvelope(relay.privateKey, me, { seq: 1 }).env;
  s.put(e2);
  s.put(e1);
  s.put(e1);
  assert.deepEqual(
    s.list().map((e) => e.relay.delivery.inbox_seq),
    [1, 2],
  );
  assert.equal(s.lastSeq(), 2);
  assert.equal(s.has(e1.relay.message_id), true);
  s.markRead([e1.relay.message_id]);
  assert.deepEqual(
    s.unread().map((e) => e.relay.message_id),
    [e2.relay.message_id],
  );
  s.remove(e2.relay.message_id);
  assert.equal(s.lastSeq(), 2, "cursor outlives removed messages");
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, me)).mode & 0o777, 0o700);
  }
});

test("spool survives a kill: every put is readable, the torn temp file is ignored and cleaned", () => {
  const dir = tmpState();
  const relay = makeRelayKey();
  const envs = [1, 2, 3].map(
    (seq) => makeEnvelope(relay.privateKey, me, { seq }).env,
  );
  const input = join(dir, "in.json");
  writeFileSync(input, JSON.stringify(envs));
  const fixture = fileURLToPath(new URL("./spool.fixture.ts", import.meta.url));
  const r = spawnSync(
    process.execPath,
    [fixture, join(dir, "spool"), me, input],
    {
      encoding: "utf8",
    },
  );
  assert.notEqual(r.status, 0, "child must have died, not exited cleanly");
  assert.ok(existsSync(join(dir, "spool", me, ".tmp-deadbeef")));

  const s = new Spool(join(dir, "spool"), me);
  assert.deepEqual(
    s.list().map((e) => e.relay.message_id),
    envs.map((e) => e.relay.message_id),
  );
  assert.equal(s.lastSeq(), 3);
  assert.equal(
    readdirSync(join(dir, "spool", me)).some((f) => f.startsWith(".tmp-")),
    false,
  );
});

test("a corrupt spool file is skipped, not delivered", () => {
  const dir = tmpState();
  const relay = makeRelayKey();
  const s = new Spool(dir, me);
  s.put(makeEnvelope(relay.privateKey, me, { seq: 1 }).env);
  writeFileSync(
    join(dir, me, `${String(2).padStart(12, "0")}-msg_bad.json`),
    "{nope",
  );
  assert.equal(s.list().length, 1);
});

test("rejects a path-like resident id", () => {
  assert.throws(() => new Spool(tmpState(), "../evil"));
});
