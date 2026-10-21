import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CLAUDE_LOCAL,
  claudeCode,
  planWakeUpgrade,
  upgradeFolderWake,
} from "../hosts/claude-code.ts";
import type { Route } from "../resolve.ts";
import { readTownFile, writeTownFile } from "../town-file.ts";
import {
  IDLE_QUIET_MS,
  MAX_IDLE_WAKES_PER_HOUR,
  WAKE_MIN_INTERVAL_MS,
} from "../wake/gate.ts";
import {
  dropWaiter,
  ledgerAllows,
  markToolServer,
  noteSession,
  parentOf,
  readWakes,
  recordWake,
  toolServerLive,
  WAKE_EXIT,
  WAKE_HOOK_TIMEOUT_S,
  waiterLive,
  waitForWake,
} from "./wake-wait.ts";

const RID = "res_test";
/** A joined folder on disk: the waiter reads its wake setting again on every poll. */
const route = (wake?: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "hawl-wake-root-"));
  writeTownFile(root, {
    v: 1,
    village_id: "vil_1",
    folder_label: "x",
    memberships: [],
    written: [],
    restore: [],
    ...(wake === undefined ? {} : { wake }),
  } as Parameters<typeof writeTownFile>[1]);
  return { root, resident_id: RID, town: readTownFile(root) } as Route;
};

/** A clock that only moves when the waiter sleeps. */
function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function counts(seq: { aimed: number; quietMs: number | null }[]) {
  let i = 0;
  return async () => seq[Math.min(i++, seq.length - 1)] as (typeof seq)[0];
}

const idle = IDLE_QUIET_MS + 1;
/** A state dir where session s1's `hawl mcp` runs (this test process stands in for it). */
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "hawl-wake-"));
  markToolServer(d, RID, process.pid, { session: "s1" });
  return d;
};

test("wakes with exit 2 and the fixed notice when aimed mail arrives while idle", async () => {
  const stateDir = tmp();
  const c = clock();
  let out = "";
  const code = await waitForWake(
    { session_id: "s1" },
    {
      stateDir,
      route: route(),
      ...c,
      notice: counts([
        { aimed: 0, quietMs: idle },
        { aimed: 0, quietMs: idle },
        { aimed: 1, quietMs: idle },
      ]),
      write: (s) => {
        out += s;
      },
    },
  );
  assert.equal(code, WAKE_EXIT);
  assert.equal(out, "📬 Hawl: 1 waiting. Call the mailbox tool.\n");
  assert.equal(readWakes(stateDir, RID).length, 1);
  // The PostToolUse notice will not repeat it.
  assert.equal(readFileSync(join(stateDir, "hook-seen", "s1"), "utf8"), "1");
});

