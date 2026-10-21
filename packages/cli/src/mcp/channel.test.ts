import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { newId } from "@hawl/protocol/src/ids.ts";
import { generateWorkerKey, MemoryKeyStore } from "../daemon/keys.ts";
import { startDaemon } from "../daemon/main.ts";
import { ManifestStore } from "../daemon/manifest.ts";
import { Spool } from "../daemon/spool.ts";
import {
  makeEnvelope,
  makeRelayKey,
  makeRoot,
  tmpState,
} from "../daemon/testkit.ts";
import { formatNotice } from "../hook/notice.ts";
import { addWorker, newTownFile, writeTownFile } from "../town-file.ts";
import { WakeGate } from "../wake/gate.ts";
import { CHANNEL_METHOD, channelNotification, channelTick } from "./channel.ts";

const SERVER = fileURLToPath(new URL("./server.ts", import.meta.url));

function joinedFolder(rid: string, wake?: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "hawl-chan-"));
  const t = newTownFile("app");
  addWorker(
    t,
    { town_id: "twn_1", town_slug: "acme", relay_url: "http://127.0.0.1:9" },
    { resident_id: rid, platform: "claude_code", kid: "key_1" },
  );
  if (wake !== undefined) t.wake = wake;
  writeTownFile(dir, t);
  return dir;
}

test("channel notification carries the fixed notice only, no meta", () => {
  const n = channelNotification(2);
  assert.deepEqual(n, {
    method: CHANNEL_METHOD,
    params: { content: formatNotice(2) },
  });
  assert.equal(channelNotification(0), null);
  assert.equal(channelNotification("3" as never), null);
});

test("channelTick: wakes on aimed mail, respects the folder switch and busy agents", async () => {
  const sent: unknown[] = [];
  const mk = (cwd: string, r: unknown) => ({
    cwd,
    notice: async () => r,
    send: async (n: unknown) => void sent.push(n),
    now: () => 0,
  });
  const on = joinedFolder("res_A");
  assert.equal(
    await channelTick(mk(on, { aimed: 1, quiet_ms: null }), new WakeGate()),
    true,
  );
  assert.equal(
    await channelTick(
      mk(joinedFolder("res_A", false), { aimed: 1, quiet_ms: null }),
      new WakeGate(),
    ),
    false,
    "hawl config wake off",
  );
  assert.equal(
    await channelTick(mk(on, { aimed: 1, quiet_ms: 200 }), new WakeGate()),
    false,
    "busy",
  );
  assert.equal(
    await channelTick(
      mk(mkdtempSync(join(tmpdir(), "hawl-nojoin-")), { aimed: 1 }),
      new WakeGate(),
    ),
    false,
    "not joined",
  );
  assert.deepEqual(sent, [
    { method: CHANNEL_METHOD, params: { content: formatNotice(1) } },
  ]);
});

test("stdio: Claude Code server declares the channel and pushes the notice for aimed mail", async () => {
  const stateDir = tmpState();
  process.env.HAWL_HOME = stateDir;
  const resident = newId("res");
  const keyStore = new MemoryKeyStore();
  await keyStore.set(resident, generateWorkerKey().privateJwk);
  const d = await startDaemon({
    stateDir,
    keyStore,
    manifests: new ManifestStore(stateDir, makeRoot().roots),
    idleWakeSweepMs: 0,
    codexQueue: async () => false,
  });
  await d.attach({
    relay_url: "http://127.0.0.1:9",
    resident_id: resident,
    platform: "claude_code",
  });
  const secret = "SECRET BODY do not leak";
  const relayKey = makeRelayKey().privateKey;
  const spool = new Spool(join(stateDir, "spool"), resident);
  // A room broadcast that does not name the agent: not aimed, no wake.
  spool.put(
    makeEnvelope(relayKey, resident, {
      seq: 1,
      text: secret,
      to: { kind: "channel", channel_id: "chn_1", mentions: [] },
    }).env,
  );
  const cwd = joinedFolder(resident);

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      HAWL_HOME: stateDir,
      HAWL_RESIDENT_ID: resident,
      HAWL_MCP_HOST: "claude_code",
      HAWL_MCP_CWD: cwd,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const msgs: Record<string, any>[] = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c: string) => {
    buf += c;
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (line) msgs.push(JSON.parse(line));
    }
  });
  const write = (m: unknown) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...(m as {}) })}\n`);
  const waitFor = async (pred: (m: any) => boolean, ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  };
  try {
    // A 2026-era probe must not pin the modern revision (Claude Code would skip the channel).
    write({ id: 1, method: "server/discover", params: {} });
    const probe = await waitFor((m) => m.id === 1, 5000);
    assert.ok(probe?.error, `discover must fail: ${JSON.stringify(probe)}`);

    write({
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    const init = await waitFor((m) => m.id === 2, 5000);
    const caps = init?.result?.capabilities;
    assert.deepEqual(caps?.experimental, { "claude/channel": {} });
    assert.ok(caps?.tools, "tools still served");
    assert.match(
      init.result.instructions,
      /<channel> tags from the hawl server/,
    );
    write({ method: "notifications/initialized" });

    // Broadcast only: no wake within a few polls.
    await new Promise((r) => setTimeout(r, 4000));
    assert.equal(
      msgs.filter((m) => m.method === CHANNEL_METHOD).length,
      0,
      "a broadcast never wakes",
    );

    spool.put(makeEnvelope(relayKey, resident, { seq: 2, text: secret }).env);
    const n = await waitFor((m) => m.method === CHANNEL_METHOD, 8000);
    assert.ok(n, "aimed DM wakes the session");
    assert.deepEqual(n.params, { content: formatNotice(1) });
    assert.ok(!JSON.stringify(msgs).includes(secret), "no body on the wire");
  } finally {
    child.kill();
    await d.stop();
  }
});
