import { spawn as spawnProcess } from "node:child_process";
import { type KeyObject, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { folderBrief } from "../brief.ts";
import { defaultStateDir } from "../daemon/main.ts";
import { readToken, request, socketPath } from "../daemon/socket.ts";
import { ToolError } from "../daemon/ws.ts";
import { markToolServer, waiterLive } from "../hook/wake-wait.ts";
import { detectSea } from "../install/self-install.ts";
import { winCommandLine } from "../shell.ts";
import { newerCurrent } from "../update/live-swap.ts";
import {
  CHANNEL_CAPABILITY,
  CHANNEL_INSTRUCTIONS,
  startChannelWake,
} from "./channel.ts";
import {
  actingAs,
  followHostSession,
  startTerminalAgent,
  withSessionNote,
} from "./session.ts";
import { type ToolDef, toolDefs } from "./tool-defs.ts";

/**
 * The shim's contract with the helper: bump it when the shim starts sending or expecting
 * something the helper must know about. `tool`, `tools_list` and `host_session` carry it; a
 * helper whose minimum is higher tells that one session to restart (tool-run.ts
 * MIN_SHIM_CONTRACT). Keep the shim so thin that this rarely moves: every tool runs in the helper.
 */
export const SHIM_CONTRACT = 1;

/** What the MCP server needs from the daemon. One call, one answer. */
export interface DaemonLink {
  /** `signal`: the client cancelled the call; the link hangs up so the helper stops too. */
  call(
    op: string,
    args?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface McpDeps {
  daemon: DaemonLink;
  residentId: string;
  version?: string;
  /** Folder whose `.hawl/hawl.json` feeds the server `instructions`. Default: the process cwd. */
  cwd?: string;
  /** Host id (claude_code, codex, ...), reported to the daemon for `hawl agents`. */
  host?: string;
  /** Declare the Claude Code channel capability (idle wake). Default: on for claude_code. */
  channel?: boolean;
  /** List the yard tools: the relay answered GET /v1/agent/yard with a yard (see probeYards). */
  yards?: boolean;
  /** Set when this process is a terminal's own agent (session.ts): the folder's worker. */
  folderId?: string;
  /** Who this terminal's agent is, added to the instructions (session.ts). */
  sessionLine?: string;
  /** Each tool call's `_meta` (session.ts followHostSession); a note to put before the result. */
  onToolCall?: (meta: unknown) => Promise<string | undefined>;
  /** The agent's key from the local key store: proves this machine holds it (session.ts). */
  signer?: LocalSigner;
  /** Another agent's key from the local key store (session.ts). Tests. */
  loadSigner?: (residentId: string) => Promise<LocalSigner | null>;
}

/** A worker key as the local key store holds it. */
export interface LocalSigner {
  kid: string;
  privateKey: KeyObject;
}

/** Longer than the helper's own wait: 5 s for the relay socket plus 10 s for its answer. */
export const DEFAULT_CALL_WAIT_MS = 20_000;

export interface DaemonLinkOpts {
  /** Start the helper detached. Default runs `hawl daemon`. */
  spawn?: (stateDir: string) => void;
  /** This shim's own version: a newer staged `~/.hawl/versions/current` is preferred for the helper. */
  version?: string;
  /** How long to wait for the helper after starting it. Spec: 3 s. */
  startWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** How long one call waits for the helper's answer. Must exceed the helper's own relay wait. */
  callWaitMs?: number;
}

export interface HelperLaunch {
  command: string;
  args: string[];
  options: {
    detached: true;
    stdio: "ignore";
    windowsHide: true;
    shell?: true;
    env: NodeJS.ProcessEnv;
  };
}

/**
 * How `hawl mcp` starts the helper. It runs this same CLI (`node <main.js> daemon`, or the
 * single-file binary itself), the way `hawl join` does, never through `hawl.cmd`: a detached
 * cmd.exe has no console, so the node it starts gets a new one, which Windows hands to the
 * default terminal (Windows Terminal) as a visible window per helper start.
 */
export function helperLaunch(
  stateDir: string,
  o: {
    script?: string;
    sea?: boolean;
    platform?: NodeJS.Platform;
    execPath?: string;
    version?: string;
  } = {},
): HelperLaunch {
  const sea = o.sea ?? detectSea();
  // npx: a helper staged by the live swap beats this shim's own, possibly older, package.
  const staged = !sea && o.version ? newerCurrent(stateDir, o.version) : null;
  const script = staged
    ? staged.entry
    : "script" in o
      ? o.script
      : process.argv[1];
  const execPath = o.execPath ?? process.execPath;
  const options = {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, HAWL_HOME: stateDir },
  } as const;
  if (sea) return { command: execPath, args: ["daemon"], options };
  if (script && /\.(?:[cm]?js|ts)$/.test(script))
    return { command: execPath, args: [script, "daemon"], options };
  // No script to rerun: a `hawl` on PATH. hawl.cmd needs a shell on Windows; one command
  // string avoids Node's DEP0190 warning.
  if ((o.platform ?? process.platform) === "win32")
    return {
      command: winCommandLine("hawl", ["daemon"]),
      args: [],
      options: { ...options, shell: true },
    };
  return { command: "hawl", args: ["daemon"], options };
}

function spawnHelper(stateDir: string, version?: string): void {
  const l = helperLaunch(stateDir, { version });
  const child = spawnProcess(l.command, l.args, l.options);
  child.on("error", () => {});
  child.unref();
}

const TOOL_TIMEOUT_MS = 130_000;

/**
 * `hawl mcp` starts the helper (spec 16 §3): when the socket is absent or dead, start it
 * detached, wait up to 3 s, then link. Calls the helper refuses (`!r.ok`) are real errors.
 */
export function daemonLink(
  stateDir = defaultStateDir(),
  opts: DaemonLinkOpts = {},
): DaemonLink {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempt = async (
    op: string,
    args: Record<string, unknown>,
    waitMs = 5000,
    signal?: AbortSignal,
  ) => {
    const token = readToken(stateDir);
    if (!token) throw new Error("hawl daemon is not running");
    return request(
      socketPath(stateDir),
      { op, token, ...args },
      waitMs,
      signal,
    );
  };
  let starting: Promise<void> | undefined;
  const start = (): Promise<void> => {
    starting ??= (async () => {
      try {
        (opts.spawn ?? ((d) => spawnHelper(d, opts.version)))(stateDir);
        const until = Date.now() + (opts.startWaitMs ?? 3000);
        while (Date.now() < until) {
          await sleep(100);
          try {
            if ((await attempt("status", {})).ok) return;
          } catch {
            // not up yet
          }
        }
      } finally {
        starting = undefined;
      }
    })();
    return starting;
  };
  return {
    async call(op, args = {}, signal) {
      let r: Awaited<ReturnType<typeof attempt>>;
      // A tool call (ask_agent waits up to 120 s) runs inside the helper, so it may take that long.
      const callMs =
        opts.callWaitMs ??
        (op === "tool" ? TOOL_TIMEOUT_MS : DEFAULT_CALL_WAIT_MS);
      // The helper took the call but did not answer: it is running, so say that, never restart it.
      const slow = (e: unknown) =>
        e instanceof Error && e.message === "daemon timeout"
          ? new Error(
              "The hawl helper is running but did not answer in time (the relay may be slow, or the helper is too old to read its reply). Run `hawl doctor`; update with `npm i -g hawl.ai@latest`.",
            )
          : undefined;
      try {
        r = await attempt(op, args, callMs, signal);
      } catch (e) {
        const s = slow(e);
        if (s) throw s;
        // Cancelled: the helper is fine, never restart it or send the call again.
        if (signal?.aborted) throw e;
        await start();
        try {
          r = await attempt(op, args, callMs, signal);
        } catch (e2) {
          throw (
            slow(e2) ??
            new Error(
              "hawl helper is not running and did not start; run `hawl daemon`",
            )
          );
        }
      }
      if (!r.ok) throw new ToolError(r.error, r.error_info);
      return r.result;
    },
  };
}

/** The helper checks the arguments; the shim lets any through and shows the client the schema. */
function passThrough(json: Record<string, unknown>) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "hawl",
      validate: (value: unknown) => ({
        value: value as Record<string, unknown>,
      }),
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}

/**
 * The tool list from the helper (its newest build), else this package's own. A fresh session
 * thus lists whatever the running helper knows; an open one keeps the list it started with.
 */
export async function fetchToolDefs(
  deps: Pick<McpDeps, "daemon">,
): Promise<ToolDef[]> {
  try {
    const r = (await deps.daemon.call("tools_list", {
      shim_contract: SHIM_CONTRACT,
    })) as { tools?: ToolDef[] } | null;
    if (Array.isArray(r?.tools) && r.tools.length > 0) return r.tools;
  } catch {
    // helper too old or down: this package's own list
  }
  return toolDefs();
}

type CallToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function makeServer(
  deps: McpDeps,
  defs: ToolDef[] = toolDefs(),
): McpServer {
  // Yard tools are next-release: off unless HAWL_YARD_TOOLS=1 (m2 testing). Not a copy of
  // deps: a terminal agent that follows its host session (session.ts) switches deps.residentId
  // in place, and every tool handler must see the switch.
  const yards = deps.yards === true && process.env.HAWL_YARD_TOOLS === "1";
  // `instructions` reach the model at initialize, for hosts with no SessionStart hook (Cursor,
  // Devin, Gemini, others). Same fixed brief as the hook, without the unread line.
  const brief = [
    folderBrief(deps.cwd ?? process.cwd(), {
      residentId: deps.folderId ?? deps.residentId,
      yards,
    }),
    deps.sessionLine ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const channel = usesChannel(deps);
  const instructions = channel
    ? [brief, CHANNEL_INSTRUCTIONS].filter(Boolean).join("\n\n")
    : brief;
  const server = new McpServer(
    { name: "hawl", version: deps.version ?? "0.0.0" },
    {
      ...(instructions && { instructions }),
      // Idle wake on Claude Code: the fixed notice only. No `claude/channel/permission`.
      ...(channel && {
        capabilities: { experimental: { [CHANNEL_CAPABILITY]: {} } },
      }),
    },
  );
  // Every tool is one forward to the helper, which runs it and answers in MCP shape. Only the
  // list (names, descriptions, schemas) lives here; `defs` is the helper's newest when it was up.
  for (const t of defs) {
    if (t.gated && !yards) continue;
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: passThrough(t.inputSchema) },
      withSessionNote(deps, async (args: unknown, ctx) => {
        try {
          // Inside a subagent the call acts as the subagent's own agent (session.ts).
          const { deps: d, args: a } = await actingAs(deps, args);
          return (await deps.daemon.call(
            "tool",
            {
              // The caller's trace as it came; the helper makes the id and carries it.
              traceparent: (
                ctx?.mcpReq?._meta as { traceparent?: unknown } | undefined
              )?.traceparent,
              resident_id: d.residentId,
              name: t.name,
              args: a,
              host: deps.host,
              cwd: deps.cwd ?? process.cwd(),
              ...(process.env.HAWL_FOLDER && {
                folder: process.env.HAWL_FOLDER,
              }),
              shim_contract: SHIM_CONTRACT,
            },
            // The person interrupted the call (Esc): stop the helper's wait too.
            ctx?.mcpReq?.signal,
          )) as CallToolResult;
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: (e as Error).message }],
          };
        }
      }),
    );
  }
  return server;
}

