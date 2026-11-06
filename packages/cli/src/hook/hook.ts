import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { folderBrief, GOAL_CHANGED_LINE } from "../brief.ts";
import { noteTurn, readTurn, TURN_EVENTS } from "../commands/handover-turn.ts";
import {
  type ActivityKind,
  findAgentRoot,
  listProcesses,
} from "../daemon/activity.ts";
import { type KeyStore, openKeyStore } from "../daemon/keys.ts";
import { defaultStateDir } from "../daemon/main.ts";
import { readToken, request, socketPath } from "../daemon/socket.ts";
import { upgradeFolderWake } from "../hosts/claude-code.ts";
import { upgradeUserScopeWake } from "../hosts/user-scope.ts";
import { type Route, resolveRoute } from "../resolve.ts";
import {
  claudeContextOutput,
  formatNotice,
  type HookHost,
  stopOutput,
} from "./notice.ts";
import {
  EDIT_TOOLS,
  formatDelta,
  formatHeadsUp,
  formatOverlap,
  formatPeers,
  type PeerSnapshot,
  patchPaths,
  peerSnapshot,
  peersChanged,
} from "./peers.ts";
import { dropWaiter, waitForWake } from "./wake-wait.ts";

/** Hard budget for the whole hook (spec 16 §3.1: exits within 300 ms). */
export const HOOK_BUDGET_MS = 250;
export const MAX_STOP_CONTINUATIONS = 3;
/** At most one "Hawl update" per session in this window. */
export const PEERS_UPDATE_GAP_MS = 60_000;
/** Not a host event: the background waiter Claude Code runs on SessionStart and Stop. */
export const WAKE_EVENT = "Wake";

export interface HookInput {
  session_id?: string;
  stop_hook_active?: boolean;
  cwd?: string;
  tool_name?: string;
  /** Read only to build a short target. Never forwarded as is. */
  tool_input?: Record<string, unknown>;
  agent_id?: string;
  agent_type?: string;
  /** Claude Code: one id per tool call, so the same event from two hook scopes dedupes. */
  tool_use_id?: string;
  /** UserPromptSubmit. Hashed for dedupe and matched against the handover test marker only; never stored or sent. */
  prompt?: string;
  /** SessionStart: startup, resume, clear, compact. */
  source?: string;
  /** Notification: `permission_prompt` when Claude Code asks before running something. */
  notification_type?: string;
  /** The session's transcript file (Claude Code and Codex): the refusal watcher reads its end. */
  transcript_path?: string;
}

/**
 * Where the hook was installed. `user` is the machine-wide copy (~/.claude/settings.json,
 * ~/.codex/config.toml), which runs for every session on the machine: it stays silent outside a
 * joined folder and gives way to a project copy of the same event.
 */
export type HookScope = "project" | "user";

export interface HookDeps {
  stateDir?: string;
  /** Relay base URL for the stateless fallback. */
  relayUrl?: string;
  /** AgentToken for `GET /v1/inbox?limit=0`. */
  agentToken?: string;
  /** No env token: mint one from the worker key in the keychain. Returns undefined when it cannot. */
  mintToken?: (relayUrl?: string) => Promise<MintedToken | undefined>;
  fetch?: typeof fetch;
  budgetMs?: number;
  scope?: HookScope;
  /** The session's folder, site and worker; resolved from `cwd` when not given. */
  route?: Route | null;
  /** Who asks: the host session (its terminal's agent) and, inside a subagent, its id. */
  actor?: { session_id?: string; agent_id?: string };
  /** SessionStart: ask the daemon for open work and a waiting handover too (relay read). */
  extras?: boolean;
}

/**
 * The session fields every daemon call carries next to the folder's id: the daemon then acts as
 * that session's own agent (terminal or subagent), never as the folder (daemon hookActor).
 */
function sessionFields(deps: HookDeps): Record<string, unknown> {
  const a = deps.actor;
  if (!a?.session_id) return {};
  const pid = claudePid("claude_code");
  return {
    host_session_id: a.session_id,
    ...(a.agent_id && { agent_id: a.agent_id }),
    ...(pid && { claude_pid: pid }),
  };
}

export interface MintedToken {
  relayUrl: string;
  token: string;
}

export interface Counts {
  unread: number;
  /** Unread mail aimed at this agent (not a site or room broadcast). Drives Stop and PostToolUse. */
  aimed: number;
  /** Open work orders waiting on this worker. Only the relay's HTTP read carries it; absent from an older relay. */
  openWork?: number;
  /** An unconsumed handover waits for this worker. Only the relay's HTTP read carries it. */
  handover?: boolean;
  /** A role pack revision waits unread. Same source as handover. */
  roleBrief?: boolean;
  /** Token that moves when the site or yard main goal changes. Compared, never printed. */
  goalRev?: string;
  /** The agent the daemon counted for (this session's own); absent without the daemon. */
  as?: string;
}

function countsFrom(v: unknown): Counts | undefined {
  const r = v as {
    unread?: unknown;
    aimed?: unknown;
    open_work?: unknown;
    handover?: unknown;
    role_brief?: unknown;
    goal_rev?: unknown;
    as?: unknown;
  } | null;
  if (typeof r?.unread !== "number") return undefined;
  return {
    unread: r.unread,
    aimed: typeof r.aimed === "number" ? r.aimed : 0,
    ...(typeof r.open_work === "number" && { openWork: r.open_work }),
    ...(typeof r.handover === "boolean" && { handover: r.handover }),
    ...(typeof r.role_brief === "boolean" && { roleBrief: r.role_brief }),
    ...(typeof r.goal_rev === "string" && { goalRev: r.goal_rev }),
    ...(typeof r.as === "string" && { as: r.as }),
  };
}

async function viaDaemon(
  stateDir: string,
  ms: number,
  residentId: string | undefined,
  deps: HookDeps,
): Promise<Counts | undefined> {
  const token = readToken(stateDir);
  if (!token) return undefined;
  // Counts for this session's worker only; without a route, every worker on the machine.
  // With the session (and subagent) named, the daemon counts that terminal's own agent too.
  const r = await request(
    socketPath(stateDir),
    {
      op: "notice",
      token,
      ...(residentId && { resident_id: residentId, ...sessionFields(deps) }),
      ...(residentId && deps.extras && { extras: true }),
    },
    ms,
  );
  return r.ok ? countsFrom(r.result) : undefined;
}

/**
 * The main-goal token of this session's own agent, from the daemon, on its own short deadline:
 * a slow relay costs only the goal line, never the unread notice.
 */
