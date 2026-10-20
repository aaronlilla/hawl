import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActivityForwarder,
  type ActivityLine,
  linesFromOtlp,
  ProcessPoller,
  sanitizeLine,
  startOtlpReceiver,
} from "../daemon/activity.ts";
import { MemoryKeyStore } from "../daemon/keys.ts";
import { startDaemon } from "../daemon/main.ts";
import { ManifestStore } from "../daemon/manifest.ts";
import { request, socketPath } from "../daemon/socket.ts";
import { makeRoot, tmpState } from "../daemon/testkit.ts";
import { hookOutput, shortTarget } from "./hook.ts";

/** 300 ms is the hook budget; shared CI runners get slack so load does not flake it. */
const BUDGET_MS = process.env.CI ? 1500 : 300;
/** The hook's own socket budget (250 ms) drops the line on a loaded runner; CI gets 1 s. */
const hookDeps = (stateDir: string) =>
  process.env.CI ? { stateDir, budgetMs: 1000 } : { stateDir };

async function daemon() {
  const stateDir = tmpState();
  const batches: ActivityLine[][] = [];
  const d = await startDaemon({
    stateDir,
    keyStore: new MemoryKeyStore(),
    manifests: new ManifestStore(stateDir, makeRoot().roots),
    otlpPort: 0,
    activitySink: (b) => {
      batches.push(b);
      return true;
    },
    listProcesses: async () => [],
  });
  return { d, stateDir, batches };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("separate state directories keep hook daemons isolated without HAWL_HOME", async (t) => {
  const previous = process.env.HAWL_HOME;
  delete process.env.HAWL_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.HAWL_HOME;
    else process.env.HAWL_HOME = previous;
  });
  const first = await daemon();
  t.after(() => first.d.stop());
  const second = await daemon();
  t.after(() => second.d.stop());
  assert.notEqual(socketPath(first.stateDir), socketPath(second.stateDir));
  await hookOutput(
    "claude_code",
    "PostToolUse",
    { session_id: "isolated", tool_name: "Edit" },
    hookDeps(second.stateDir),
  );
  await untilLines(second.batches, 1);
  assert.equal(second.batches.flat().length, 1);
  assert.equal(first.batches.flat().length, 0);
});

/** Waits for the forwarder (batches every 250 ms) to deliver n lines, up to 5 s on a loaded runner. */
async function untilLines(batches: ActivityLine[][], n: number) {
  const end = Date.now() + 5000;
  while (batches.flat().length < n && Date.now() < end) await wait(25);
  await wait(50); // a late extra line would still show up and fail the count
}

test("shortTarget: tool name target only, no args, no env, no content", () => {
  assert.equal(
    shortTarget({
      cwd: "/r",
      tool_input: { file_path: "/r/apps/web/x.tsx", new_string: "SECRET" },
    }),
    "apps/web/x.tsx",
  );
  assert.equal(
    shortTarget({ tool_input: { command: "TOKEN=abc pnpm test --filter x" } }),
    "pnpm",
  );
  assert.equal(
    shortTarget({ tool_input: { command: "echo hunter2" } }),
    "echo",
  );
  assert.equal(shortTarget({ tool_input: { prompt: "hello" } }), undefined);
});

test("hook sends a PostToolUse line to the daemon socket inside 300 ms and prints nothing", async () => {
  const { d, stateDir, batches } = await daemon();
  try {
    const t0 = Date.now();
    const out = await hookOutput(
      "claude_code",
      "PostToolUse",
      {
        session_id: "s1",
        cwd: "/r",
        tool_name: "Edit",
        tool_input: { file_path: "/r/a.ts", new_string: "SECRET" },
      },
      hookDeps(stateDir),
    );
    assert.ok(Date.now() - t0 < BUDGET_MS);
    assert.equal(out, "");
    await untilLines(batches, 1);
    const lines = batches.flat();
    assert.equal(lines.length, 1);
    assert.deepEqual(
      [lines[0]?.kind, lines[0]?.tool, lines[0]?.target, lines[0]?.session_id],
      ["tool_after", "Edit", "a.ts", "s1"],
    );
    assert.ok(!JSON.stringify(lines).includes("SECRET"));
  } finally {
    await d.stop();
  }
});

