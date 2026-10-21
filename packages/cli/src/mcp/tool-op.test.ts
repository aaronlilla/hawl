import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { test } from "node:test";
import type { ClientRequest } from "@hawl/protocol/src/envelope.ts";
import { b64url } from "@hawl/protocol/src/hash.ts";
import { newId } from "@hawl/protocol/src/ids.ts";
import { readySignInput, signEs256 } from "@hawl/protocol/src/sign.ts";
import { WebSocketServer } from "ws";
import { generateWorkerKey, MemoryKeyStore } from "../daemon/keys.ts";
import { startDaemon } from "../daemon/main.ts";
import { ManifestStore } from "../daemon/manifest.ts";
import {
  makeRelayKey,
  makeRoot,
  manifestPayload,
  signManifest,
  tmpState,
} from "../daemon/testkit.ts";
import { daemonLink, send } from "./server.ts";

const T = "2026-10-10T14:00:00Z";

test("tool op: the real daemon forwards a proxied MCP tool as tool.call over the worker WS", async () => {
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
        ws.send(
          JSON.stringify(
            f.name === "who"
              ? { t: "tool.result", id: f.id, result: { workers: [] } }
              : {
                  t: "tool.result",
                  id: f.id,
                  error: {
                    code: "rate_limited",
                    message: "slow down",
                    request_id: "req_01926f3a-0000-7000-8000-000000000001",
                    retry_after: null,
                  },
                },
          ),
        );
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  const d = await startDaemon({ stateDir, keyStore, manifests, otlpPort: 0 });
  try {
    await d.attach({
      relay_url: `http://127.0.0.1:${port}`,
      resident_id: resident,
      platform: "codex",
    });
    const link = daemonLink(stateDir);
    const until = Date.now() + 3000;
    let res: unknown;
    for (;;) {
      try {
        res = await link.call("tool", {
          resident_id: resident,
          name: "who",
          args: {},
        });
        break;
      } catch (e) {
        if (Date.now() > until) throw e;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.deepEqual(res, { workers: [] });
    assert.equal(calls[0]?.name, "who");
    await assert.rejects(
      link.call("tool", {
        resident_id: resident,
        name: "board_read",
        args: {},
      }),
      /slow down/,
    );
  } finally {
    await d.stop();
    wss.close();
  }
});

test("resolve op: dm_send runs through the real daemon and the relay sees a signed msg.send", async () => {
  const root = makeRoot();
  const relay = makeRelayKey();
  const stateDir = tmpState();
  const manifests = new ManifestStore(stateDir, root.roots, () =>
    Date.parse(T),
  );
  manifests.accept(signManifest(root, manifestPayload(relay.jwk)));
  const resident = newId("res");
  const bob = newId("res");
  const dispatcher = newId("res");
  const keyStore = new MemoryKeyStore();
  await keyStore.set(resident, generateWorkerKey().privateJwk);
  const signer = generateKeyPairSync("ed25519");

  const sent: Record<string, unknown>[] = [];
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
      } else if (f.t === "tool.call" && f.name === "who") {
        ws.send(
          JSON.stringify({
            t: "tool.result",
            id: f.id,
            result: {
              // `who` returns handles with the @ a tool call wants.
              workers: [
                { handle: "@bob", resident_id: bob },
                { handle: "@dispatcher", resident_id: dispatcher },
              ],
            },
          }),
        );
      } else if (f.t === "msg.send") {
        sent.push(f);
        ws.send(
          JSON.stringify({
            t: "msg.accepted",
            id: f.id,
            message_id: newId("msg"),
            state: "queued",
            limits: { send_per_min: 30, max_body_bytes: 65536 },
          }),
        );
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  const d = await startDaemon({ stateDir, keyStore, manifests, otlpPort: 0 });
  try {
    await d.attach({
      relay_url: `http://127.0.0.1:${port}`,
      resident_id: resident,
      platform: "codex",
    });
    const link = daemonLink(stateDir);
    const until = Date.now() + 3000;
    const deps = {
      daemon: link,
      residentId: resident,
      signer: { kid: "key_t", privateKey: signer.privateKey },
    };
    for (;;) {
      try {
        await send(deps, "dm_send", { to: "@bob", text: "hi" });
        break;
      } catch (e) {
        if (Date.now() > until) throw e;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.equal(sent.length, 1);
    // The msg.send frame carries the client_request object; the relay re-canonicalizes it.
    const cr = sent[0]?.client_request as ClientRequest;
    assert.deepEqual(cr.to, { kind: "worker", resident_id: bob });
    // A handle without the @ finds the same worker.
    await send(deps, "dm_send", { to: "bob", text: "again" });
    assert.deepEqual((sent[1]?.client_request as ClientRequest).to, {
      kind: "worker",
      resident_id: bob,
    });
    // ask_town addresses the site's Dispatcher.
    const r = (await link.call("resolve", {
      resident_id: resident,
      tool: "ask_town",
      args: { text: "route this" },
    })) as { to: unknown };
    assert.deepEqual(r.to, { kind: "worker", resident_id: dispatcher });
  } finally {
    await d.stop();
    wss.close();
  }
});
