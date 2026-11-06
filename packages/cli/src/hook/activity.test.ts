import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActivityForwarder,
  type ActivityLine,
  findAgentRoot,
  linesFromOtlp,
  ProcessPoller,
  ReasonLinker,
  sanitizeLine,
  startOtlpReceiver,
  WinProcLister,
} from "../daemon/activity.ts";
import { MemoryKeyStore } from "../daemon/keys.ts";
import { startDaemon } from "../daemon/main.ts";
import { ManifestStore } from "../daemon/manifest.ts";
import { request, socketPath } from "../daemon/socket.ts";
import { makeRoot, tmpState } from "../daemon/testkit.ts";
import { hookOutput, programsOf, reasonOf, shortTarget } from "./hook.ts";

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

test("process poller lists nothing without tracked roots and restarts on track", async () => {
  let calls = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const p = new ProcessPoller({
    emit: () => {},
    list: async () => {
      calls++;
      return [
        { pid: 10, ppid: 1, name: "claude" },
        { pid: 11, ppid: 10, name: "node" },
      ];
    },
    intervalMs: 20,
  });
  await p.poll();
  assert.equal(calls, 0, "never tracked");
  p.track(10, "s1");
  await wait(90);
  assert.ok(calls > 0, "tracked: polls");
  p.untrackSession("s1");
  await wait(90); // one more poll reports the exit, then the timer stops
  const after = calls;
  await wait(90);
  assert.equal(calls, after, "no roots: no list calls");
  p.track(10, "s2");
  await wait(90);
  assert.ok(calls > after, "track() restarts the poller");
  p.stop();
});

test("WinProcLister: one child answers repeated requests, restarts after a kill", {
  skip: process.platform !== "win32",
}, async () => {
  const l = new WinProcLister();
  for (let i = 0; i < 2; i++) {
    const all = await l.list();
    const me = all.find((p) => p.pid === process.pid);
    assert.equal(me?.ppid, process.ppid);
    assert.match(me?.name ?? "", /^node(\.exe)?$/i);
  }
  l.close();
  assert.ok((await l.list()).length > 0, "restarts after close");
  l.close();
});

test("sanitizeLine keeps a clamped reason with control chars stripped", () => {
  const l = sanitizeLine(
    {
      kind: "tool_before",
      tool: "Bash",
      reason: `run tests\n${"x".repeat(200)}`,
      command: "rm -rf /",
    },
    "hook",
  ) as ActivityLine;
  assert.equal(l.reason?.length, 120);
  assert.equal(l.reason?.startsWith("run tests x"), true);
  assert.equal("command" in l, false);
});

test("hook reason: Bash and Monitor description only, never the command", () => {
  const bash = {
    tool_name: "Bash",
    tool_input: {
      description: "start dev server",
      command: "secret --token abc",
    },
  };
  assert.equal(reasonOf(bash), "start dev server");
  assert.equal(
    reasonOf({
      tool_name: "Monitor",
      tool_input: { description: "watch log" },
    }),
    "watch log",
  );
  assert.equal(
    reasonOf({ tool_name: "Edit", tool_input: { description: "x" } }),
    undefined,
  );
  assert.equal(
    reasonOf({ tool_name: "Bash", tool_input: { command: "ls" } }),
    undefined,
  );
});

test("ReasonLinker: the deepest process named in the command takes the reason; descendants inherit; wrappers and hook shells do not", () => {
  const t0 = 1_000_000;
  const link = new ReasonLinker();
  link.note("s1", "run ping", ["ping"], t0);
  link.note("s1", "run script", ["cd", "python"], t0 + 1);
  const ps = (
    pid: number,
    ppid: number,
    name: string,
    session = "s1",
  ): ActivityLine => ({
    kind: "process_start",
    source: "proc",
    ts: "x",
    session_id: session,
    pid,
    parent_pid: ppid,
    name,
  });
  // One poll: two job wrappers (python.exe, the agent's own children 100) and what they run.
  const got = link
    .annotateBatch(
      [
        ps(10, 100, "bash.exe"), // hook shell: no program match
        ps(20, 100, "python.exe"), // wrapper of the ping call
        ps(21, 20, "bash.exe"),
        ps(22, 21, "PING.EXE"),
        ps(30, 100, "python.exe"), // wrapper of the script call
        ps(31, 30, "bash.exe"),
        ps(32, 31, "Python.EXE"),
        ps(33, 32, "conhost.exe"),
        ps(40, 100, "ping.exe", "s2"), // other session
      ],
      t0 + 1000,
    )
    .map((l) => l.reason);
  assert.deepEqual(got, [
    undefined,
    undefined,
    undefined,
    "run ping",
    undefined,
    undefined,
    "run script",
    "run script",
    undefined,
  ]);
  // Claimed once; a child that starts in a later poll inherits from its known parent.
  assert.equal(
    link.annotateBatch([ps(23, 22, "ping.exe")], t0 + 2000)[0]?.reason,
    "run ping",
  );
  assert.equal(
    link.annotateBatch([ps(41, 100, "ping.exe")], t0 + 2000)[0]?.reason,
    undefined,
  );
  link.note("s1", "old", ["node"], t0);
  assert.equal(
    link.annotateBatch([ps(16, 100, "node.exe")], t0 + 60_000)[0]?.reason,
    undefined,
  );
});