test("hook reports SubagentStart and SessionStart", async () => {
  const { d, stateDir, batches } = await daemon();
  try {
    await hookOutput(
      "claude_code",
      "SubagentStart",
      { session_id: "s1", agent_id: "a1", agent_type: "explore" },
      hookDeps(stateDir),
    );
    await hookOutput(
      "codex",
      "SessionStart",
      { session_id: "s1" },
      hookDeps(stateDir),
    );
    await untilLines(batches, 2);
    assert.deepEqual(
      batches.flat().map((l) => l.kind),
      ["subagent_start", "session_start"],
    );
    assert.equal(batches.flat()[0]?.agent_id, "a1");
  } finally {
    await d.stop();
  }
});

test("hook with no daemon still exits fast", async () => {
  const t0 = Date.now();
  const out = await hookOutput(
    "claude_code",
    "PreToolUse",
    { session_id: "s", tool_name: "Bash" },
    { stateDir: tmpState() },
  );
  assert.equal(out, "");
  assert.ok(Date.now() - t0 < BUDGET_MS);
});

test("daemon activity op rejects junk and whitelists fields", async () => {
  const { d, batches } = await daemon();
  try {
    const bad = await request(d.socketPath, {
      op: "activity",
      token: d.token,
      line: { kind: "nope" },
    });
    assert.equal(bad.ok, false);
    await request(d.socketPath, {
      op: "activity",
      token: d.token,
      line: { kind: "tool_before", tool: "Bash", prompt: "SECRET", body: "x" },
    });
    await untilLines(batches, 1);
    assert.equal(batches.flat().length, 1);
    assert.ok(!JSON.stringify(batches).includes("SECRET"));
  } finally {
    await d.stop();
  }
});

test("forwarder batches within 250 ms and keeps lines while the relay is down", async () => {
  const got: number[] = [];
  let up = false;
  const f = new ActivityForwarder({
    sink: (b) => {
      if (!up) return false;
      got.push(b.length);
      return true;
    },
    intervalMs: 50,
  });
  const l = sanitizeLine(
    { kind: "tool_before", tool: "x" },
    "hook",
  ) as ActivityLine;
  f.push(l);
  f.push(l);
  await wait(120);
  assert.equal(f.pending, 2);
  up = true;
  await wait(120);
  assert.deepEqual(got, [2]);
  f.stop();
});

test("OTLP receiver: loopback, JSON only, reads ids and names, never prompt text", async () => {
  const seen: ActivityLine[] = [];
  const r = await startOtlpReceiver((l) => seen.push(...l), 0);
  try {
    const body = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "claude-code" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: "session.id", value: { stringValue: "s9" } },
                    { key: "tool_name", value: { stringValue: "Bash" } },
                    { key: "prompt", value: { stringValue: "SECRET" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const url = `http://127.0.0.1:${r.port}/v1/logs`;
    const ok = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(ok.status, 200);
    assert.equal(seen[0]?.tool, "Bash");
    assert.equal(seen[0]?.session_id, "s9");
    assert.ok(!JSON.stringify(seen).includes("SECRET"));
    const pb = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: "x",
    });
    assert.equal(pb.status, 415);
    assert.equal((await fetch(`http://127.0.0.1:${r.port}/nope`)).status, 404);
  } finally {
    await r.close();
  }
  assert.deepEqual(linesFromOtlp("logs", { resourceLogs: [] }), []);
});

test("process poller emits child start and exit, ignores unrelated processes", async () => {
  let procs = [
    { pid: 10, ppid: 1, name: "claude" },
    { pid: 11, ppid: 10, name: "pnpm" },
    { pid: 12, ppid: 11, name: "node" },
    { pid: 99, ppid: 1, name: "other" },
  ];
  const out: ActivityLine[] = [];
  const p = new ProcessPoller({
    emit: (l) => out.push(l),
    list: async () => procs,
    intervalMs: 60_000,
  });
  p.track(10, "s1");
  await p.poll();
  assert.deepEqual(
    out.map((l) => [l.kind, l.pid]),
    [
      ["process_start", 11],
      ["process_start", 12],
    ],
  );
  procs = procs.filter((x) => x.pid !== 12);
  await p.poll();
  assert.deepEqual(
    [out[2]?.kind, out[2]?.pid, out[2]?.exit_code],
    ["process_exit", 12, null],
  );
  p.stop();
});