test("mail that already waited at start does not wake; a new arrival does", async () => {
  const stateDir = tmp();
  const c = clock();
  let woke = 0;
  const code = await waitForWake(
    { session_id: "s1" },
    {
      stateDir,
      route: route(),
      ...c,
      lifetimeMs: 60_000,
      notice: counts([
        { aimed: 2, quietMs: idle },
        { aimed: 2, quietMs: idle },
      ]),
      write: () => {
        woke++;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(woke, 0);
  const code2 = await waitForWake(
    { session_id: "s1" },
    {
      stateDir,
      route: route(),
      ...c,
      notice: counts([
        { aimed: 2, quietMs: idle },
        { aimed: 3, quietMs: idle },
      ]),
      write: () => {},
    },
  );
  assert.equal(code2, WAKE_EXIT);
});

test("a read (count drops) re-arms: the next arrival wakes", async () => {
  const c = clock();
  const code = await waitForWake(
    { session_id: "s1" },
    {
      stateDir: tmp(),
      route: route(),
      ...c,
      notice: counts([
        { aimed: 2, quietMs: idle },
        { aimed: 0, quietMs: idle },
        { aimed: 1, quietMs: idle },
      ]),
      write: () => {},
    },
  );
  assert.equal(code, WAKE_EXIT);
});

test("a busy agent is not woken until it goes quiet", async () => {
  const c = clock();
  const seen: number[] = [];
  const code = await waitForWake(
    { session_id: "s1" },
    {
      stateDir: tmp(),
      route: route(),
      ...c,
      notice: async () => {
        seen.push(c.now());
        return seen.length < 2
          ? { aimed: 0, quietMs: 0 }
          : seen.length < 5
            ? { aimed: 1, quietMs: 500 }
            : { aimed: 1, quietMs: idle };
      },
      write: () => {},
    },
  );
  assert.equal(code, WAKE_EXIT);
  assert.equal(seen.length, 5);
});

test("wake off, no folder or no session id: leaves at once with 0", async () => {
  const d = { stateDir: tmp(), notice: counts([{ aimed: 5, quietMs: idle }]) };
  assert.equal(
    await waitForWake({ session_id: "s1" }, { ...d, route: route(false) }),
    0,
  );
  assert.equal(
    await waitForWake({ session_id: "s1" }, { ...d, route: null }),
    0,
  );
  assert.equal(await waitForWake({}, { ...d, route: route() }), 0);
  assert.equal(
    await waitForWake({ session_id: "../x" }, { ...d, route: route() }),
    0,
  );
});

test("a newer waiter for the same session takes over; the older one leaves with 0", async () => {
  const stateDir = tmp();
  const c = clock();
  let polls = 0;
  const older = waitForWake(
    { session_id: "s1" },
    {
      stateDir,
      route: route(),
      now: c.now,
      id: "old",
      sleep: async () => {
        await new Promise((r) => setTimeout(r, 5));
      },
      notice: async () => {
        polls++;
        return { aimed: 0, quietMs: idle };
      },
      write: () => {},
    },
  );
  await new Promise((r) => setTimeout(r, 20));
  // The next Stop starts a new waiter, which claims the session.
  const newer = waitForWake(
    { session_id: "s1" },
    {
      stateDir,
      route: route(),
      ...c,
      id: "new",
      notice: counts([
        { aimed: 0, quietMs: idle },
        { aimed: 1, quietMs: idle },
      ]),
      write: () => {},
    },
  );
  assert.equal(await older, 0);
  assert.equal(await newer, WAKE_EXIT);
  assert.ok(polls >= 1);
});

test("SessionEnd drops the waiter, which then leaves with 0", async () => {
  const stateDir = tmp();
  let n = 0;
  const code = await waitForWake(
    { session_id: "s1" },
    {
      stateDir,
      route: route(),
      now: () => 0,
      sleep: async () => {
        if (++n === 3) dropWaiter(stateDir, "s1");
      },
      notice: counts([{ aimed: 0, quietMs: idle }]),
      write: () => {},
    },
  );
  assert.equal(code, 0);
});

test("leaves with 0 at the end of its lifetime", async () => {
  const c = clock();
  const code = await waitForWake(
    { session_id: "s1" },
    {
      stateDir: tmp(),
      route: route(),
      ...c,
      lifetimeMs: 10_000,
      notice: counts([{ aimed: 0, quietMs: idle }]),
      write: () => {},
    },
  );
  assert.equal(code, 0);
});

test("the shared ledger holds the 30 s interval and the hourly cap across waiters", () => {
  assert.equal(ledgerAllows([], 0), true);
  assert.equal(ledgerAllows([0], WAKE_MIN_INTERVAL_MS - 1), false);
  assert.equal(ledgerAllows([0], WAKE_MIN_INTERVAL_MS + 1), true);
  const full = Array.from(
    { length: MAX_IDLE_WAKES_PER_HOUR },
    (_, i) => i * (WAKE_MIN_INTERVAL_MS + 1),
  );
  assert.equal(ledgerAllows(full, 3_000_000), false);
  assert.equal(ledgerAllows(full, 3_600_000 + WAKE_MIN_INTERVAL_MS * 2), true);
  const stateDir = tmp();
  recordWake(stateDir, RID, 1);
  recordWake(stateDir, RID, 2);
  assert.deepEqual(readWakes(stateDir, RID), [1, 2]);
  assert.deepEqual(readWakes(stateDir, "../bad"), []);
});

test("a second waiter inside the interval does not wake (one wake per 30 s per worker)", async () => {
  const stateDir = tmp();
  const c = clock();
  recordWake(stateDir, RID, c.now());
  const code = await waitForWake(
    { session_id: "s2" },
    {
      stateDir,
      route: route(),
      ...c,
      pollMs: 1_000,
      lifetimeMs: 20_000,
      notice: counts([
        { aimed: 0, quietMs: idle },
        { aimed: 1, quietMs: idle },
      ]),
      write: () => {},
    },
  );
  assert.equal(code, 0);
});

test("waiterLive sees a running waiter for the worker (so the channel stays quiet)", async () => {
  const stateDir = tmp();
  assert.equal(waiterLive(stateDir, RID), false);
  let checked: boolean | undefined;
  await waitForWake(
    { session_id: "s1" },
    {
      stateDir,
      route: route(),
      now: () => 0,
      sleep: async () => {
        checked ??= waiterLive(stateDir, RID);
        dropWaiter(stateDir, "s1");
      },
      notice: counts([{ aimed: 0, quietMs: idle }]),
      write: () => {},
    },
  );
  assert.equal(checked, true);
  assert.equal(waiterLive(stateDir, "res_other"), false);
  assert.equal(waiterLive(stateDir, RID), false);
});

test("join writes the waiter on SessionStart and Stop with asyncRewake and the long timeout", () => {
  const projectDir = tmp();
  const plans = claudeCode.plan({
    projectDir,
    home: tmp(),
    residentId: RID,
    otlpPort: 4318,
  } as never);
  const local = plans.find((p) => p.path === CLAUDE_LOCAL);
  const doc = JSON.parse(local?.after ?? "{}");
  for (const e of ["SessionStart", "Stop"]) {
    const wake = doc.hooks[e].find(
      (g: { hooks: { command: string }[] }) =>
        g.hooks[0]?.command === "hawl hook claude_code Wake",
    );
    assert.deepEqual(wake.hooks[0], {
      type: "command",
      command: "hawl hook claude_code Wake",
      asyncRewake: true,
      timeout: WAKE_HOOK_TIMEOUT_S,
    });
  }
  assert.equal(
    doc.hooks.UserPromptSubmit.some((g: { hooks: { command: string }[] }) =>
      g.hooks[0]?.command.includes("Wake"),
    ),
    false,
  );
  // Our own server is pre-approved, so plain `claude` does not stop on "New MCP server found".
  assert.deepEqual(doc.enabledMcpjsonServers, ["hawl"]);
});

test("join adds hawl to approvals a person already has and keeps their declines", () => {
  const projectDir = tmp();
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  writeFileSync(
    join(projectDir, CLAUDE_LOCAL),
    JSON.stringify({
      enabledMcpjsonServers: ["github"],
      disabledMcpjsonServers: ["other"],
    }),
  );
  const plans = claudeCode.plan({
    projectDir,
    home: tmp(),
    residentId: RID,
    otlpPort: 4318,
  } as never);
  const local = plans.find((p) => p.path === CLAUDE_LOCAL);
  const doc = JSON.parse(local?.after ?? "{}");
  assert.deepEqual(doc.enabledMcpjsonServers, ["github", "hawl"]);
  assert.deepEqual(doc.disabledMcpjsonServers, ["other"]);
  assert.ok(
    local?.entries.some(
      (e) => e.key === "enabledMcpjsonServers[]" && e.path === CLAUDE_LOCAL,
    ),
    "recorded so leave removes it",
  );
});

test("an older joined folder gets the waiter once and leave can find it", () => {
  const root = tmp();
  const stateDir = tmp();
  const old = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            { type: "command", command: "hawl hook claude_code SessionStart" },
          ],
        },
      ],
      Stop: [
        { hooks: [{ type: "command", command: "hawl hook claude_code Stop" }] },
      ],
    },
  };
  mkdirSync(join(root, ".claude"), { recursive: true });
  const before = `${JSON.stringify(old, null, 2)}\n`;
  writeFileSync(join(root, CLAUDE_LOCAL), before);
  writeTownFile(root, {
    v: 1,
    village_id: "vil_1",
    folder_label: "x",
    memberships: [],
    written: [],
    restore: [],
  });
  assert.equal(upgradeFolderWake(root, RID, stateDir), true);
  const doc = JSON.parse(readFileSync(join(root, CLAUDE_LOCAL), "utf8"));
  assert.equal(doc.hooks.Stop.length, 2);
  assert.equal(doc.hooks.SessionStart.length, 2);
  assert.equal(doc.hooks.Stop[1].hooks[0].asyncRewake, true);
  const town = readTownFile(root);
  assert.deepEqual(town?.written.map((w) => w.key).sort(), [
    "hooks.SessionStart[]",
    "hooks.Stop[]",
  ]);
  // Second run: nothing to do.
  assert.equal(upgradeFolderWake(root, RID, stateDir), false);
  // A file without our hooks is never touched.
  const other = tmp();
  mkdirSync(join(other, ".claude"), { recursive: true });
  writeFileSync(join(other, CLAUDE_LOCAL), "{}\n");
  assert.equal(planWakeUpgrade(CLAUDE_LOCAL, join(other, CLAUDE_LOCAL)), null);
});

