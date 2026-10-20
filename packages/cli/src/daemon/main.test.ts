import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { newId } from "@hawl/protocol/src/ids.ts";
import { generateWorkerKey, MemoryKeyStore } from "./keys.ts";
import {
  DaemonRunningError,
  settleFilePut,
  startDaemon,
  unreadCount,
  ExcessClock,
  NOTICE_EXCESS_GRACE_MS,
} from "./main.ts";
import { ManifestStore } from "./manifest.ts";
import { readToken, request, socketPath as socketPathFor } from "./socket.ts";
import { Spool } from "./spool.ts";
import { makeEnvelope, makeRelayKey, makeRoot, tmpState } from "./testkit.ts";
import { readWorkers } from "./workers.ts";

test("local socket demands the token and serves notice, mailbox and status from the spool", async () => {
  const stateDir = tmpState();
  const root = makeRoot();
  const resident = newId("res");
  const keyStore = new MemoryKeyStore();
  await keyStore.set(resident, generateWorkerKey().privateJwk);
  const relay = makeRelayKey();
  const d = await startDaemon({
    stateDir,
    keyStore,
    manifests: new ManifestStore(stateDir, root.roots),
    // no reachable relay: the worker stays "connecting", the spool still answers
    workers: [],
  });
  try {
    const noToken = await request(d.socketPath, { op: "status" });
    assert.deepEqual(noToken, { ok: false, error: "unauthorized" });
    const wrong = await request(d.socketPath, { op: "status", token: "nope" });
    assert.equal(wrong.ok, false);

    // attach with an unreachable relay, then put a verified message in its spool
    await request(d.socketPath, {
      op: "attach",
      token: d.token,
      worker: {
        relay_url: "http://127.0.0.1:9",
        resident_id: resident,
        platform: "codex",
      },
    });
    const env = makeEnvelope(relay.privateKey, resident, { seq: 1 }).env;
    new Spool(join(stateDir, "spool"), resident).put(env);

    const n = await request(d.socketPath, {
      op: "notice",
      token: d.token,
      resident_id: resident,
    });
    assert.deepEqual(n, {
      ok: true,
      result: { unread: 1, needs_action: 0, aimed: 1, quiet_ms: null },
    });

    const mb = await request(d.socketPath, {
      op: "mailbox",
      token: d.token,
      resident_id: resident,
    });
    assert.equal(
      mb.ok && (mb.result as { envelopes: unknown[] }).envelopes.length,
      1,
    );

    await request(d.socketPath, {
      op: "mark_read",
      token: d.token,
      resident_id: resident,
      message_ids: [env.relay.message_id],
    });
    const n2 = await request(d.socketPath, {
      op: "notice",
      token: d.token,
      resident_id: resident,
    });
    assert.deepEqual(n2.ok && n2.result, {
      unread: 0,
      needs_action: 0,
      aimed: 0,
      quiet_ms: null,
    });

    const st = await request(d.socketPath, { op: "status", token: d.token });
    assert.equal(
      st.ok && (st.result as { workers: unknown[] }).workers.length,
      1,
    );
    assert.equal(
      st.ok && (st.result as { key_store: string }).key_store,
      "memory",
    );

    const bad = await request(d.socketPath, {
      op: "mailbox",
      token: d.token,
      resident_id: "res_unknown",
    });
    assert.equal(bad.ok, false);
  } finally {
    await d.stop();
  }
});

test("attach without a stored key is refused", async () => {
  const stateDir = tmpState();
  const d = await startDaemon({
    stateDir,
    keyStore: new MemoryKeyStore(),
    manifests: new ManifestStore(stateDir, makeRoot().roots),
  });
  try {
    const r = await request(d.socketPath, {
      op: "attach",
      token: d.token,
      worker: {
        relay_url: "http://127.0.0.1:9",
        resident_id: newId("res"),
        platform: "codex",
      },
    });
    assert.equal(r.ok, false);
  } finally {
    await d.stop();
  }
});