async function readGoalRev(
  stateDir: string,
  deps: HookDeps,
): Promise<string | undefined> {
  const rid = deps.route?.resident_id;
  const token = readToken(stateDir);
  if (!rid || !token) return undefined;
  try {
    const r = await request(
      socketPath(stateDir),
      { op: "goal", token, resident_id: rid, ...sessionFields(deps) },
      deps.budgetMs ?? HOOK_BUDGET_MS,
    );
    if (!r.ok) return undefined;
    const rev = (r.result as { goal_rev?: unknown } | undefined)?.goal_rev;
    return typeof rev === "string" ? rev : undefined;
  } catch {
    return undefined;
  }
}

/** No daemon: stateless HTTP read of the count. No WebSocket is ever opened. */
async function viaRelay(
  deps: HookDeps,
  ms: number,
): Promise<Counts | undefined> {
  let relayUrl = deps.relayUrl;
  let token = deps.agentToken;
  if (!relayUrl || !token) {
    const m = await deps.mintToken?.(relayUrl);
    if (!m) return undefined;
    relayUrl = m.relayUrl;
    token = m.token;
  }
  const url = new URL("/v1/inbox", relayUrl);
  url.searchParams.set("limit", "0");
  const res = await (deps.fetch ?? fetch)(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) return undefined;
  // The relay count has no sender or room data, so nothing here is known to be aimed.
  return countsFrom(await res.json());
}

export async function readUnread(deps: HookDeps = {}): Promise<number> {
  return (await readCounts(deps)).unread;
}

export function readCounts(deps: HookDeps = {}): Promise<Counts> {
  const ms = deps.budgetMs ?? HOOK_BUDGET_MS;
  // One deadline for daemon plus fallback together, so the hook stays inside its budget.
  return Promise.race([
    readCountsUnbounded(deps),
    new Promise<Counts>((resolve) =>
      setTimeout(() => resolve({ unread: 0, aimed: 0 }), ms).unref(),
    ),
  ]);
}

async function readCountsUnbounded(deps: HookDeps): Promise<Counts> {
  const none = { unread: 0, aimed: 0 };
  const stateDir = deps.stateDir ?? defaultStateDir();
  const ms = deps.budgetMs ?? HOOK_BUDGET_MS;
  try {
    const d = await viaDaemon(stateDir, ms, deps.route?.resident_id, deps);
    if (d !== undefined) return d;
  } catch {
    // daemon not running: fall through to the stateless read
  }
  try {
    return (await viaRelay(deps, ms)) ?? none;
  } catch {
    return none;
  }
}

/**
 * SessionStart only: the daemon's notice has no work-order count or handover flag, so ask the
 * relay once. One read, no retry, inside what is left of the hook's shared deadline; any failure
 * or timeout skips both lines.
 */
async function readRelayExtras(
  deps: HookDeps,
  leftMs: number,
): Promise<Counts | undefined> {
  if (leftMs <= 0) return undefined;
  return Promise.race([
    viaRelay(deps, leftMs).catch(() => undefined),
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), leftMs).unref(),
    ),
  ]);
}

/** Session starts that begin with an empty context: a waiting handover is worth reading there. */
const PICKUP_SOURCES = new Set(["clear", "startup", "compact"]);

/** The "others now" block from the daemon's cached `who`. "" on any failure or without a worker. */
async function readWho(
  stateDir: string,
  deps: HookDeps,
  nowait = false,
): Promise<unknown> {
  const rid = deps.route?.resident_id;
  if (!rid) return null;
  try {
    const token = readToken(stateDir);
    if (!token) return null;
    const r = await request(
      socketPath(stateDir),
      {
        op: "peers",
        token,
        resident_id: rid,
        ...sessionFields(deps),
        ...(nowait && { nowait }),
      },
      deps.budgetMs ?? HOOK_BUDGET_MS,
    );
    return r.ok ? (r.result as { who?: unknown }).who : null;
  } catch {
    return null;
  }
}

/** What this session was last told about the other agents, and when. */
function peersFile(stateDir: string, sessionId: string | undefined) {
  return sessionId && SAFE_SESSION.test(sessionId)
    ? join(stateDir, "hook-peers", sessionId)
    : null;
}

function readTold(
  file: string,
): { at: number; snap: PeerSnapshot } | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeTold(file: string, snap: PeerSnapshot, now = Date.now()): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ at: now, snap }), { mode: 0o600 });
  } catch {
    // best effort: at worst the next call tells again
  }
}

/**
 * The others-now line for SessionStart (always) and UserPromptSubmit (only when the picture
 * changed since this session was last told). Records what it told.
 */
async function peersLine(
  event: string,
  stateDir: string,
  input: HookInput,
  deps: HookDeps,
): Promise<string> {
  const who = await readWho(stateDir, deps);
  const snap = peerSnapshot(who);
  const file = peersFile(stateDir, input.session_id);
  if (file && snap) {
    const told = readTold(file);
    writeTold(file, snap);
    if (event === "UserPromptSubmit" && told && !peersChanged(told.snap, snap))
      return "";
  }
  return formatPeers(who);
}

/**
 * The main-goal line: what this session was last told is a token in hook-goal/<session>[.<agent>].
 * A start records it quietly (never over a record: a resume keeps a pending change). A prompt whose
 * token differs says the one fixed line. The record is only written by `commit`, which the caller
 * runs once the line is part of what gets printed. A start that could not read the token records
 * "?" (baseline unknown): the next prompt that can read it says the line, so a stalled read never
 * loses the announcement. No record on a prompt (a session from before this) just records.
 */
function goalLine(
  event: string,
  stateDir: string,
  input: HookInput,
  rev: string | undefined,
): { line: string; commit: () => void } {
  const none = { line: "", commit: () => {} };
  const sid = input.session_id;
  if (!sid || !SAFE_SESSION.test(sid)) return none;
  // One record per agent: a subagent shares the host's session id but hears the change itself.
  const who =
    input.agent_id && SAFE_SESSION.test(input.agent_id)
      ? `${sid}.${input.agent_id}`
      : sid;
  const file = join(stateDir, "hook-goal", who);
  let told: string | undefined;
  try {
    told = readFileSync(file, "utf8");
  } catch {
    // never recorded
  }
  const write = (v: string) => () => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, v, { mode: 0o600 });
    } catch {
      // cannot record: at worst the next prompt says it again
    }
  };
  const start = event === "SessionStart";
  if (rev === undefined)
    return start && told === undefined
      ? { line: "", commit: write("?") }
      : none;
  if (told === rev) return none;
  if (told === undefined) return { line: "", commit: write(rev) };
  if (start) return none;
  return { line: GOAL_CHANGED_LINE, commit: write(rev) };
}

/**
 * Mid-task update (PostToolUse): only what changed since this session was last told, at most
 * once per 60 s, from the daemon's cache. The first call of a session just records the picture.
 */