/**
 * Does the relay give this worker a yard? Asks the daemon for GET /v1/agent/yard. A yard answer
 * with a site turns the yard tools on; no yard (404) or any error keeps them off, and the next
 * session asks again.
 */
export async function probeYards(
  deps: Pick<McpDeps, "daemon" | "residentId">,
): Promise<boolean> {
  try {
    const r = (await deps.daemon.call("yard", {
      resident_id: deps.residentId,
    })) as { yard?: unknown; sites?: unknown[] } | null;
    return !!r?.yard && Array.isArray(r.sites) && r.sites.length > 0;
  } catch {
    return false;
  }
}

/**
 * Tell the relay this host loaded Hawl, so the owner's join row flips to "attached" (EXP-16).
 * The daemon's socket to the relay may still be coming up after a host restart, so retry a few
 * times. Best effort: a failure never stops the tools.
 */
export async function announceHost(
  deps: Pick<McpDeps, "daemon" | "residentId" | "host" | "cwd">,
  o: {
    tries?: number;
    waitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** The session id to announce. Default: a new one. */
    id?: string;
  } = {},
): Promise<boolean> {
  const tries = o.tries ?? 10;
  const sleep =
    o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const id = o.id ?? randomUUID();
  for (let i = 0; i < tries; i++) {
    try {
      const r = (await deps.daemon.call("host_session", {
        resident_id: deps.residentId,
        host_session_id: id,
        // For the daemon's session list (`hawl agents`): which host, from which folder.
        ...(deps.host && { host: deps.host }),
        ...(deps.cwd && { root: deps.cwd }),
        shim_contract: SHIM_CONTRACT,
      })) as { sent?: boolean } | undefined;
      if (r?.sent) return true;
    } catch {
      // daemon not ready yet
    }
    if (i < tries - 1) await sleep(o.waitMs ?? 1000);
  }
  return false;
}