test("no wake while the session has no hawl mcp (server declined), wakes once it starts", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "hawl-wake-"));
  const c = clock();
  let out = "";
  const seq = counts([
    { aimed: 0, quietMs: idle },
    { aimed: 1, quietMs: idle },
  ]);
  let ticks = 0;
  const code = await waitForWake(
    { session_id: "s1" },
    {
      stateDir,
      route: route(),
      ...c,
      lifetimeMs: 60_000,
      notice: async () => {
        // The person turns the server on (/mcp) after a few ticks.
        if (++ticks === 6)
          markToolServer(stateDir, RID, process.pid, { session: "s1" });
        return seq();
      },
      write: (s) => {
        out += s;
      },
    },
  );
  assert.equal(code, WAKE_EXIT);
  assert.ok(ticks >= 6, "held until the tool server ran");
  assert.equal(out, "📬 Hawl: 1 waiting. Call the mailbox tool.\n");
});

test("a declined server never wakes; a crashed server's marker is cleared", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "hawl-wake-"));
  const c = clock();
  let out = "";
  const code = await waitForWake(
    { session_id: "s1" },
    {
      stateDir,
      route: route(),
      ...c,
      lifetimeMs: 30_000,
      notice: counts([
        { aimed: 0, quietMs: idle },
        { aimed: 1, quietMs: idle },
      ]),
      write: (s) => {
        out += s;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(out, "");
  assert.equal(readWakes(stateDir, RID).length, 0);
  // A pid that is not running: its marker does not count and is removed.
  const me = { sessions: ["s1"], claudePid: 1 };
  markToolServer(stateDir, RID, 2_147_483_000, { session: "s1" });
  assert.equal(toolServerLive(stateDir, RID, me), false);
  assert.deepEqual(
    readdirSync(join(stateDir, "hook-wake")).filter((f) =>
      f.startsWith("mcp-"),
    ),
    [],
  );
  markToolServer(stateDir, RID, process.pid, { session: "s1" })();
  assert.equal(toolServerLive(stateDir, RID, me), false);
});

test("another session's hawl mcp for the same worker does not wake a session that declined it", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "hawl-wake-"));
  // A second Claude Code session in the same folder has the server; this one ("s1") does not.
  markToolServer(stateDir, RID, process.pid, { session: "other", ppid: 4 });
  const c = clock();
  let out = "";
  const code = await waitForWake(
    { session_id: "s1" },
    {
      stateDir,
      route: route(),
      ...c,
      claudePid: 7,
      parentOf: () => 5,
      lifetimeMs: 30_000,
      notice: counts([
        { aimed: 0, quietMs: idle },
        { aimed: 1, quietMs: idle },
      ]),
      write: (s) => {
        out += s;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(out, "");
  assert.equal(readWakes(stateDir, RID).length, 0);
});

test("a session's own server counts by its session id, its Claude Code pid, or after /clear", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "hawl-wake-"));
  markToolServer(stateDir, RID, process.pid, { session: "first", ppid: 4 });
  const no = () => undefined;
  assert.equal(
    toolServerLive(stateDir, RID, { sessions: ["first"], claudePid: 9 }),
    true,
  );
  assert.equal(
    toolServerLive(stateDir, RID, {
      sessions: ["x"],
      claudePid: 9,
      parentOf: no,
    }),
    false,
  );
  // `claude --continue`: the server's session id is new, its process is this Claude Code's.
  // Started directly (its parent is the CLAUDE_PID hooks get) or through cmd.exe (grandparent).
  assert.equal(
    toolServerLive(stateDir, RID, {
      sessions: ["x"],
      claudePid: 4,
      parentOf: no,
    }),
    true,
  );
  assert.equal(
    toolServerLive(stateDir, RID, {
      sessions: ["x"],
      claudePid: 3,
      parentOf: (p) => (p === 4 ? 3 : undefined),
    }),
    true,
  );
  // /clear: same Claude Code process (this test's pid stands in), new session id. The server
  // keeps the id it started with; the process's list links the two.
  const claudePid = process.pid;
  assert.deepEqual(noteSession(stateDir, "first", claudePid), ["first"]);
  const after = noteSession(stateDir, "second", claudePid);
  assert.deepEqual(after, ["first", "second"]);
  assert.equal(
    toolServerLive(stateDir, RID, { sessions: after, claudePid: 9 }),
    true,
  );
  // A Claude Code that stops passing CLAUDE_CODE_SESSION_ID (it is not in its docs): match by
  // worker as before, and report it, rather than never waking again.
  const loose = mkdtempSync(join(tmpdir(), "hawl-wake-"));
  markToolServer(loose, RID, process.pid, {});
  let said = 0;
  assert.equal(
    toolServerLive(loose, RID, {
      sessions: ["x"],
      claudePid: 9,
      loose: () => said++,
    }),
    true,
  );
  // Same when hooks get no CLAUDE_PID.
  markToolServer(loose, RID, process.pid, { session: "other", ppid: 4 });
  assert.equal(
    toolServerLive(loose, RID, { sessions: ["x"], loose: () => said++ }),
    true,
  );
  assert.equal(said, 2);
  // The real lookup: this test's parent is what the OS reports.
  assert.equal(parentOf(process.pid), process.ppid);
  // Another Claude Code process's list never includes it.
  assert.deepEqual(noteSession(stateDir, "third", process.ppid), ["third"]);
});

test("hawl wake off while a waiter waits: it leaves with 0 and never wakes", async () => {
  const stateDir = tmp();
  const r = route();
  const c = clock();
  let out = "";
  let ticks = 0;
  const code = await waitForWake(
    { session_id: "s1" },
    {
      stateDir,
      route: r,
      ...c,
      notice: async () => {
        // The person runs `hawl wake off` between polls, then mail arrives.
        if (++ticks === 2) {
          const town = readTownFile(r.root);
          writeTownFile(r.root, {
            ...(town as object),
            wake: false,
          } as Parameters<typeof writeTownFile>[1]);
        }
        return { aimed: ticks >= 3 ? 1 : 0, quietMs: idle };
      },
      write: (s) => {
        out += s;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(out, "");
  assert.ok(ticks <= 2, "left at the next poll");
  assert.equal(waiterLive(stateDir, RID), false);
});
