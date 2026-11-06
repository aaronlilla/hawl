import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { b64url } from "@hawl/protocol/src/hash.ts";
import { newId } from "@hawl/protocol/src/ids.ts";
import { readySignInput, signEs256 } from "@hawl/protocol/src/sign.ts";
import { WebSocketServer } from "ws";
import { daemonLink } from "../mcp/server.ts";
import { readAck, recordAck } from "./handover.ts";
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
const HOV = "hov_01926f3a-0000-7000-8000-0000000000aa";

test("H18: recordAck keeps only a well-formed stored answer, never any text, and readAck reads it back", () => {
  const stateDir = tmpState();
  const rid = "res_01926f3a-0000-7000-8000-000000000001";
  const at = new Date("2026-10-21T10:00:00Z");
  for (const bad of [
    null,
    { state: "consumed", handover_id: HOV, revision: 1 },
    { state: "stored", handover_id: "res_x", revision: 1 },
    { state: "stored", handover_id: HOV, revision: 0 },
    { state: "stored", handover_id: HOV, revision: 1.5 },
    { state: "stored", handover_id: HOV },
  ])
    assert.equal(recordAck(stateDir, rid, bad, at), undefined);
  assert.equal(readAck(stateDir, rid), null);
  // A worker id that could leave the state folder is refused.
  assert.equal(
    recordAck(
      stateDir,
      "../../evil",
      { state: "stored", handover_id: HOV, revision: 1 },
      at,
    ),
    undefined,
  );
  const ack = recordAck(
    stateDir,
    rid,
    { state: "stored", handover_id: HOV, revision: 2, text: "EVIL TEXT" },
    at,
  );
  assert.deepEqual(ack, {
    handover_id: HOV,
    revision: 2,
    stored_at: "2026-10-21T10:00:00.000Z",
  });
  assert.deepEqual(readAck(stateDir, rid), ack);
  const raw = readFileSync(
    join(stateDir, "handover-acks", `${rid}.json`),
    "utf8",
  );
  assert.ok(!raw.includes("EVIL"));
});

test("H18: the helper records the relay's stored acknowledgement after a handover_put it forwarded, and nothing on a refusal", async () => {
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

  let refuse = false;
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
            refuse
              ? {
                  t: "tool.result",
                  id: f.id,
                  error: {
                    code: "policy_reject",
                    message: "stopped by the security scan",
                    request_id: "req_01926f3a-0000-7000-8000-000000000001",
                    retry_after: null,
                  },
                }
              : {
                  t: "tool.result",
                  id: f.id,
                  result: { handover_id: HOV, revision: 4, state: "stored" },
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
      platform: "claude_code",
    });
    const link = daemonLink(stateDir);
    const put = () =>
      link.call("tool", {
        resident_id: resident,
        name: "handover_put",
        args: { text: "SECRET-NOTES" },
      });
    const until = Date.now() + 3000;
    let res: unknown;
    for (;;) {
      try {
        res = await put();
        break;
      } catch (e) {
        if (Date.now() > until) throw e;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.deepEqual(res, { handover_id: HOV, revision: 4, state: "stored" });
    assert.equal(calls[0]?.name, "handover_put");
    const ack = readAck(stateDir, resident);
    assert.equal(ack?.handover_id, HOV);
    assert.equal(ack?.revision, 4);
    const dir = join(stateDir, "handover-acks");
    for (const f of readdirSync(dir))
      assert.ok(!readFileSync(join(dir, f), "utf8").includes("SECRET"));
    // A refused put leaves the last acknowledgement as it was.
    refuse = true;
    await assert.rejects(put(), /security scan/);
    assert.deepEqual(readAck(stateDir, resident), ack);
  } finally {
    await d.stop();
    wss.close();
  }
});