async function peersDelta(
  stateDir: string,
  input: HookInput,
  deps: HookDeps,
  now = Date.now(),
): Promise<string> {
  const file = peersFile(stateDir, input.session_id);
  if (!file) return "";
  const snap = peerSnapshot(await readWho(stateDir, deps, true));
  if (!snap) return ""; // cold or stale cache: no answer is not "everyone left"
  const told = readTold(file);
  if (!told) {
    writeTold(file, snap, now);
    return "";
  }
  if (!peersChanged(told.snap, snap) || now - told.at < PEERS_UPDATE_GAP_MS)
    return "";
  writeTold(file, snap, now);
  return formatDelta(told.snap, snap);
}

/**
 * Before a file edit: does another online agent's `watching` glob match this path? The daemon
 * tells that agent (a normal Hawl message); this returns the note for this agent's context.
 * Tell-only: nothing here ever blocks the edit.
 */
async function overlapNote(
  stateDir: string,
  input: HookInput,
  deps: HookDeps,
): Promise<string> {
  const rid = deps.route?.resident_id;
  const tool = input.tool_name;
  if (!rid || !tool) return "";
  // Claude Code edit tools carry one path; Codex edits through apply_patch carry a patch text.
  const paths = EDIT_TOOLS.has(tool)
    ? [shortTarget(input)]
    : tool === "apply_patch"
      ? patchPaths(input.tool_input?.command, input.cwd)
      : [];
  try {
    const token = readToken(stateDir);
    if (!token) return "";
    const notes = await Promise.all(
      paths
        .filter((p): p is string => !!p)
        .map(async (path) => {
          const r = await request(
            socketPath(stateDir),
            {
              op: "overlap",
              token,
              resident_id: rid,
              ...sessionFields(deps),
              path,
            },
            deps.budgetMs ?? HOOK_BUDGET_MS,
          );
          if (!r.ok) return "";
          const res = r.result as { hits?: never[]; recent?: never[] };
          return [
            formatOverlap(res.hits ?? [], path),
            formatHeadsUp(res.recent ?? [], path),
          ]
            .filter(Boolean)
            .join(" ");
        }),
    );
    return notes.filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

const ACTIVITY_EVENTS: Record<string, ActivityKind> = {
  SessionStart: "session_start",
  SessionEnd: "session_stop",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  PreToolUse: "tool_before",
  PostToolUse: "tool_after",
};
/** Events that only report. They print nothing and never read the inbox. */
const REPORT_ONLY = new Set(["SessionEnd", "SubagentStart", "SubagentStop"]);

/** Short target for the activity line: a path relative to cwd, or the program name of a command. */
export function shortTarget(input: HookInput): string | undefined {
  const ti = input.tool_input;
  if (!ti || typeof ti !== "object") return undefined;
  // Codex edits through apply_patch: the first file of the patch is the target.
  if (input.tool_name === "apply_patch")
    return patchPaths(ti.command, input.cwd)[0]?.slice(0, 100);
  const p = ti.file_path ?? ti.path ?? ti.notebook_path;
  if (typeof p === "string" && p) {
    const rel = input.cwd && isAbsolute(p) ? relative(input.cwd, p) || p : p;
    return rel.split("\\").join("/").slice(0, 100);
  }
  if (typeof ti.command === "string") {
    // Program name only: arguments can hold secrets (`login <token>`). Leading VAR=value words are skipped.
    const first = ti.command
      .trim()
      .split(/\s+/)
      .find((w) => w && !w.includes("="));
    if (!first || first.startsWith("-") || /[\\/]/.test(first))
      return undefined;
    return first.slice(0, 60);
  }
  return undefined;
}

function claudePid(host: HookHost): number | undefined {
  const n = Number(process.env.CLAUDE_PID);
  return host === "claude_code" && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** A Hawl MCP tool in Claude Code: the project server or the plugin's. */
const HAWL_TOOL = /^mcp__(?:plugin_[A-Za-z0-9_-]+_)?hawl__[a-z_]+$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A Hawl tool called inside a Claude Code subagent: add the subagent's id, so the terminal's MCP
 * server acts as the subagent's own agent (it strips the field). Claude Code passes
 * `updatedInput` on to the MCP server as is (probed 2026-10-21, Claude Code 2.1.301).
 * `allow` skips only the prompt; deny and ask rules still apply (code.claude.com/docs/en/hooks).
 */
function subagentToolInput(input: HookInput): string {
  if (
    !input.agent_id ||
    !AGENT_ID.test(input.agent_id) ||
    !HAWL_TOOL.test(input.tool_name ?? "") ||
    !input.tool_input ||
    typeof input.tool_input !== "object"
  )
    return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...input.tool_input, hawl_agent: input.agent_id },
    },
  });
}

/** SubagentStart and SubagentStop: the daemon opens or ends the subagent's own agent. */
async function subagentOp(
  event: string,
  input: HookInput,
  deps: HookDeps,
): Promise<void> {
  if (!deps.route || !input.session_id || !AGENT_ID.test(input.agent_id ?? ""))
    return;
  try {
    const stateDir = deps.stateDir ?? defaultStateDir();
    const token = readToken(stateDir);
    if (!token) return;
    await request(
      socketPath(stateDir),
      {
        op: event === "SubagentStart" ? "subagent_open" : "subagent_close",
        token,
        resident_id: deps.route.resident_id,
        host_session_id: input.session_id,
        agent_id: input.agent_id,
        ...(input.agent_type && { agent_type: input.agent_type }),
        // After /clear the hooks report a new session id: the daemon finds the terminal by pid.
        ...(claudePid("claude_code") && {
          claude_pid: claudePid("claude_code"),
        }),
      },
      // The close waits for the relay: a little longer than the usual budget.
      event === "SubagentStop" ? 2_000 : (deps.budgetMs ?? HOOK_BUDGET_MS),
    );
  } catch {
    // Best effort: without it the subagent's calls act as its terminal.
  }
}

/** The agent's own one-line reason for a Bash or Monitor call: its `description`, never the command. */
export function reasonOf(input: HookInput): string | undefined {
  const d = input.tool_input?.description;
  if (input.tool_name !== "Bash" && input.tool_name !== "Monitor")
    return undefined;
  if (typeof d !== "string") return undefined;
  return (
    d
      .replace(/[\u0000-\u001f]/g, " ")
      .trim()
      .slice(0, 120) || undefined
  );
}

const PROGRAM_ALIAS: Record<string, string[]> = {
  npm: ["node"],
  npx: ["node"],
  pnpm: ["node"],
  yarn: ["node"],
  tsx: ["node"],
  python3: ["python"],
  py: ["python"],
};

/**
 * Program names in a command: the first word of each `&&`, `;`, `|` part, no arguments. The
 * daemon matches them to process names to link the agent's reason to the process it started.
 */
