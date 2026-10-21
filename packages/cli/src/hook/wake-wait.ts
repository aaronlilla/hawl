import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { defaultStateDir } from "../daemon/main.ts";
import { readToken, request, socketPath } from "../daemon/socket.ts";
import { type Route, resolveRoute } from "../resolve.ts";
import { readTownFile } from "../town-file.ts";
import {
  IDLE_QUIET_MS,
  MAX_IDLE_WAKES_PER_HOUR,
  WAKE_MIN_INTERVAL_MS,
  wakeOn,
} from "../wake/gate.ts";
import type { HookInput } from "./hook.ts";
import { formatNotice } from "./notice.ts";

/**
 * Idle wake for a plain `claude` session, no flag needed. Claude Code runs this as an
 * `asyncRewake` hook on SessionStart and Stop (code.claude.com/docs/en/hooks, "Run hooks in the
 * background"): it waits in the background and, on exit code 2, wakes the session even when idle,
 * showing our stderr to the agent as a system reminder. Only the fixed notice ever goes out.
 *
 * One waiter per session: a newer one (the next Stop) takes over and the older exits 0. It only
 * wakes for mail that arrived after it started; what waited at Stop was shown by the Stop hook.
 */

/** The `timeout` written into the hook entry. Claude Code kills the waiter after this. */
export const WAKE_HOOK_TIMEOUT_S = 86_400;
/** The waiter leaves on its own a minute before Claude Code would kill it. */
export const WAKE_LIFETIME_MS = (WAKE_HOOK_TIMEOUT_S - 60) * 1000;
export const WAKE_POLL_MS = 3_000;
const BACKOFF_MS = 30_000;

/** Exit codes: 2 wakes the session, 0 leaves quietly. */
export const WAKE_EXIT = 2;

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_RID = /^[A-Za-z0-9_-]{1,128}$/;

export interface WakeWaitDeps {
  stateDir?: string;
  route?: Route | null;
  /** The daemon's counts for this worker. Default: the `notice` op over the local socket. */
  notice?: () => Promise<{ aimed: number; quietMs: number | null }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  lifetimeMs?: number;
  /** This waiter's id in the session's owner file. Default: pid plus start time. */
  id?: string;
  /** Where the notice goes. Default: stderr. */
  write?: (s: string) => void;
  /** The session has a running `hawl mcp`. Default: its marker file (toolServerLive). */
  toolServer?: () => boolean;
  /** Claude Code's pid. Default: `CLAUDE_PID`, which Claude Code gives hooks. */
  claudePid?: number;
  /** Parent pid lookup. Default: parentOf. */
  parentOf?: (pid: number) => number | undefined;
  /** The folder still has wake on. Default: its `.hawl/hawl.json`, read on every poll. */
  wakeOn?: () => boolean;
}

function ownerFile(stateDir: string, sessionId: string): string {
  return join(stateDir, "hook-wake", `${sessionId}.owner`);
}

/** Per-worker wake times, shared by every waiter and by `hawl mcp`'s channel. */
export function ledgerFile(stateDir: string, rid: string): string | null {
  if (!SAFE_RID.test(rid)) return null;
  return join(stateDir, "hook-wake", `wakes-${rid}.json`);
}

export function readWakes(stateDir: string, rid: string): number[] {
  const f = ledgerFile(stateDir, rid);
  if (!f) return [];
  try {
    const v = JSON.parse(readFileSync(f, "utf8")) as unknown;
    return Array.isArray(v)
      ? v.filter((t): t is number => typeof t === "number")
      : [];
  } catch {
    return [];
  }
}

export function recordWake(stateDir: string, rid: string, now: number): void {
  const f = ledgerFile(stateDir, rid);
  if (!f) return;
  const keep = readWakes(stateDir, rid).filter((t) => now - t < 3_600_000);
  try {
    mkdirSync(join(stateDir, "hook-wake"), { recursive: true, mode: 0o700 });
    writeFileSync(f, JSON.stringify([...keep, now]), { mode: 0o600 });
  } catch {
    // best effort: the in-process interval still holds
  }
}

