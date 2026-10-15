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
import { isAbsolute, join, relative } from "node:path";
import { folderBrief } from "../brief.ts";
import type { ActivityKind } from "../daemon/activity.ts";
import { type KeyStore, openKeyStore } from "../daemon/keys.ts";
import { defaultStateDir } from "../daemon/main.ts";
import { readToken, request, socketPath } from "../daemon/socket.ts";
import { type Route, resolveRoute } from "../resolve.ts";
import {
  claudeContextOutput,
  formatNotice,
  type HookHost,
  stopOutput,
} from "./notice.ts";

/** Hard budget for the whole hook (spec 16 §3.1: exits within 300 ms). */
export const HOOK_BUDGET_MS = 250;
export const MAX_STOP_CONTINUATIONS = 3;

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

function unreadFromCounts(v: unknown): number | undefined {
  const u = (v as { unread?: unknown } | null)?.unread;
  return typeof u === "number" ? u : undefined;
}

async function viaDaemon(
  stateDir: string,
  ms: number,
  residentId?: string,
): Promise<number | undefined> {
  const token = readToken(stateDir);
  if (!token) return undefined;
  // Counts for this session's worker only; without a route, every worker on the machine.
  const r = await request(
    socketPath(stateDir),
    { op: "notice", token, ...(residentId && { resident_id: residentId }) },
    ms,
  );
  return r.ok ? unreadFromCounts(r.result) : undefined;
}

/** No daemon: stateless HTTP read of the count. No WebSocket is ever opened. */
async function viaRelay(
  deps: HookDeps,
  ms: number,
): Promise<number | undefined> {
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
  return unreadFromCounts(await res.json());
}

export function readUnread(deps: HookDeps = {}): Promise<number> {
  const ms = deps.budgetMs ?? HOOK_BUDGET_MS;
  // One deadline for daemon plus fallback together, so the hook stays inside its budget.
  return Promise.race([
    readUnreadUnbounded(deps),
    new Promise<number>((resolve) => setTimeout(() => resolve(0), ms).unref()),
  ]);
}

async function readUnreadUnbounded(deps: HookDeps): Promise<number> {
  const stateDir = deps.stateDir ?? defaultStateDir();
  const ms = deps.budgetMs ?? HOOK_BUDGET_MS;
  try {
    const d = await viaDaemon(stateDir, ms, deps.route?.resident_id);
    if (d !== undefined) return d;
  } catch {
    // daemon not running: fall through to the stateless read
  }
  try {
    return (await viaRelay(deps, ms)) ?? 0;
  } catch {
    return 0;
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
const REPORT_ONLY = new Set([
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "PreToolUse",
  "PostToolUse",
]);

/** Short target for the activity line: a path relative to cwd, or the program name of a command. */
export function shortTarget(input: HookInput): string | undefined {
  const ti = input.tool_input;
  if (!ti || typeof ti !== "object") return undefined;
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
  if (event === "SessionStart") sweepClaims(stateDir);
  const activity = reportActivity(host, event, input, deps);
  if (REPORT_ONLY.has(event)) {
    await activity;
    return "";
  }
  const isStop = event === "Stop";
  if (isStop) {
    if (input.stop_hook_active === true) return "";
    if (!input.session_id) return "";
    const file = stopCountFile(stateDir, input.session_id);
    if (!file || readCount(file) >= MAX_STOP_CONTINUATIONS) return "";
  }
  const [unread] = await Promise.all([readUnread(deps), activity]);
  // SessionStart always carries the brief (spec 16 §3.5: fixed template plus the unread integer),
  // so the agent knows its home base even with nothing waiting. No town file: the plain notice.
  const notice =
    (event === "SessionStart"
      ? folderBrief(input.cwd ?? process.cwd(), {
          unread,
          platform: host,
          residentId: deps.route?.resident_id ?? process.env.HAWL_RESIDENT_ID,
        })
      : "") || formatNotice(unread);
  if (!notice) return "";
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
  return host === "claude_code" ? claudeContextOutput(event, notice) : notice;
}

async function readStdin(ms: number): Promise<HookInput> {
  if (process.stdin.isTTY) return {};
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
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => {
      buf += c;
    });
    process.stdin.on("end", () => {
      clearTimeout(t);
      done();
    });
    process.stdin.on("error", () => {
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

/** `hawl hook <host> <event>`. Never throws, never blocks the host. */
export async function runHook(
  host: string,
  event: string,
  scope: HookScope = "project",
): Promise<void> {
  if (host !== "claude_code" && host !== "codex") return;
  const input = await readStdin(50);
  const out = await hookOutput(host, event, input, {
    relayUrl: process.env.HAWL_RELAY_URL,
    agentToken: process.env.HAWL_AGENT_TOKEN,
    mintToken: keychainMinter(input.cwd ?? process.cwd(), defaultStateDir(), {
      host,
    }),
    scope,
  });
  if (out) process.stdout.write(`${out}\n`);
}

if (import.meta.main) {
  const [host, event] = process.argv.slice(2);
  runHook(host ?? "", event ?? "")
    .catch(() => {})
    .finally(() => process.exit(0));
}