test("workers are remembered and reattached when the daemon starts again", async () => {
  const stateDir = tmpState();
  const keyStore = new MemoryKeyStore();
  const resident = newId("res");
  await keyStore.set(resident, generateWorkerKey().privateJwk);
  const worker = {
    relay_url: "http://127.0.0.1:9",
    resident_id: resident,
    platform: "codex",
  };
  const manifests = new ManifestStore(stateDir, makeRoot().roots);
  const d1 = await startDaemon({ stateDir, keyStore, manifests });
  await request(d1.socketPath, { op: "attach", token: d1.token, worker });
  await d1.stop();
  assert.deepEqual(readWorkers(stateDir), [worker]);

  // A login or crash restart: nobody calls attach, the worker comes back by itself.
  const d2 = await startDaemon({ stateDir, keyStore, manifests });
  try {
    const st = await request(d2.socketPath, { op: "status", token: d2.token });
    const ws =
      (st.ok &&
        (st.result as { workers: { resident_id: string }[] }).workers) ||
      [];
    assert.deepEqual(
      ws.map((w) => w.resident_id),
      [resident],
    );
    // Leaving forgets it.
    await request(d2.socketPath, {
      op: "detach",
      token: d2.token,
      resident_id: resident,
      destroy_spool: true,
    });
    assert.deepEqual(readWorkers(stateDir), []);
  } finally {
    await d2.stop();
  }
});

test("a remembered worker whose key is gone is reported, not fatal", async () => {
  const stateDir = tmpState();
  const keyStore = new MemoryKeyStore();
  const manifests = new ManifestStore(stateDir, makeRoot().roots);
  const { rememberWorker } = await import("./workers.ts");
  rememberWorker(stateDir, {
    relay_url: "http://127.0.0.1:9",
    resident_id: "res_gone",
    platform: "codex",
  });
  const d = await startDaemon({ stateDir, keyStore, manifests });
  try {
    const st = await request(d.socketPath, { op: "status", token: d.token });
    const r = st.ok ? (st.result as { attach_failed: string[] }) : null;
    assert.equal(r?.attach_failed.length, 1);
  } finally {
    await d.stop();
  }
});

test("a second daemon refuses to start and leaves the first one's token alone", async () => {
  const stateDir = tmpState();
  const opts = {
    stateDir,
    keyStore: new MemoryKeyStore(),
    manifests: new ManifestStore(stateDir, makeRoot().roots),
  };
  const d = await startDaemon(opts);
  try {
    await assert.rejects(startDaemon(opts), DaemonRunningError);
    assert.equal(readToken(stateDir), d.token);
    const st = await request(d.socketPath, { op: "status", token: d.token });
    assert.equal(st.ok, true);
  } finally {
    await d.stop();
  }
});

test("shutdown stops the daemon cleanly so the socket is free for the next start", async () => {
  const stateDir = tmpState();
  let done!: () => void;
  const stopped = new Promise<void>((r) => {
    done = r;
  });
  const d = await startDaemon({
    stateDir,
    keyStore: new MemoryKeyStore(),
    manifests: new ManifestStore(stateDir, makeRoot().roots),
    workers: [],
    otlpPort: 0,
    onShutdown: done,
  });
  const r = await request(d.socketPath, { op: "shutdown", token: d.token });
  assert.deepEqual(r, { ok: true, result: { stopping: true } });
  await stopped;
  const again = await startDaemon({
    stateDir,
    keyStore: new MemoryKeyStore(),
    manifests: new ManifestStore(stateDir, makeRoot().roots),
    workers: [],
    otlpPort: 0,
  });
  await again.stop();
});

test("hook and MCP sessions are listed per host and folder, and survive a restart", async () => {
  const stateDir = tmpState();
  const keyStore = new MemoryKeyStore();
  const resident = newId("res");
  await keyStore.set(resident, generateWorkerKey().privateJwk);
  const manifests = new ManifestStore(stateDir, makeRoot().roots);
  const d = await startDaemon({ stateDir, keyStore, manifests });
  try {
    await request(d.socketPath, {
      op: "attach",
      token: d.token,
      worker: {
        relay_url: "http://127.0.0.1:9",
        resident_id: resident,
        platform: "claude_code",
      },
    });
    await request(d.socketPath, {
      op: "activity",
      token: d.token,
      resident_id: resident,
      root: "/w/app",
      line: { kind: "session_start", host: "claude_code", session_id: "s1" },
    });
    await request(d.socketPath, {
      op: "host_session",
      token: d.token,
      resident_id: resident,
      host_session_id: "m1",
      host: "claude_code",
      root: "/w/app",
    });
  } finally {
    await d.stop();
  }
  const d2 = await startDaemon({ stateDir, keyStore, manifests });
  try {
    const r = await request(d2.socketPath, { op: "sessions", token: d2.token });
    const list =
      (r.ok && (r.result as { sessions: Record<string, string>[] }).sessions) ||
      [];
    assert.deepEqual(
      list.map((s) => [s.host, s.via, s.root, s.resident_id]),
      [
        ["claude_code", "hook", "/w/app", resident],
        ["claude_code", "mcp", "/w/app", resident],
      ],
    );
  } finally {
    await d2.stop();
  }
});