/** How often an open agent tells the daemon it is still there. The relay waits 60 s. */
export const SESSION_BEAT_MS = 15_000;

/**
 * Presence for this agent session: a heartbeat to the daemon every 15 s while the host is open
 * and a goodbye when it closes, so the site shows "here" and "away" as they happen. `stop()`
 * sends the goodbye. A kill that cannot be caught is covered by the relay's 60 s timeout.
 */
export function startSessionPresence(
  deps: Pick<McpDeps, "daemon" | "residentId">,
  id: string,
  o: { everyMs?: number } = {},
): { stop: () => Promise<void> } {
  const send = (state: "live" | "bye") =>
    deps.daemon
      .call("agent_session", {
        resident_id: deps.residentId,
        host_session_id: id,
        state,
      })
      .catch(() => undefined);
  const timer = setInterval(
    () => void send("live"),
    o.everyMs ?? SESSION_BEAT_MS,
  );
  timer.unref();
  let stopped: Promise<void> | undefined;
  return {
    stop: () => {
      stopped ??= (async () => {
        clearInterval(timer);
        await send("bye");
      })();
      return stopped;
    },
  };
}

/** Send the goodbye when the host closes our stdin or asks us to stop, then leave. */
function sayGoodbyeOnExit(presence: { stop: () => Promise<void> }): void {
  const bye = () => {
    const cap = setTimeout(() => process.exit(0), 1500);
    cap.unref();
    void presence.stop().finally(() => process.exit(0));
  };
  process.stdin.once("end", bye);
  process.stdin.once("close", bye);
  process.once("SIGTERM", bye);
  process.once("SIGINT", bye);
  process.once("SIGHUP", bye);
}

