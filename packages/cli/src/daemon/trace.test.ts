import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { b64url } from "@hawl/protocol/src/hash.ts";
import { newId } from "@hawl/protocol/src/ids.ts";
import { readySignInput, signEs256 } from "@hawl/protocol/src/sign.ts";
import { WebSocketServer } from "ws";
import { daemonLink } from "../mcp/server.ts";
import { generateWorkerKey, MemoryKeyStore } from "./keys.ts";
import { startDaemon } from "./main.ts";
import { ManifestStore } from "./manifest.ts";
import {
  makeRelayKey,
  makeRoot,
  manifestPayload,
  signManifest,
  tmpState,
} from "./testkit.ts";

const T = "2026-10-10T14:00:00Z";

/** A daemon attached to a stub relay that answers every tool.call and records the frames. */
async function fixture() {
  const root = makeRoot();
  const relay = makeRelayKey();
  const stateDir = tmpState();
  const manifests = new ManifestStore(stateDir, root.roots, () =>
    Date.parse(T),
  );
  manifests.accept(signManifest(root, manifestPayload(relay.jwk)));
  const resident = newId("res");
  const keyStore = new MemoryKeyStore();
  await keyStore.set(resident, generateWorkerKey().privateJwk);

  const calls: Record<string, unknown>[] = [];
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", r));
  wss.on("connection", (ws) => {
    const nonce = b64url(randomBytes(32));
    ws.send(
      JSON.stringify({
        t: "hello",
        nonce,
        server_time: T,
        relay_kid: "rk_2026q4",
        protocol: 1,
      }),
    );
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.t === "auth") {
        const session_id = newId("ses");
        const sig = signEs256(
          relay.privateKey,
          readySignInput({
            nonce,
            client_nonce: f.client_nonce,
            resident_id: resident,
            session_id,
            server_time: T,
          }),
        );
        ws.send(
          JSON.stringify({
            t: "ready",
            session_id,
            resident_id: resident,
            relay_sig: b64url(sig),
          }),
        );
      } else if (f.t === "tool.call") {
        calls.push(f);
        ws.send(JSON.stringify({ t: "tool.result", id: f.id, result: {} }));
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  const d = await startDaemon({ stateDir, keyStore, manifests, otlpPort: 0 });
  await d.attach({
    relay_url: `http://127.0.0.1:${port}`,
    resident_id: resident,
    platform: "claude_code",
  });
  const link = daemonLink(stateDir);
  const call = async (extra: Record<string, unknown>) => {
    const until = Date.now() + 3000;
    for (;;) {
      try {
        return await link.call("tool", {
          resident_id: resident,
          name: "who",
          args: {},
          ...extra,
        });
      } catch (e) {
        if (Date.now() > until) throw e;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  };
  return {
    calls,
    call,
    stateDir,
    stop: async () => {
      await d.stop();
      wss.close();
    },
  };
}

test("the daemon copies a request's trace onto the tool.call frame and into its log line, and never makes one up", async () => {
  const f = await fixture();
  const traceId = "c".repeat(32);
  const trace = { "sentry-trace": `${traceId}-${"d".repeat(16)}-1` };
  try {
    await f.call({ trace });
    await f.call({});
    await f.call({ trace: { "sentry-trace": "junk" } });
  } finally {
    await f.stop();
  }
  assert.deepEqual(f.calls[0]?.trace, trace);
  assert.equal(f.calls[1]?.trace, undefined);
  assert.equal(f.calls[2]?.trace, undefined);
  const log = readFileSync(join(f.stateDir, "logs", "daemon.log"), "utf8");
  assert.ok(log.includes(`"trace_id":"${traceId}"`));
});

// The shim only forwards the caller's traceparent; the helper turns it into the relay trace or
// mints one (the shim has no trace logic, so a fix to it reaches open sessions).
test("a thin-shim tool call: the helper puts the caller's traceparent, or a minted trace, on the frame and in its log", async () => {
  const f = await fixture();
  const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  try {
    await f.call({ shim_contract: 1, traceparent: tp });
    await f.call({ shim_contract: 1 });
    await f.call({ shim_contract: 1 });
  } finally {
    await f.stop();
  }
  const traces = f.calls.map(
    (c) => (c.trace as { "sentry-trace": string })["sentry-trace"],
  );
  assert.equal(
    traces[0],
    "0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-1",
  );
  for (const t of traces.slice(1))
    assert.match(t, /^[0-9a-f]{32}-[0-9a-f]{16}-1$/);
  assert.notEqual(traces[1], traces[2]);
  const log = readFileSync(join(f.stateDir, "logs", "daemon.log"), "utf8");
  assert.ok(log.includes('"trace_id":"0af7651916cd43dd8448eb211c80319c"'));
});

// A tool call from a thin shim must always come back, with or without a traceparent: the trace is
// only a label, never something a call can wait on.
test("a thin-shim tool call through the daemon link resolves, with and without traceparent", async () => {
  const f = await fixture();
  const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const within3s = <T>(p: Promise<T>) =>
    Promise.race([
      p,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("tool call did not resolve")), 3000),
      ),
    ]);
  try {
    for (const extra of [{}, { traceparent: tp }, { traceparent: "junk" }]) {
      const r = (await within3s(f.call({ shim_contract: 1, ...extra }))) as {
        isError?: boolean;
        content: { text: string }[];
      };
      assert.ok(!r.isError, JSON.stringify(r));
    }
  } finally {
    await f.stop();
  }
});