export function programsOf(input: HookInput): string[] {
  const cmd = input.tool_input?.command;
  if (typeof cmd !== "string") return [];
  const out = new Set<string>();
  for (const part of cmd.split(/&&|\|\||[;|\n]/).slice(0, 8)) {
    const w = part
      .trim()
      .split(/\s+/)
      .find((x) => x && !x.includes("="));
    if (!w) continue;
    const base = (w.split(/[\\/]/).pop() ?? "").toLowerCase();
    const ext = /\.(sh|py|js|mjs|ts)$/.exec(base)?.[1];
    const stem = base.replace(/\.[a-z]+$/, "");
    if (ext === "sh") out.add("bash").add("sh");
    else if (ext) out.add(ext === "py" ? "python" : "node");
    else if (stem) for (const n of PROGRAM_ALIAS[stem] ?? [stem]) out.add(n);
  }
  return [...out].slice(0, 12);
}

/**
 * The agent process above this hook. The hook's own parent is a shell (sh, bash) that exits in
 * milliseconds, so the walk has to happen here while the chain is alive. Once per session;
 * 4 s at most, then the plain parent.
 */
async function agentPid(host: HookHost): Promise<number> {
  const all = await Promise.race([
    listProcesses(),
    new Promise<[]>((r) => setTimeout(() => r([]), 4000).unref()),
  ]);
  return findAgentRoot(all, process.ppid, host);
}

/** One line to the daemon socket. Never throws; the caller bounds it by the hook budget. */
export async function reportActivity(
  host: HookHost,
  event: string,
  input: HookInput,
  deps: HookDeps = {},
): Promise<boolean> {
  const kind = ACTIVITY_EVENTS[event];
  if (!kind) return false;
  try {
    const stateDir = deps.stateDir ?? defaultStateDir();
    const token = readToken(stateDir);
    if (!token) return false;
    const tool =
      typeof input.tool_name === "string" ? input.tool_name : undefined;
    const r = await request(
      socketPath(stateDir),
      {
        op: "activity",
        token,
        line: {
          kind,
          host,
          session_id: input.session_id,
          agent_id: input.agent_id,
          agent_type: input.agent_type,
          tool,
          target: tool ? shortTarget(input) : undefined,
          reason: kind === "tool_before" ? reasonOf(input) : undefined,
          // Not forwarded: the daemon uses it to link the reason to a process.
          programs: kind === "tool_before" ? programsOf(input) : undefined,
          // The host process that ran this hook: the daemon polls its child tree.
          agent_pid:
            kind === "session_start" ? await agentPid(host) : undefined,
          // Claude Code gives hooks CLAUDE_PID: the daemon pairs `--continue` with it.
          claude_pid: claudePid(host),
        },
        // Routing: the daemon sends this line over this worker's connection, to its site.
        ...(deps.route && {
          resident_id: deps.route.resident_id,
          root: deps.route.root,
        }),
      },
      deps.budgetMs ?? HOOK_BUDGET_MS,
    );
    return r.ok;
  } catch {
    return false;
  }
}

