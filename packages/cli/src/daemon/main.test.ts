import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { newId } from "@hawl/protocol/src/ids.ts";
import { generateWorkerKey, MemoryKeyStore } from "./keys.ts";
import { DaemonRunningError, startDaemon } from "./main.ts";
import { ManifestStore } from "./manifest.ts";
import { readToken, request } from "./socket.ts";
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
    assert.deepEqual(n, { ok: true, result: { unread: 1, needs_action: 0 } });

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
    assert.deepEqual(n2.ok && n2.result, { unread: 0, needs_action: 0 });

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
