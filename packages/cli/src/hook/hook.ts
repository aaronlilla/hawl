import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { folderBrief } from "../brief.ts";
import type { ActivityKind } from "../daemon/activity.ts";
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
  /** UserPromptSubmit. Hashed for dedupe only; never stored or sent. */
  prompt?: string;
  /** SessionStart: startup, resume, clear, compact. */
  source?: string;
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
}

export interface MintedToken {
  relayUrl: string;
  token: string;
}

export interface Counts {
  unread: number;
  /** Unread mail aimed at this agent (not a site or room broadcast). Drives Stop and PostToolUse. */
  aimed: number;
}

function countsFrom(v: unknown): Counts | undefined {
  const r = v as { unread?: unknown; aimed?: unknown } | null;
  if (typeof r?.unread !== "number") return undefined;
  return { unread: r.unread, aimed: typeof r.aimed === "number" ? r.aimed : 0 };
}

async function viaDaemon(
  stateDir: string,
  ms: number,
  residentId?: string,
): Promise<Counts | undefined> {
  const token = readToken(stateDir);
  if (!token) return undefined;
  // Counts for this session's worker only; without a route, every worker on the machine.
  const r = await request(
    socketPath(stateDir),
    { op: "notice", token, ...(residentId && { resident_id: residentId }) },
    ms,
  );
  return r.ok ? countsFrom(r.result) : undefined;
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
    const d = await viaDaemon(stateDir, ms, deps.route?.resident_id);
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
      { op: "peers", token, resident_id: rid, ...(nowait && { nowait }) },
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
            { op: "overlap", token, resident_id: rid, path },
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
          // The host process that ran this hook: the daemon polls its child tree.
          agent_pid: kind === "session_start" ? process.ppid : undefined,
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

function stopCountFile(stateDir: string, sessionId: string): string | null {
  if (!SAFE_SESSION.test(sessionId)) return null;
  return join(stateDir, "hook-stop", sessionId);
}

/** The unread count this session was last told about (any event), for the PostToolUse rule. */
function seenFile(stateDir: string, sessionId: string): string | null {
  if (!SAFE_SESSION.test(sessionId)) return null;
  return join(stateDir, "hook-seen", sessionId);
}

function writeSeen(stateDir: string, input: HookInput, unread: number): void {
  const file = input.session_id ? seenFile(stateDir, input.session_id) : null;
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
  const file = input.session_id ? seenFile(stateDir, input.session_id) : null;
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
  const activity = reportActivity(host, event, input, deps);
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
    await activity;
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
  const [counts, peers] = await Promise.all([
    readCounts(deps),
    wantPeers ? peersLine(event, stateDir, input, deps) : "",
    activity,
  ]);
  // Stop continues the agent only for mail aimed at it; broadcasts still show in the other notices.
  const unread = isStop ? counts.aimed : counts.unread;
  // SessionStart always carries the brief (spec 16 §3.5: fixed template plus the unread integer),
  // so the agent knows its home base even with nothing waiting. No town file: the plain notice.
  const base =
    (event === "SessionStart"
      ? folderBrief(input.cwd ?? process.cwd(), {
          unread,
          platform: host,
          residentId: deps.route?.resident_id ?? process.env.HAWL_RESIDENT_ID,
        })
      : "") || formatNotice(unread);
  const notice = [base, peers].filter(Boolean).join(" ");
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

/**
 * `hawl hook <host> <event>`. Never throws, never blocks the host. Returns the exit code: 0,
 * or 2 from the `Wake` waiter (an `asyncRewake` hook) to wake an idle Claude Code session.
 */
export async function runHook(
  host: string,
  event: string,
  scope: HookScope = "project",
): Promise<number> {
  if (host !== "claude_code" && host !== "codex") return 0;
  // The other hooks sit inside a 300 ms budget. The waiter runs in the background and without the
  // session id it quits for good, so on a loaded machine it waits for Claude Code's input.
  const input = await readStdin(event === WAKE_EVENT ? STDIN_WAIT_WAKE_MS : 50);
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