const SAFE_SESSION = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A host stopped at a permission question: the daemon sets the session's status line to WAITING_LINE, which the relay already
 * carries, so the owner and the teammate who asked see it. The question is marked by:
 * - `PermissionRequest` (Claude Code and Codex): runs the moment the dialog is about to show (code.claude.com/docs/en/hooks, "PermissionRequest":
 *   "Use this event when you need a signal the moment Claude asks"; learn.chatgpt.com/docs/hooks, "PermissionRequest").
 * - Claude's Notification `permission_prompt`: only after the prompt has waited about six seconds, and only while the owner has not typed.
 *   It stays for what PermissionRequest never fires for (a sandboxed command's network request) and for a copy that lacks the new hook.
 * Neither host has an event for the answer, so the mark ends at the session's next hook event that shows the agent went on or stopped.
 */
const WAIT_ENDS = new Set([
  "SessionStart", // the session came back (resume) with its mark left from before
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure", // the approved command failed (Claude)
  "PermissionDenied", // auto mode refused the call (Claude)
  "UserPromptSubmit",
  "Stop",
  "StopFailure", // the turn ended on an API error (Claude)
  "Interrupt", // the person interrupted the turn (Codex, learn.chatgpt.com/docs/hooks "Interrupt")
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
]);
/** Events after which the session is idle, not busy. */
const WAIT_ENDS_IDLE = new Set(["Stop", "StopFailure", "Interrupt", "SessionEnd"]);
/** Events that show the agent is at work even when no question came up: the first of a turn marks it busy (the agent seldom does itself). */
const WORK_STARTS = new Set(["UserPromptSubmit", "PreToolUse"]);
/** A `permission_prompt` notification this soon after a PermissionRequest of the same session is that question's late echo. */
const NOTIFY_ECHO_MS = 30_000;

function waitFile(stateDir: string, input: HookInput): string | null {
  const sid = input.session_id;
  if (!sid || !SAFE_SESSION.test(sid)) return null;
  const sub =
    input.agent_id && AGENT_ID.test(input.agent_id) ? `.${input.agent_id}` : "";
  return join(stateDir, "hook-wait", sid + sub);
}

/** True when the daemon took it. False when it was unreachable or had no worker for the session: the caller keeps the mark. */
async function waitOp(
  on: boolean,
  idle: boolean,
  host: HookHost,
  input: HookInput,
  deps: HookDeps,
  stateDir: string,
): Promise<boolean> {
  if (!deps.route) return false;
  try {
    const token = readToken(stateDir);
    if (!token) return false;
    const r = await request(
      socketPath(stateDir),
      {
        op: "wait",
        token,
        resident_id: deps.route.resident_id,
        root: deps.route.root,
        host_session_id: input.session_id,
        ...(input.agent_id && { agent_id: input.agent_id }),
        ...(claudePid(host) && { claude_pid: claudePid(host) }),
        on,
        idle,
      },
      deps.budgetMs ?? HOOK_BUDGET_MS,
    );
    return r.ok && (r.result as { ok?: boolean } | undefined)?.ok !== false;
  } catch {
    return false; // best effort: without it the session just shows its usual status
  }
}

async function waitMark(
  event: string,
  host: HookHost,
  stateDir: string,
  input: HookInput,
  deps: HookDeps,
): Promise<void> {
  const file = waitFile(stateDir, input);
  const asked = event === "PermissionRequest";
  if (
    !file ||
    !deps.route ||
    !(asked || input.notification_type === "permission_prompt")
  )
    return;
  const echo = `${file}.asked`;
  try {
    mkdirSync(join(stateDir, "hook-wait"), { recursive: true, mode: 0o700 });
    if (!asked && Date.now() - statSync(echo).mtimeMs < NOTIFY_ECHO_MS) return;
  } catch {
    // no earlier PermissionRequest (or no state dir yet): a notification is the only signal
  }
  try {
    // The mark holds where the transcript ended when the question came up: the watcher starts a moment later and must not miss a refusal that is already in.
    let at = "1";
    try {
      // A notification alone (a sandboxed command's network question) marks the same way: it only fires once the question is already up.
      if (input.transcript_path) at = String(statSync(input.transcript_path).size);
    } catch {
      // no transcript yet: the watcher takes its own start
    }
    // The time makes each question's mark different, so a watcher can tell its own question from a later one.
    writeFileSync(file, `${at}:${Date.now()}`, { mode: 0o600 });
    if (asked) writeFileSync(echo, "1", { mode: 0o600 });
  } catch {
    return; // no mark, so nothing could end it: set nothing
  }
  await waitOp(true, false, host, input, deps, stateDir);
}

/** The mark goes only once the clear went through, so a failed one is tried again at the session's next hook event. */
async function waitClear(
  event: string,
  host: HookHost,
  stateDir: string,
  input: HookInput,
  deps: HookDeps,
  /** A Stop this hook itself turned into "keep going" (new mail): the turn is not over, so it must not read idle. */
  blocked = false,
): Promise<void> {
  if (!WAIT_ENDS.has(event)) return;
  const file = waitFile(stateDir, input);
  if (!file) return;
  const idle = WAIT_ENDS_IDLE.has(event) && !blocked;
  const went = `${file}.went`;
  // The answer already set busy and removed the mark; this turn's end still has to set idle, which the agent itself never does here.
  if (!existsSync(file)) {
    if (idle && existsSync(went) && (await waitOp(false, true, host, input, deps, stateDir)))
      rmSync(went, { force: true });
    // No question, but the turn is on: busy once (the Stop ends it), never from a subagent's own events.
    else if (WORK_STARTS.has(event) && !input.agent_id && !existsSync(went) && (await waitOp(false, false, host, input, deps, stateDir))) {
      try {
        mkdirSync(join(stateDir, "hook-wait"), { recursive: true, mode: 0o700 });
        writeFileSync(went, "1", { mode: 0o600 });
      } catch {
        // no marker: busy is sent again at the next prompt or tool
      }
    }
    return;
  }
  const done = await waitOp(false, idle, host, input, deps, stateDir);
  // A session that ended has no later event to retry at.
  if (done || event === "SessionEnd") {
    rmSync(file, { force: true });
    if (done && !idle) writeFileSync(went, "1", { mode: 0o600 });
    else rmSync(went, { force: true });
  }
}

/** Runs as an async hook next to PermissionRequest, so nothing waits for it (code.claude.com/docs/en/hooks, "Run hooks in the background"). */
export const WAIT_WATCH_EVENT = "WaitWatch";
/** The text of the entry Claude Code writes into the transcript when the owner answers a question with Esc or No (seen in 2.1.318; not a documented format). */
const REFUSED = /^\[Request interrupted by user( for tool use)?\]$/;
const WATCH_MAX_MS = 6 * 3_600_000;
/** How long the watcher keeps trying a clear the daemon did not take. */
const CLEAR_RETRY_MS = 60_000;

/** One transcript line is the user entry Claude writes for a refusal: not a tool result, a file's text, an assistant line or a request blob that holds the phrase. */
export function isRefusalEntry(raw: string): boolean {
  let e: { type?: unknown; message?: { content?: unknown } } | null;
  try {
    e = JSON.parse(raw);
  } catch {
    return false;
  }
  const c = e?.type === "user" ? e.message?.content : undefined;
  return (
    Array.isArray(c) &&
    c.some((p) => p?.type === "text" && typeof p.text === "string" && REFUSED.test(p.text.trim()))
  );
}

function alive(pid: number | undefined): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Claude Code fires no hook when the owner refuses a question: Esc and "No" both leave the session silent until the next prompt,
 * even Notification `idle_prompt` stays away (measured 2026-11-05, 2.1.318). The transcript does get a line within half a second,
 * so this watches it from the moment of the question, and only what was written after the mark. True when it ended the waiting.
 * It stops when the mark is gone (an ordinary event cleared it), when a later question marked again (that one has its own watcher),
 * when Claude is gone, or after six hours. A clear the daemon does not take is tried again for a minute.
 */
export async function watchRefusal(
  input: HookInput,
  deps: HookDeps & { pollMs?: number; maxMs?: number; clearMs?: number } = {},
): Promise<boolean> {
  const stateDir = deps.stateDir ?? defaultStateDir();
  const file = waitFile(stateDir, input);
  const path = input.transcript_path;
  if (!file || !path || !deps.route) return false;
  const pause = () => new Promise((r) => setTimeout(r, deps.pollMs ?? 1000));
  const markNow = () => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  // The sync PermissionRequest hook runs beside this one: wait for its mark, which holds the transcript offset of the question.
  for (let i = 0; i < 100 && !existsSync(file); i++)
    await new Promise((r) => setTimeout(r, 50));
  const mark = markNow();
  if (mark === null) return false;
  // One watcher per question: a PermissionRequest and its notification both start one.
  const claim = `${file}.watch`;
  try {
    writeFileSync(claim, mark, { flag: "wx", mode: 0o600 });
  } catch {
    try {
      if (readFileSync(claim, "utf8") === mark) return false;
      writeFileSync(claim, mark, { mode: 0o600 });
    } catch {
      return false;
    }
  }
  try {
    let from: number;
    try {
      const marked = Number(mark.split(":")[0]);
      from = marked > 1 ? marked : statSync(path).size;
    } catch {
      return false;
    }
    const pid = claudePid("claude_code");
    const end = Date.now() + (deps.maxMs ?? WATCH_MAX_MS);
    let pending = Buffer.alloc(0);
    while (Date.now() < end && alive(pid)) {
      if (markNow() !== mark) return false; // answered by an ordinary event, or a later question took over
      try {
        const size = statSync(path).size;
        if (size > from) {
          const buf = Buffer.alloc(Math.min(size - from, 1 << 20));
          const fd = openSync(path, "r");
          try {
            readSync(fd, buf, 0, buf.length, from);
          } finally {
            closeSync(fd);
          }
          from += buf.length;
          // Only whole lines: the last one may still be being written.
          pending = Buffer.concat([pending, buf]);
          const cut = pending.lastIndexOf(10);
          const done = cut < 0 ? "" : pending.subarray(0, cut).toString("utf8");
          if (cut >= 0) pending = pending.subarray(cut + 1);
          if (done.split("\n").some(isRefusalEntry))
            return await clearUntilDone(file, mark, markNow, pause, stateDir, input, deps);
        }
      } catch {
        return false;
      }
      await pause();
    }
    return false;
  } finally {
    rmSync(claim, { force: true });
  }
}

/** The daemon did not take the clear (busy, restarting): try again until it does, the mark is gone or the time is up. */
async function clearUntilDone(
  file: string,
  mark: string,
  markNow: () => string | null,
  pause: () => Promise<unknown>,
  stateDir: string,
  input: HookInput,
  deps: HookDeps & { clearMs?: number },
): Promise<boolean> {
  const stop = Date.now() + (deps.clearMs ?? CLEAR_RETRY_MS);
  // Nothing waits for this async hook, so it may take longer than the 250 ms the other hooks get.
  const d = { ...deps, budgetMs: deps.budgetMs ?? 2000 };
  while (markNow() === mark && Date.now() < stop) {
    await waitClear("Interrupt", "claude_code", stateDir, input, d);
    if (!existsSync(file)) return true;
    await pause();
  }
  return markNow() === null;
}

function stopCountFile(stateDir: string, sessionId: string): string | null {
  if (!SAFE_SESSION.test(sessionId)) return null;
  return join(stateDir, "hook-stop", sessionId);
}

/**
 * The unread count this agent was last told about (any event), for the PostToolUse rule. A
 * subagent shares its terminal's session id but has its own mailbox, so it has its own count.
 */
function seenFile(stateDir: string, input: HookInput): string | null {
  const sid = input.session_id;
  if (!sid || !SAFE_SESSION.test(sid)) return null;
  const sub =
    input.agent_id && AGENT_ID.test(input.agent_id) ? `.${input.agent_id}` : "";
  return join(stateDir, "hook-seen", sid + sub);
}

function writeSeen(stateDir: string, input: HookInput, unread: number): void {
  const file = seenFile(stateDir, input);
  if (!file) return;
  try {
    mkdirSync(join(stateDir, "hook-seen"), { recursive: true, mode: 0o700 });
    writeFileSync(file, String(unread), { mode: 0o600 });
  } catch {
    // best effort: at worst PostToolUse repeats one notice
  }
}

/**
 * Mid-task notice (PostToolUse): the same fixed template, only when the unread count rose
 * since this session was last told, so a long task sees new mail without a notice on every
 * tool call. A drop (the agent read its mail) is recorded too, so the next arrival shows.
 * Without a session id there is nothing to compare against, so nothing is printed.
 */
function postToolNotice(
  stateDir: string,
  input: HookInput,
  unread: number,
): string {
  const file = seenFile(stateDir, input);
  if (!file) return "";
  const last = readCount(file);
  if (unread !== last) writeSeen(stateDir, input, unread);
  if (unread <= last) return "";
  return formatNotice(unread);
}

function readCount(file: string): number {
  try {
    return existsSync(file) ? Number(readFileSync(file, "utf8")) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * Both a project copy and the machine-wide copy of the hook can run for one event. The first
 * to claim `<host, event, session, call>` acts; the other prints nothing and reports nothing.
 * Without a session id there is nothing to key on, so both act.
 */
export function claimEvent(
  stateDir: string,
  host: string,
  event: string,
  input: HookInput,
  now = Date.now(),
): boolean {
  if (!input.session_id) return true;
  const key = createHash("sha256")
    .update(
      [
        host,
        event,
        input.session_id,
        input.tool_use_id ?? "",
        input.agent_id ?? "",
        input.source ?? "",
        input.prompt ?? "",
        // Two notifications of different types inside the twin window are two events.
        input.notification_type ?? "",
      ].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 32);
  const dir = join(stateDir, "hook-once");
  const file = join(dir, key);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    closeSync(openSync(file, "wx", 0o600));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return true;
    try {
      // Twins run at the same moment. A claim older than 3 s is a real repeat (a second Stop
      // after another turn, a re-sent prompt), not a twin.
      if (now - statSync(file).mtimeMs > 3_000) {
        writeFileSync(file, "");
        return true;
      }
    } catch {
      return true;
    }
    return false;
  }
}

/**
 * Add the idle-wake waiter to settings joined before it existed. Never throws. True when this
 * session wrote it: Claude Code reloads the hooks, but the waiter first starts at this
 * session's next Stop, so the person is told (code.claude.com/docs/en/hooks: edits to hooks in
 * settings files are picked up by the file watcher).
 */
function upgradeWake(
  stateDir: string,
  route: Route | null | undefined,
): boolean {
  let upgraded = false;
  try {
    if (route && upgradeFolderWake(route.root, route.resident_id, stateDir))
      upgraded = true;
  } catch {
    // left as it was; the next session tries again
  }
  try {
    if (
      existsSync(join(stateDir, "user-scope.json")) &&
      upgradeUserScopeWake(stateDir)
    )
      upgraded = true;
  } catch {
    // same
  }
  return upgraded;
}

/** Shown to the person once, in the session that turned wake on for an older folder. */
export const WAKE_UPGRADED_NOTE =
  "Hawl: new messages for this agent now wake Claude Code while it sits idle. In this session that starts after your first message.";

/** Drop claims older than an hour. Run on SessionStart only, to keep other events fast. */
function sweepClaims(stateDir: string, now = Date.now()): void {
  const dir = join(stateDir, "hook-once");
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (now - statSync(p).mtimeMs > 3_600_000) rmSync(p, { force: true });
    }
  } catch {
    // nothing to sweep
  }
}