test("ReasonLinker: a Monitor whose program has no live parent takes its shell wrapper, once it outlives a poll; hook shells do not", () => {
  const t0 = 1_000_000;
  const link = new ReasonLinker();
  const ps = (pid: number, ppid: number, name: string): ActivityLine => ({
    kind: "process_start",
    source: "proc",
    ts: `t${pid}`,
    session_id: "s1",
    pid,
    parent_pid: ppid,
    name,
  });
  link.note("s1", "watch ready flag", ["sleep", "echo"], t0, true);
  link.note("s1", "plain bash", ["ls"], t0, false);
  // Poll 1 (agent root 100): a hook shell chain that is already dying, and the Monitor's wrapper.
  // `sleep` is forked from a dead parent, so it is not in the tree at all.
  const first = link.annotateBatch(
    [
      ps(5, 100, "bash.exe"),
      ps(6, 5, "sh.exe"),
      ps(10, 100, "bash.exe"),
      ps(11, 10, "bash.exe"),
      ps(12, 11, "bash.exe"),
    ],
    t0 + 1000,
  );
  assert.deepEqual(
    first.map((l) => l.reason),
    [undefined, undefined, undefined, undefined, undefined],
  );
  // One poll later (2 s) is too soon; at 3 s the hook shells are gone and the wrapper lives on.
  assert.deepEqual(link.confirm(new Set([10, 11, 12, 100]), t0 + 3000), []);
  const late = link.confirm(new Set([10, 11, 12, 100]), t0 + 4500);
  assert.equal(late.length, 1);
  assert.equal(late[0]?.pid, 10);
  assert.equal(late[0]?.name, "bash.exe");
  assert.equal(late[0]?.reason, "watch ready flag");
  assert.equal(late[0]?.ts, "t10");
  // Claimed once; its children do not inherit (the wrapper stays the one row); nothing else is claimed.
  assert.deepEqual(link.confirm(new Set([10, 11, 12, 100]), t0 + 5500), []);
  assert.equal(
    link.annotateBatch([ps(13, 10, "sleep.exe")], t0 + 5000)[0]?.reason,
    undefined,
  );
  // A Bash note never takes a wrapper.
  link.note("s1", "bg", ["ls"], t0 + 6000, false);
  link.annotateBatch([ps(20, 100, "bash.exe")], t0 + 6500);
  assert.deepEqual(link.confirm(new Set([20, 100]), t0 + 10_500), []);
});

test("programsOf: program names only, no arguments", () => {
  const p = (command: unknown) =>
    programsOf({ tool_name: "Bash", tool_input: { command } });
  assert.deepEqual(p("cd x && FOO=1 python -c 'secret=1' | tee out; sleep 5"), [
    "cd",
    "python",
    "tee",
    "sleep",
  ]);
  assert.deepEqual(p("npm run dev"), ["node"]);
  assert.deepEqual(p("./run.sh --token abc"), ["bash", "sh"]);
  assert.deepEqual(p("C:\\tools\\Py.exe x.py"), ["python"]);
  assert.deepEqual(p(undefined), []);
});

test("findAgentRoot: the hook's parent is a short-lived shell; the agent is the first host-named ancestor", () => {
  const all = [
    { pid: 1, ppid: 0, name: "node.exe" },
    { pid: 10, ppid: 1, name: "claude.exe" },
    { pid: 20, ppid: 10, name: "bash.exe" },
    { pid: 30, ppid: 20, name: "sh.exe" },
  ];
  assert.equal(findAgentRoot(all, 30, "claude_code"), 10);
  assert.equal(findAgentRoot(all, 30, "codex"), 30); // no match: keep the hook's parent
  assert.equal(findAgentRoot(all, 99, "claude_code"), 99);
});