/** The local limits from wake/gate.ts, over the shared ledger. */
export function ledgerAllows(wakes: number[], now: number): boolean {
  const hour = wakes.filter((t) => now - t < 3_600_000);
  const last = hour[hour.length - 1];
  if (last !== undefined && now - last < WAKE_MIN_INTERVAL_MS) return false;
  return hour.length < MAX_IDLE_WAKES_PER_HOUR;
}

/** Ends the session's waiter (SessionEnd). */
export function dropWaiter(stateDir: string, sessionId?: string): void {
  if (!sessionId || !SAFE_SESSION.test(sessionId)) return;
  rmSync(ownerFile(stateDir, sessionId), { force: true });
}

/** The owner file holds the waiter id, a newline, then the worker id. */
function claim(
  stateDir: string,
  sessionId: string,
  id: string,
  rid: string,
): boolean {
  try {
    mkdirSync(join(stateDir, "hook-wake"), { recursive: true, mode: 0o700 });
    writeFileSync(ownerFile(stateDir, sessionId), `${id}\n${rid}`, {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

function stillOwner(stateDir: string, sessionId: string, id: string): boolean {
  try {
    const f = ownerFile(stateDir, sessionId);
    return existsSync(f) && readFileSync(f, "utf8").split("\n")[0] === id;
  } catch {
    return false;
  }
}

/**
 * True when a waiter for this worker is running, so `hawl mcp` leaves the wake to it instead of
 * also pushing a channel event (a session started with the channel flag would be woken twice).
 */
export function waiterLive(
  stateDir: string,
  rid: string,
  now = Date.now(),
): boolean {
  const dir = join(stateDir, "hook-wake");
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".owner")) continue;
      const p = join(dir, f);
      if (now - statSync(p).mtimeMs > WAKE_HOOK_TIMEOUT_S * 1000) continue;
      if (readFileSync(p, "utf8").split("\n")[1] === rid) return true;
    }
  } catch {
    // no waiters yet
  }
  return false;
}

/**
 * Each running `hawl mcp` leaves `hook-wake/mcp-<worker>-<pid>` while it lives, holding the
 * Claude Code session it was started for. A waiter wakes only when its own session has one:
 * without it the session has no mailbox tool (the person declined the server, or it failed to
 * start), so a wake would only tell the agent to call a tool it does not have. Another session
 * for the same worker having the server does not count.
 */
function toolServerFile(stateDir: string, rid: string, pid: number) {
  return join(stateDir, "hook-wake", `mcp-${rid}-${pid}`);
}

/** Who started a tool server. Claude Code gives MCP servers `CLAUDE_CODE_SESSION_ID`. */
export interface ToolServerOwner {
  session?: string;
  ppid?: number;
}

export function markToolServer(
  stateDir: string,
  rid: string,
  pid = process.pid,
  owner: ToolServerOwner = {
    session: process.env.CLAUDE_CODE_SESSION_ID,
    ppid: process.ppid,
  },
): () => void {
  if (!SAFE_RID.test(rid)) return () => {};
  const f = toolServerFile(stateDir, rid, pid);
  try {
    mkdirSync(join(stateDir, "hook-wake"), { recursive: true, mode: 0o700 });
    writeFileSync(f, JSON.stringify(owner), { mode: 0o600 });
  } catch {
    return () => {};
  }
  return () => rmSync(f, { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The sessions one Claude Code process has had. `/clear` starts a new session id in the same
 * process, while its tool server keeps the id it started with. Hooks get `CLAUDE_PID`.
 */
function claudeFile(stateDir: string, claudePid: number) {
  return join(stateDir, "hook-wake", `claude-${claudePid}`);
}

export function noteSession(
  stateDir: string,
  sessionId: string,
  claudePid: number | undefined,
): string[] {
  if (!claudePid) return [sessionId];
  const f = claudeFile(stateDir, claudePid);
  let seen: string[] = [];
  try {
    seen = readFileSync(f, "utf8").split("\n").filter(Boolean);
  } catch {
    // first waiter for this process
  }
  if (!seen.includes(sessionId)) {
    seen.push(sessionId);
    try {
      mkdirSync(join(stateDir, "hook-wake"), { recursive: true, mode: 0o700 });
      writeFileSync(f, `${seen.join("\n")}\n`, { mode: 0o600 });
    } catch {
      // best effort: the session's own id still matches
    }
  }
  // Ended processes' lists go; their pids may be reused.
  try {
    for (const name of readdirSync(join(stateDir, "hook-wake"))) {
      const m = /^claude-(\d+)$/.exec(name);
      if (m && !alive(Number(m[1])))
        rmSync(join(stateDir, "hook-wake", name), { force: true });
    }
  } catch {
    // nothing to sweep
  }
  return seen;
}

const parents = new Map<number, number | undefined>();

/** A process's parent pid, asked of the OS once per pid. Only checked when a wake is due. */
export function parentOf(pid: number): number | undefined {
  if (parents.has(pid)) return parents.get(pid);
  let ppid: number | undefined;
  try {
    const out =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
            ],
            { encoding: "utf8", timeout: 10_000, windowsHide: true },
          )
        : execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
            encoding: "utf8",
            timeout: 5_000,
          });
    const n = Number(out.trim());
    if (Number.isInteger(n) && n > 0) ppid = n;
  } catch {
    // gone, or no way to ask: no match
  }
  parents.set(pid, ppid);
  return ppid;
}