/**
 * What the hook prints for `hawl hook <host> <event>`. Empty string means print nothing.
 * `Stop` continues at most 3 times per session and never while `stop_hook_active` is set.
 */
export async function hookOutput(
  host: HookHost,
  event: string,
  input: HookInput = {},
  deps: HookDeps = {},
): Promise<string> {
  const stateDir = deps.stateDir ?? defaultStateDir();
  if (deps.route === undefined) {
    deps = {
      ...deps,
      route: resolveRoute(input.cwd ?? process.cwd(), { host }),
    };
  }
  // The machine-wide hook runs in every folder: outside a joined one it does nothing at all.
  if (deps.scope === "user" && !deps.route) return "";
  if (!deps.actor && input.session_id)
    deps = {
      ...deps,
      actor: { session_id: input.session_id, agent_id: input.agent_id },
    };
  // H25: this session's turns for `hawl handover clear`, which types only after the armed turn's
  // Stop. A turn start is counted first, before any dedupe or early return (a repeated prompt is
  // still a new turn); the Stop only below, once this hook knows whether it continues Claude.
  const turnRoot = deps.route?.root;
  const sid = input.session_id;
  const counts =
    host === "claude_code" && turnRoot && sid && TURN_EVENTS.has(event);
  // A Stop ends the turn it fired in: that turn's start count is read now, before any await, so a
  // turn started while this hook works stays running (judge j7).
  const seen =
    counts && event === "Stop"
      ? (readTurn(stateDir, turnRoot, sid)?.turn ?? 0)
      : undefined;
  const turn = (ev: string) => {
    if (counts)
      try {
        noteTurn(stateDir, turnRoot, sid, ev, Date.now(), seen);
      } catch {
        // no turn record: the clear step then types nothing
      }
  };
  if (event !== "Stop") turn(event);
  // Twins exist only once the machine-wide copy is installed (`~/.hawl/user-scope.json`).
  const twins =
    deps.scope === "user" || existsSync(join(stateDir, "user-scope.json"));
  if (twins && !claimEvent(stateDir, host, event, input)) return "";
  let upgraded = false;
  if (event === "SessionStart") {
    sweepClaims(stateDir);
    if (host === "claude_code") upgraded = upgradeWake(stateDir, deps.route);
  }
  if (event === "SessionEnd") dropWaiter(stateDir, input.session_id);
  // The waiting signal prints nothing and changes nothing else: a PermissionRequest hook with no output leaves the host's own question as it was.
  if (event === "PermissionRequest" || event === "Notification") {
    await waitMark(event, host, stateDir, input, deps);
    return "";
  }
  if (event === "PostToolUseFailure" || event === "PermissionDenied" || event === "StopFailure" || event === "Interrupt") {
    await waitClear(event, host, stateDir, input, deps);
    return "";
  }
  // A Stop that keeps the agent going (new mail) is not an end: its idle waits for the notice's answer.
  const [out] = await (event === "Stop"
    ? noticeFor(host, event, input, deps, stateDir, upgraded).then(async (o) => {
        await waitClear(event, host, stateDir, input, deps, o.includes('"decision":"block"'));
        return [o];
      })
    : Promise.all([
        noticeFor(host, event, input, deps, stateDir, upgraded),
        waitClear(event, host, stateDir, input, deps),
      ]));
  if (event === "Stop")
    turn(out.includes('"decision":"block"') ? "StopBlocked" : "Stop");
  return out;
}

