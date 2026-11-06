import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatWakeNotice } from "../hook/notice.ts";
import { queueCodexNotice } from "../hosts/codex-app-server.ts";
import { IDLE_QUIET_MS, WAKE_MIN_INTERVAL_MS } from "../wake/gate.ts";
import { CodexIdleWake, codexTarget } from "./idle-wake.ts";
import type { SessionSeen } from "./sessions.ts";

const T = "019a0000-1111-7222-8333-444455556666";
const T2 = "019a0000-1111-7222-8333-444455557777";
const T3 = "019a0000-1111-7222-8333-444455558888";
const NOW = Date.parse("2026-10-16T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function s(p: Partial<SessionSeen>): SessionSeen {
  return {
    host: "codex",
    via: "hook",
    resident_id: "res_A",
    root: "/w/app",
    session_id: T,
    first_seen: at(60_000),
    last_seen: at(60_000),
    ...p,
  };
}

test("codexTarget: newest fresh Codex hook session of this worker", () => {
  const list = [
    s({ session_id: T, last_seen: at(120_000) }),
    s({ session_id: T2, last_seen: at(10_000) }),
    s({ session_id: "not-a-uuid; rm -rf", last_seen: at(1) }),
    s({ host: "claude_code", session_id: T2, last_seen: at(1) }),
    s({ resident_id: "res_B", last_seen: at(1) }),
    s({ via: "mcp", session_id: T3, last_seen: at(1) }),
  ];
  assert.equal(codexTarget(list, "res_A", NOW)?.session_id, T2);
  assert.equal(
    codexTarget([s({ last_seen: at(13 * 3_600_000) })], "res_A", NOW),
    undefined,
    "stale session",
  );
});

test("codexTarget: a terminal's agent finds the thread its MCP server is bound to, under the folder's hook row", () => {
  const list = [
    // Hooks report under the folder's agent; the terminal's MCP server names the thread it follows.
    s({ resident_id: "res_folder", session_id: T }),
    s({ resident_id: "res_terminal", via: "mcp", session_id: T }),
    // Another terminal of the same folder, newer: its thread is not this terminal's.
    s({ resident_id: "res_folder", session_id: T2, last_seen: at(1) }),
    s({ resident_id: "res_other", via: "mcp", session_id: T2 }),
  ];
  assert.equal(codexTarget(list, "res_terminal", NOW)?.session_id, T);
  assert.equal(codexTarget(list, "res_other", NOW)?.session_id, T2);
  assert.equal(codexTarget(list, "res_folder", NOW)?.session_id, T2);
  assert.equal(
    codexTarget(
      [
        s({ resident_id: "res_folder", session_id: T }),
        s({ resident_id: "res_terminal", via: "mcp", session_id: T2 }),
      ],
      "res_terminal",
      NOW,
    ),
    undefined,
    "a terminal still on its provisional id has no thread yet",
  );
});

test("CodexIdleWake queues the notice once per rise, honours wake off and busy", async () => {
  const queued: [string, number][] = [];
  let aimed = 1;
  let quietMs: number | null = IDLE_QUIET_MS + 1;
  let on = true;
  const w = new CodexIdleWake({
    counts: () => ({ aimed, quietMs }),
    sessions: () => [s({})],
    queue: async (id, n) => {
      queued.push([id, n]);
      return true;
    },
    folderWakeOn: () => on,
    now: () => NOW,
  });
  assert.equal(await w.check("res_A"), T);
  assert.equal(await w.check("res_A"), undefined, "same count");
  on = false;
  aimed = 2;
  assert.equal(await w.check("res_A"), undefined, "wake off");
  on = true;
  quietMs = 100;
  assert.equal(await w.check("res_A"), undefined, "busy");
  assert.equal(await w.check("res_B"), undefined, "no session");
  assert.deepEqual(queued, [[T, 1]]);
});

function fakeProc(code: number) {
  const e = new EventEmitter();
  setImmediate(() => e.emit("exit", code));
  return e as never;
}

test("queueCodexNotice runs `codex queue` with the fixed wake notice only", async () => {
  const calls: [string, string[]][] = [];
  const ok = await queueCodexNotice(T, 3, {
    spawnFn: (cmd, args) => {
      calls.push([cmd, args]);
      return fakeProc(0);
    },
  });
  assert.equal(ok, true);
  const [cmd, args] = calls[0] ?? ["", []];
  assert.equal(cmd, "codex");
  assert.deepEqual(args.slice(0, 4), ["queue", "--thread", T, "--message"]);
  assert.equal(args[4]?.replace(/^"|"$/g, ""), formatWakeNotice(3));
  // Windows joins this through cmd.exe: it must hold nothing cmd would read.
  assert.doesNotMatch(args[4]?.replace(/^"|"$/g, "") ?? "", /["&|<>^%]/);
  assert.equal(args.length, 5);
});

test("queueCodexNotice refuses a bad thread id, zero mail, and reports failure", async () => {
  let spawned = 0;
  const spawnFn = () => {
    spawned++;
    return fakeProc(1);
  };
  assert.equal(await queueCodexNotice("x & calc", 1, { spawnFn }), false);
  assert.equal(await queueCodexNotice(T, 0, { spawnFn }), false);
  assert.equal(spawned, 0);
  assert.equal(await queueCodexNotice(T, 1, { spawnFn }), false, "exit 1");
});

test(
  "queueCodexNotice finds a Codex installed after the daemon started",
  { skip: process.platform !== "win32" },
  async () => {
    const local = mkdtempSync(join(tmpdir(), "hawl-codex-install-"));
    const bin = join(local, "Programs", "OpenAI", "Codex", "bin");
    const seen = join(local, "ran.txt");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "codex.cmd"),
      `@echo off\r\necho %2 %3 > "${seen}"\r\n`,
    );
    const was = { path: process.env.PATH, local: process.env.LOCALAPPDATA };
    process.env.PATH = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    process.env.LOCALAPPDATA = local;
    try {
      assert.equal(await queueCodexNotice(T, 1), true);
      assert.ok(existsSync(seen), "the stand-in Codex ran");
    } finally {
      process.env.PATH = was.path;
      process.env.LOCALAPPDATA = was.local;
    }
  },
);

test("a failed queue is retried on a later check, after the interval", async () => {
  let ok = false;
  let now = NOW;
  const calls: number[] = [];
  const w = new CodexIdleWake({
    counts: () => ({ aimed: 1, quietMs: null }),
    sessions: () => [s({ last_seen: new Date(NOW - 1000).toISOString() })],
    queue: async () => {
      calls.push(now);
      return ok;
    },
    folderWakeOn: () => true,
    now: () => now,
  });
  assert.equal(await w.check("res_A"), undefined, "codex queue failed");
  assert.equal(await w.check("res_A"), undefined, "too soon to retry");
  ok = true;
  now += WAKE_MIN_INTERVAL_MS + 1;
  assert.equal(await w.check("res_A"), T, "retried");
  assert.equal(calls.length, 2);
});