function readOwner(f: string): ToolServerOwner {
  try {
    const o = JSON.parse(readFileSync(f, "utf8")) as ToolServerOwner;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

/**
 * True when a `hawl mcp` for this worker runs in this session: started for one of `sessions`,
 * or a direct child of `claudePid`. Markers left by a crash are removed.
 */
export function toolServerLive(
  stateDir: string,
  rid: string,
  me: {
    sessions: string[];
    claudePid?: number;
    loose?: () => void;
    parentOf?: (pid: number) => number | undefined;
  },
): boolean {
  const dir = join(stateDir, "hook-wake");
  const prefix = `mcp-${rid}-`;
  let live = false;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(prefix)) continue;
      const pid = Number(f.slice(prefix.length));
      if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) {
        rmSync(join(dir, f), { force: true });
        continue;
      }
      const o = readOwner(join(dir, f));
      if (o.session && me.sessions.includes(o.session)) live = true;
      else if (me.claudePid && o.ppid) {
        // `claude --continue` gives the server a new session id that no hook sees. Its process
        // still belongs to this Claude Code: started directly (macOS, Linux) or through
        // hawl.cmd's cmd.exe (Windows).
        if (
          o.ppid === me.claudePid ||
          (me.parentOf ?? parentOf)(o.ppid) === me.claudePid
        )
          live = true;
      }
      if (!live && (!o.session || !me.claudePid)) {
        // CLAUDE_CODE_SESSION_ID and CLAUDE_PID are not in Claude Code's docs. If a version
        // stops passing them, match by worker as before rather than never waking again, and
        // say so in the trace.
        live = true;
        me.loose?.();
      }
    }
  } catch {
    // no markers yet
  }
  return live;
}

function daemonNotice(stateDir: string, rid: string) {
  return async () => {
    const token = readToken(stateDir);
    if (!token) throw new Error("no daemon");
    const r = await request(
      socketPath(stateDir),
      { op: "notice", token, resident_id: rid },
      2_000,
    );
    if (!r.ok) throw new Error("notice failed");
    const v = r.result as { aimed?: unknown; quiet_ms?: unknown };
    return {
      aimed: typeof v?.aimed === "number" ? v.aimed : 0,
      quietMs: typeof v?.quiet_ms === "number" ? v.quiet_ms : null,
    };
  };
}

/** Same file the hook keeps for PostToolUse, so a wake is not repeated as a mid-task notice. */
function writeSeen(stateDir: string, sessionId: string, aimed: number): void {
  try {
    mkdirSync(join(stateDir, "hook-seen"), { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, "hook-seen", sessionId), String(aimed), {
      mode: 0o600,
    });
  } catch {
    // best effort
  }
}