/** hookOutput past the twins claim: what this event prints. */
async function noticeFor(
  host: HookHost,
  event: string,
  input: HookInput,
  deps: HookDeps,
  stateDir: string,
  upgraded: boolean,
): Promise<string> {
  const activity = reportActivity(host, event, input, deps);
  if (event === "PreToolUse" && host === "claude_code" && deps.route) {
    const tagged = subagentToolInput(input);
    if (tagged) {
      await activity;
      return tagged;
    }
  }
  // `hawl handover test`: a prompt that is exactly the test marker finishes the test (SPEC H27).
  if (
    event === "UserPromptSubmit" &&
    host === "claude_code" &&
    deps.route &&
    typeof input.prompt === "string" &&
    input.prompt.trim().startsWith("hawl-handover-test-")
  ) {
    const { hookMarker } = await import("../commands/handover-clear.ts");
    const note = hookMarker(stateDir, deps.route.root, input.prompt);
    if (note) {
      await activity;
      return claudeContextOutput(event, note);
    }
  }
  if (event === "PreToolUse") {
    const [note] = await Promise.all([
      overlapNote(stateDir, input, deps),
      activity,
    ]);
    // Both hosts read hookSpecificOutput.additionalContext on PreToolUse
    // (code.claude.com/docs/en/hooks, developers.openai.com/codex/hooks, checked 2026-10-21).
    return note ? claudeContextOutput(event, note) : "";
  }
  if (REPORT_ONLY.has(event)) {
    await Promise.all([
      activity,
      host === "claude_code" &&
        (event === "SubagentStart" || event === "SubagentStop") &&
        subagentOp(event, input, deps),
      // A subagent's first goal baseline is taken as it starts, so a change before its first prompt is heard.
      event === "SubagentStart" && host === "claude_code"
        ? (async () => {
            // Both reads run together, so the hook stays inside one budget.
            const [viaDaemon, counts] = await Promise.all([
              readGoalRev(stateDir, deps),
              readCounts(deps),
            ]);
            goalLine(
              "SessionStart",
              stateDir,
              input,
              viaDaemon ?? counts.goalRev,
            ).commit();
          })()
        : undefined,
    ]);
    return "";
  }
  // The off switch (`hawl config stop-hook off`) silences the notices that interrupt work.
  const interrupts = event === "PostToolUse" || event === "Stop";
  if (interrupts && deps.route?.town.stop_hook === false) {
    await activity;
    return "";
  }
  if (event === "PostToolUse") {
    // Daemon count only: no keychain token is minted on every tool call. Aimed mail only.
    const [{ aimed }, delta] = await Promise.all([
      readCounts({
        ...deps,
        relayUrl: undefined,
        agentToken: undefined,
        mintToken: undefined,
      }),
      peersDelta(stateDir, input, deps),
      activity,
    ]);
    const text = [postToolNotice(stateDir, input, aimed), delta]
      .filter(Boolean)
      .join(" ");
    // Both hosts read PostToolUse context from this JSON form (code.claude.com/docs/en/hooks,
    // learn.chatgpt.com/docs/hooks, checked 2026-10-15).
    return claudeContextOutput("PostToolUse", text);
  }
  const isStop = event === "Stop";
  if (isStop) {
    if (input.stop_hook_active === true) return "";
    if (!input.session_id) return "";
    const file = stopCountFile(stateDir, input.session_id);
    if (!file || readCount(file) >= MAX_STOP_CONTINUATIONS) return "";
  }
  const wantPeers = event === "SessionStart" || event === "UserPromptSubmit";
  const startedAt = Date.now();
  const [counts, peers, goalRev] = await Promise.all([
    readCounts(event === "SessionStart" ? { ...deps, extras: true } : deps),
    wantPeers ? peersLine(event, stateDir, input, deps) : "",
    event === "UserPromptSubmit" ? readGoalRev(stateDir, deps) : undefined,
    activity,
  ]);
  // The daemon answered for this session's own agent: never read the folder's facts instead.
  const extras =
    event === "SessionStart" &&
    counts.as === undefined &&
    (counts.openWork === undefined || counts.handover === undefined)
      ? await readRelayExtras(
          deps,
          (deps.budgetMs ?? HOOK_BUDGET_MS) - (Date.now() - startedAt),
        )
      : undefined;
  const openWork = counts.openWork ?? extras?.openWork;
  // Only the relay's boolean, and only for a start with an empty context (not resume, not unknown).
  const handover =
    PICKUP_SOURCES.has(input.source ?? "") &&
    (counts.handover ?? extras?.handover) === true;
  // Any session start: a resumed session may hold an older role brief too.
  const roleBrief = (counts.roleBrief ?? extras?.roleBrief) === true;
  // Stop continues the agent only for mail aimed at it; broadcasts still show in the other notices.
  const unread = isStop ? counts.aimed : counts.unread;
  // SessionStart always carries the brief (spec 16 §3.5: fixed template plus the unread integer),
  // so the agent knows its home base even with nothing waiting. No town file: the plain notice.
  const base =
    (event === "SessionStart"
      ? folderBrief(input.cwd ?? process.cwd(), {
          unread,
          openWork,
          handover,
          roleBrief,
          platform: host,
          residentId:
            counts.as ??
            deps.route?.resident_id ??
            process.env.HAWL_RESIDENT_ID,
        })
      : "") || formatNotice(unread);
  const goal =
    event === "SessionStart" || event === "UserPromptSubmit"
      ? goalLine(
          event,
          stateDir,
          input,
          goalRev ?? counts.goalRev ?? extras?.goalRev,
        )
      : { line: "", commit: () => {} };
  const notice = [base, peers, goal.line].filter(Boolean).join(" ");
  // Recorded only now that the line is part of what this hook prints.
  goal.commit();
  if (!notice) return "";
  writeSeen(stateDir, input, counts.aimed); // PostToolUse compares aimed counts
  if (isStop) {
    const file = stopCountFile(stateDir, input.session_id as string) as string;
    try {
      mkdirSync(join(stateDir, "hook-stop"), { recursive: true, mode: 0o700 });
      writeFileSync(file, String(readCount(file) + 1), { mode: 0o600 });
    } catch {
      return ""; // cannot count, so cannot bound: do not continue
    }
    return stopOutput(notice);
  }
  // Claude Code reads the JSON form. Codex UserPromptSubmit/SessionStart: plain stdout is added as developer context (verified 2026-10-10: learn.chatgpt.com/docs/hooks).
  if (host !== "claude_code") return notice;
  if (!upgraded) return claudeContextOutput(event, notice);
  return JSON.stringify({
    ...JSON.parse(claudeContextOutput(event, notice)),
    systemMessage: WAKE_UPGRADED_NOTE,
  });
}