/** No tools, one fixed line: the folder has not joined a site (the machine-wide entry). */
export const UNJOINED_INSTRUCTIONS =
  "Hawl is installed on this machine, but this folder has not joined a Hawl site, so there are no Hawl tools here. Run `hawl join <site>` in the folder to connect it.";

export function runUnjoinedMcp(): void {
  serveStdio(
    () =>
      new McpServer(
        { name: "hawl", version: "0.0.0" },
        { instructions: UNJOINED_INSTRUCTIONS },
      ),
  );
}

export function usesChannel(deps: Pick<McpDeps, "channel" | "host">): boolean {
  return deps.channel ?? deps.host === "claude_code";
}

/**
 * `hawl mcp --host <h>`: stdio server proxying to the daemon. On Claude Code the server stays on
 * the 2025-era handshake: Claude Code does not register a channel server that negotiates
 * revision 2026-07-28 (code.claude.com/docs/en/mcp, "Push messages with channels").
 */
export async function runMcp(base: McpDeps): Promise<void> {
  // In a joined folder each terminal works as its own agent (session.ts); else the folder's.
  const deps = await startTerminalAgent(base);
  const defs = await fetchToolDefs(deps);
  serveAs({ ...deps, yards: deps.yards ?? (await probeYards(deps)) }, defs);
}

function serveAs(
  deps: Parameters<typeof followHostSession>[0],
  defs: ToolDef[],
): void {
  if (usesChannel(deps)) {
    const server = makeServer(deps, defs);
    void server.connect(new StdioServerTransport());
    startChannelWake({
      cwd: deps.cwd ?? process.cwd(),
      notice: () =>
        deps.daemon.call("notice", { resident_id: deps.residentId }),
      send: (n) => server.server.notification(n as never),
      // Waiters are kept under the folder's worker (hook route): this session's own only
      // (same session id as markToolServer's; unknown, any waiter of the folder as before).
      waiterLive: () =>
        waiterLive(
          defaultStateDir(),
          deps.folderId ?? deps.residentId,
          process.env.CLAUDE_CODE_SESSION_ID,
        ),
    });
  } else {
    serveStdio(() => makeServer(deps, defs));
  }
  // Tells this worker's idle-wake waiter the session has the mailbox tool.
  process.once(
    "exit",
    markToolServer(defaultStateDir(), deps.folderId ?? deps.residentId),
  );
  const id = deps.sessionId ?? randomUUID();
  void announceHost(deps, { id });
  // Codex names its session only on tool calls: follow it there (session.ts).
  deps.sessionId = id;
  const f = followHostSession(deps, {
    startPresence: startSessionPresence,
    announce: (d, sid) => announceHost(d, { id: sid, tries: 1 }),
  });
  deps.onToolCall = f.onToolCall;
  sayGoodbyeOnExit(f);
}

if (import.meta.main) {
  // helperLaunch reruns this script as `<script> daemon`; when the script is server.ts (tests) that
  // would start another MCP server that probes and spawns again, forever.
  if (process.argv[2] === "daemon") process.exit(0);
  const residentId = process.env.HAWL_RESIDENT_ID;
  if (!residentId) {
    process.stderr.write("hawl mcp: HAWL_RESIDENT_ID is not set\n");
    process.exit(1);
  }
  // No top-level await: esbuild marks the module async even in this dead branch, and the bundle's init cycle (join <-> specialties) then deadlocks.
  void runMcp({
    daemon: daemonLink(),
    residentId,
    ...(process.env.HAWL_MCP_HOST && { host: process.env.HAWL_MCP_HOST }),
    ...(process.env.HAWL_MCP_CWD && { cwd: process.env.HAWL_MCP_CWD }),
  });
}