/** `HAWL_WAKE_LOG=<file>`: one JSON line per waiter step, for debugging a wake that did not come. */
function tracer(file = process.env.HAWL_WAKE_LOG) {
  return (o: Record<string, unknown>) => {
    if (!file) return;
    try {
      const at = new Date().toISOString();
      writeFileSync(
        file,
        `${JSON.stringify({ at, pid: process.pid, ...o })}\n`,
        { flag: "a" },
      );
    } catch {
      // debugging only
    }
  };
}

/** `hawl hook claude_code Wake`. Returns the exit code. Never throws. */
export async function waitForWake(
  input: HookInput,
  deps: WakeWaitDeps = {},
): Promise<number> {
  const stateDir = deps.stateDir ?? defaultStateDir();
  const sessionId = input.session_id;
  const tr = tracer();
  tr({ step: "start", session: sessionId, cwd: input.cwd, stateDir });
  if (!sessionId || !SAFE_SESSION.test(sessionId)) return 0;
  const route =
    deps.route === undefined
      ? resolveRoute(input.cwd ?? process.cwd(), { host: "claude_code" })
      : deps.route;
  if (!route || !wakeOn(route.town)) {
    tr({ step: "leave", why: route ? "wake off" : "no joined folder" });
    return 0;
  }
  const rid = route.resident_id;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const notice = deps.notice ?? daemonNotice(stateDir, rid);
  const id = deps.id ?? `${process.pid}-${now()}`;
  if (!claim(stateDir, sessionId, id, rid)) return 0;
  const end = now() + (deps.lifetimeMs ?? WAKE_LIFETIME_MS);
  const claudePid =
    "claudePid" in deps
      ? deps.claudePid
      : Number(process.env.CLAUDE_PID) || undefined;
  noteSession(stateDir, sessionId, claudePid);
  const toolServer =
    deps.toolServer ??
    (() =>
      toolServerLive(stateDir, rid, {
        sessions: noteSession(stateDir, sessionId, claudePid),
        claudePid,
        parentOf: deps.parentOf,
        loose: () =>
          tr({
            step: "loose-match",
            why: "hawl mcp got no Claude Code session id; matched by worker",
          }),
      }));
  // `hawl wake off` while this waits: read the folder's setting again on every poll.
  const stillOn =
    deps.wakeOn ??
    (() => {
      try {
        return wakeOn(readTownFile(route.root));
      } catch {
        return false;
      }
    });
  // Baseline: only mail that lands after this point wakes the session.
  let told: number | null = null;
  let saidNoTools = false;
  while (now() < end) {
    if (!stillOwner(stateDir, sessionId, id)) {
      tr({ step: "leave", why: "superseded or session ended" });
      return 0;
    }
    if (!stillOn()) {
      tr({ step: "leave", why: "wake off" });
      dropWaiter(stateDir, sessionId);
      return 0;
    }
    let wait = deps.pollMs ?? WAKE_POLL_MS;
    try {
      const { aimed, quietMs } = await notice();
      if (told === null || aimed < told) told = aimed;
      const t = now();
      tr({ step: "tick", aimed, quietMs, told });
      const due =
        aimed > told &&
        (quietMs === null || quietMs >= IDLE_QUIET_MS) &&
        ledgerAllows(readWakes(stateDir, rid), t);
      // Keep waiting without tools: the person may still turn the server on (/mcp).
      const tools = due && toolServer();
      if (due && !tools && !saidNoTools) {
        tr({ step: "hold", why: "no hawl mcp running in this session" });
        saidNoTools = true;
      }
      if (tools) {
        const text = formatNotice(aimed);
        if (text && stillOwner(stateDir, sessionId, id)) {
          recordWake(stateDir, rid, t);
          writeSeen(stateDir, sessionId, aimed);
          dropWaiter(stateDir, sessionId);
          (deps.write ?? ((s) => process.stderr.write(s)))(`${text}\n`);
          tr({ step: "wake", aimed });
          return WAKE_EXIT;
        }
      }
    } catch (e) {
      tr({ step: "error", error: (e as Error).message });
      wait = BACKOFF_MS; // helper down or restarting
    }
    await sleep(Math.min(wait, Math.max(0, end - now())));
  }
  if (stillOwner(stateDir, sessionId, id)) dropWaiter(stateDir, sessionId);
  return 0;
}