test("unread count leaves out deliveries the daemon dropped", () => {
  const none = () => false;
  // relay says 2, both dropped, nothing spooled: nothing is waiting
  assert.equal(unreadCount(2, 0, new Set(["msg_a", "msg_b"]), none), 0);
  // one dropped, one real in the spool
  assert.equal(unreadCount(2, 1, new Set(["msg_a"]), none), 1);
  // a dropped id that was later spooled is not subtracted
  assert.equal(
    unreadCount(1, 1, new Set(["msg_a"]), (id) => id === "msg_a"),
    1,
  );
  // no drops: unchanged
  assert.equal(unreadCount(3, 1, undefined, none), 3);
});

test("a relay count the spool never catches up with stops being announced", () => {
  const none = () => false;
  // relay says 1, spool empty: in flight at first
  assert.equal(unreadCount(1, 0, undefined, none, 0), 1);
  assert.equal(unreadCount(1, 0, undefined, none, NOTICE_EXCESS_GRACE_MS), 1);
  // still 1 past the grace: nothing the mailbox can return, so nothing waits
  assert.equal(
    unreadCount(1, 0, undefined, none, NOTICE_EXCESS_GRACE_MS + 1),
    0,
  );
  // real spooled mail still counts
  assert.equal(
    unreadCount(2, 1, undefined, none, NOTICE_EXCESS_GRACE_MS + 1),
    1,
  );
  const c = new ExcessClock();
  assert.equal(c.age("w", 1, 1000), 0);
  assert.equal(c.age("w", 1, 31_000), 30_000);
  assert.equal(c.age("w", 2, 32_000), 0, "a changed excess starts over");
  assert.equal(c.age("w", 0, 40_000), 0);
  assert.equal(c.age("w", 1, 41_000), 0, "cleared excess starts over");
});

test("file_put waits for the scan and returns the final state with the reason", async () => {
  const answers = [
    { file_id: "fil_1", state: "gate_check" },
    { file_id: "fil_1", state: "gate_check" },
    { file_id: "fil_1", state: "blocked", reason: "invalid_utf8" },
  ];
  let calls = 0;
  const out = await settleFilePut(
    async () => answers[Math.min(calls++, answers.length - 1)],
    10_000,
    1_000,
    async () => {},
  );
  assert.deepEqual(out, answers[2]);
  assert.equal(calls, 3);
  // a scan that never finishes gives up with gate_check, it does not hang
  let n = 0;
  const stuck = await settleFilePut(
    async () => {
      n++;
      return { file_id: "fil_2", state: "gate_check" };
    },
    3_000,
    1_000,
    async () => {},
  );
  assert.equal((stuck as { state: string }).state, "gate_check");
  assert.equal(n, 4);
});

test("a call that arrives while the remembered workers are still reattaching waits for them", async () => {
  // Restart after a crash: the socket answers `status` before the keychain has been read. A tool
  // call in that window used to fail with "unknown worker" (found by the daemon-kill drill).
  const stateDir = tmpState();
  const resident = newId("res");
  class SlowKeys extends MemoryKeyStore {
    override async get(a: string) {
      await new Promise((r) => setTimeout(r, 600));
      return super.get(a);
    }
  }
  const keyStore = new SlowKeys();
  await keyStore.set(resident, generateWorkerKey().privateJwk);
  const { rememberWorker } = await import("./workers.ts");
  rememberWorker(stateDir, {
    relay_url: "http://127.0.0.1:9",
    resident_id: resident,
    platform: "codex",
  });
  const starting = startDaemon({
    stateDir,
    keyStore,
    manifests: new ManifestStore(stateDir, makeRoot().roots),
  });
  let token: string | null = null;
  for (let i = 0; i < 100 && !token; i++) {
    token = readToken(stateDir);
    if (!token) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(token, "the daemon wrote its token");
  const d = await (async () => {
    const mb = await request(socketPathFor(stateDir), {
      op: "mailbox",
      token: token as string,
      resident_id: resident,
    });
    assert.equal(mb.ok, true, JSON.stringify(mb));
    return starting;
  })();
  await d.stop();
});