const STDIN_WAIT_WAKE_MS = 5_000;

export async function readStdin(
  ms: number,
  stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
): Promise<HookInput> {
  if (stdin.isTTY) return {};
  return new Promise((resolve) => {
    let buf = "";
    const done = () => {
      try {
        resolve(JSON.parse(buf) as HookInput);
      } catch {
        resolve({});
      }
    };
    const t = setTimeout(done, ms);
    stdin.setEncoding("utf8");
    stdin.on("data", (c: string) => {
      buf += c;
    });
    stdin.on("end", () => {
      clearTimeout(t);
      done();
    });
    stdin.on("error", () => {
      clearTimeout(t);
      done();
    });
  });
}

/**
 * Fallback token for a hook with no daemon and no env token: the worker's key from the OS
 * keychain (service `hawl`) signs a client assertion that the relay swaps for a short AgentToken.
 * The worker comes from `HAWL_RESIDENT_ID`, else the only worker in `.hawl/hawl.json`.
 */
export function keychainMinter(
  cwd: string,
  stateDir: string,
  o: {
    fetch?: typeof fetch;
    keyStore?: KeyStore;
    ms?: number;
    host?: string;
  } = {},
): (relayUrl?: string) => Promise<MintedToken | undefined> {
  return async () => {
    // Same folder -> site -> worker rule as everything else (resolve.ts), from any subfolder.
    const route = resolveRoute(cwd, { host: o.host });
    if (!route) return undefined;
    const m = route.town.memberships.find((x) => x.town_id === route.town_id);
    const w = m?.workers.find((x) => x.resident_id === route.resident_id);
    if (!m || !w) return undefined;
    const pick = { m, w };
    const store =
      o.keyStore ??
      (await openKeyStore({
        stateDir,
        passphrase: process.env.HAWL_PASSPHRASE,
      }));
    const jwk = await store.get(pick.w.resident_id);
    if (!jwk) return undefined;
    const { clientAssertion } = await import("../commands/join.ts");
    const relayUrl = pick.m.relay_url;
    const res = await (o.fetch ?? fetch)(`${relayUrl}/v1/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_assertion: clientAssertion(
          pick.w.resident_id,
          pick.w.kid,
          jwk as Record<string, string>,
          relayUrl,
        ),
      }),
      signal: AbortSignal.timeout(o.ms ?? HOOK_BUDGET_MS),
    });
    if (!res.ok) return undefined;
    const { access_token } = (await res.json()) as { access_token?: string };
    return access_token ? { relayUrl, token: access_token } : undefined;
  };
}

/** `hawl hook ... --dir <folder>`: the Workstation joins into its own copy, not the repo Claude Code runs in. */
export function inDir(input: HookInput, dir?: string): HookInput {
  return dir ? { ...input, cwd: resolve(dir) } : input;
}

/**
 * `hawl hook <host> <event>`. Never throws, never blocks the host. Returns the exit code: 0,
 * or 2 from the `Wake` waiter (an `asyncRewake` hook) to wake an idle Claude Code session.
 */
export async function runHook(
  host: string,
  event: string,
  scope: HookScope = "project",
  dir?: string,
): Promise<number> {
  if (host !== "claude_code" && host !== "codex") return 0;
  // The other hooks sit inside a 300 ms budget. The waiter runs in the background and without the
  // session id it quits for good, so on a loaded machine it waits for Claude Code's input.
  const input = inDir(
    await readStdin(event === WAKE_EVENT || event === WAIT_WATCH_EVENT ? STDIN_WAIT_WAKE_MS : 50),
    dir,
  );
  if (event === WAIT_WATCH_EVENT) {
    if (host !== "claude_code") return 0;
    const route = resolveRoute(input.cwd ?? process.cwd(), { host });
    if (route) await watchRefusal(input, { route });
    return 0;
  }
  if (event === WAKE_EVENT) {
    if (host !== "claude_code") return 0;
    const route = resolveRoute(input.cwd ?? process.cwd(), { host });
    // The machine-wide copy stays silent outside a joined folder, like every other event.
    if (scope === "user" && !route) return 0;
    return waitForWake(input, { route });
  }
  const out = await hookOutput(host, event, input, {
    relayUrl: process.env.HAWL_RELAY_URL,
    agentToken: process.env.HAWL_AGENT_TOKEN,
    mintToken: keychainMinter(input.cwd ?? process.cwd(), defaultStateDir(), {
      host,
    }),
    scope,
  });
  if (out) process.stdout.write(`${out}\n`);
  return 0;
}

if (import.meta.main) {
  const [host, event] = process.argv.slice(2);
  runHook(host ?? "", event ?? "")
    .then((code) => process.exit(code))
    .catch(() => process.exit(0));
}
