import { randomUUID } from "node:crypto";
import type { McpDeps } from "./server.ts";

/**
 * Every terminal is its own agent (onboarding P2b). `hawl mcp` in a joined folder asks the
 * daemon for this terminal's session agent ("Aaron's Claude · Otter", handle `otter`) and then
 * works as that agent: its own name, key, inbox and presence. The folder's worker stays the
 * owner of permissions, and its mail (sent by older clients to the folder's handle) is shared:
 * the first terminal there to read a message takes it. Anything that fails keeps the old
 * behaviour: the folder's worker.
 */

export interface TerminalAgent {
  residentId: string;
  handle: string;
  displayName: string;
  /** The folder's worker. */
  folderId: string;
  /** The id this terminal announces for presence (the host's session id when it has one). */
  sessionId: string;
}

/**
 * The host's own id for this terminal. Claude Code sets CLAUDE_CODE_SESSION_ID for stdio MCP
 * servers and keeps it on `--resume <id>` (code.claude.com/docs/en/env-vars), so a resumed
 * session gets the same agent back. Codex passes no session id to an MCP server's environment;
 * it sends one on every tool call instead (`metaSessionId`, `followHostSession`).
 */
export function hostSessionId(
  host: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const id = host === "claude_code" ? env.CLAUDE_CODE_SESSION_ID : undefined;
  return id && /^[A-Za-z0-9._:-]{1,200}$/.test(id) ? id : undefined;
}

/**
 * The host session id a tool call carries. Codex puts `sessionId` (its root thread's id, shared
 * by sub-agent threads and kept on `codex resume`) and `threadId` in every tool call's `_meta`
 * (openai/codex codex-rs/core/src/mcp_tool_call.rs, with_mcp_tool_call_ids_meta).
 */
export function metaSessionId(
  host: string | undefined,
  meta: unknown,
): string | undefined {
  if (host !== "codex" || !meta || typeof meta !== "object") return undefined;
  const m = meta as Record<string, unknown>;
  const id =
    typeof m.sessionId === "string"
      ? m.sessionId
      : typeof m.threadId === "string"
        ? m.threadId
        : undefined;
  return id && /^[A-Za-z0-9._:-]{1,200}$/.test(id) ? id : undefined;
}

const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RID = /^res_[A-Za-z0-9-]{1,64}$/;

/**
 * Open this terminal's agent. Returns null (stay on the folder's worker) when the daemon or the
 * relay has no session agents, or anything else goes wrong within `timeoutMs`.
 */
export async function openTerminalAgent(
  deps: Pick<McpDeps, "daemon" | "residentId" | "host">,
  o: {
    sessionId?: string;
    /** Codex: the provisional session this terminal started on (daemon: session_open). */
    replaces?: string;
    loadSigner: (residentId: string) => Promise<McpDeps["signer"] | null>;
    timeoutMs?: number;
    /** The daemon answers after the timeout: the agent it opened for this terminal after all. */
    onLate?: (a: LateAgent) => void;
  },
): Promise<LateAgent | null> {
  const sessionId = o.sessionId ?? randomUUID();
  const run = async () => {
    const r = (await deps.daemon.call("session_open", {
      resident_id: deps.residentId,
      host_session_id: sessionId,
      ...(o.replaces && { replaces_host_session_id: o.replaces }),
      ...(deps.host && { host: deps.host }),
      // Claude Code (or its cmd.exe shim): after /clear its hooks are matched to us by this pid.
      ppid: process.ppid,
    })) as {
      unsupported?: boolean;
      resident_id?: unknown;
      handle?: unknown;
      display_name?: unknown;
    } | null;
    if (!r || r.unsupported) return null;
    if (typeof r.resident_id !== "string" || !RID.test(r.resident_id))
      return null;
    if (typeof r.handle !== "string" || !HANDLE.test(r.handle)) return null;
    const signer = await o.loadSigner(r.resident_id);
    if (!signer) return null;
    return {
      residentId: r.resident_id,
      handle: r.handle,
      displayName:
        typeof r.display_name === "string"
          ? r.display_name.replace(/[\r\n\t<>`]/g, " ").slice(0, 120)
          : r.handle,
      folderId: deps.residentId,
      sessionId,
      signer,
    };
  };
  let timer: NodeJS.Timeout | undefined;
  const opening = run();
  try {
    return await Promise.race([
      opening,
      new Promise<null>((r) => {
        timer = setTimeout(() => {
          r(null);
          // The daemon goes on opening the agent and spools its mail: whoever waits takes it.
          opening.then((a) => a && o.onLate?.(a)).catch(() => undefined);
        }, o.timeoutMs ?? 10_000);
        timer.unref();
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type LateAgent = TerminalAgent & {
  signer: NonNullable<McpDeps["signer"]>;
};

/** What the agent is told about itself, after the folder brief. Handle and name are checked. */
export function terminalAgentLine(a: TerminalAgent): string {
  return [
    `In this terminal you are @${a.handle} (${a.displayName}): your own Hawl agent with your own mailbox.`,
    "Other terminals in this folder are separate agents; `who` lists them and you can message them by handle.",
    `Mail sent to this folder's agent (${a.folderId}) is shared: mailbox shows it here too, and the first terminal to read it takes it, so other terminals no longer see it.`,
  ].join(" ");
}

/** The terminal agent's key, from the same key store the daemon wrote it to. */
async function defaultLoadSigner(
  residentId: string,
): Promise<McpDeps["signer"] | null> {
  const { defaultStateDir } = await import("../daemon/main.ts");
  const { loadLocalSigner, openKeyStore } = await import("../daemon/keys.ts");
  const store = await openKeyStore({
    stateDir: defaultStateDir(),
    passphrase: process.env.HAWL_PASSPHRASE,
  });
  return loadLocalSigner(store, residentId);
}

/**
 * `hawl mcp --host <h>` in a joined folder: the deps to serve with. This terminal's agent when
 * one opens, else the folder's worker as before. Local mode (no host) is left alone.
 */
export async function startTerminalAgent(
  base: McpDeps,
  o: {
    env?: NodeJS.ProcessEnv;
    loadSigner?: (residentId: string) => Promise<McpDeps["signer"] | null>;
    timeoutMs?: number;
  } = {},
): Promise<McpDeps & { sessionId?: string; lateAgent?: Promise<LateAgent> }> {
  if (!base.host || base.folderId) return base;
  const sessionId = hostSessionId(base.host, o.env) ?? randomUUID();
  let late: (a: LateAgent) => void = () => {};
  const lateAgent = new Promise<LateAgent>((r) => (late = r));
  const a = await openTerminalAgent(base, {
    sessionId,
    loadSigner: o.loadSigner ?? defaultLoadSigner,
    ...(o.timeoutMs !== undefined && { timeoutMs: o.timeoutMs }),
    onLate: late,
  });
  if (!a) return { ...base, sessionId, lateAgent };
  return {
    ...base,
    residentId: a.residentId,
    folderId: a.folderId,
    signer: a.signer,
    sessionLine: terminalAgentLine(a),
    sessionId,
  };
}

interface Presence {
  stop: () => Promise<void>;
}

/**
 * Presence for this terminal's agent, and (on Codex) the switch from the provisional session it
 * started on to the host's own session, at the first tool call that names it:
 * - a new Codex session: the provisional agent becomes that session's agent (same name);
 * - `codex resume`: the session's earlier agent comes back (its name, mail and threads), the
 *   provisional one is retired, and the tool result says who this terminal now is.
 * `onToolCall` answers that note once, else undefined. Failures keep the provisional agent.
 */
export function followHostSession(
  deps: McpDeps & { sessionId?: string; lateAgent?: Promise<LateAgent> },
  o: {
    startPresence: (
      d: Pick<McpDeps, "daemon" | "residentId">,
      id: string,
    ) => Presence;
    announce?: (
      d: Pick<McpDeps, "daemon" | "residentId" | "host" | "cwd">,
      id: string,
    ) => Promise<unknown>;
    loadSigner?: (residentId: string) => Promise<McpDeps["signer"] | null>;
    timeoutMs?: number;
    /** Claude Code: how often to ask the daemon whether the hooks report another session. */
    linkEveryMs?: number;
    /** Claude Code: how long to keep asking after start. */
    linkForMs?: number;
    /** This process's parent pid (tests). */
    ppid?: number;
  },
): {
  onToolCall: (meta: unknown) => Promise<string | undefined>;
  stop: () => Promise<void>;
} {
  let id = deps.sessionId ?? randomUUID();
  let presence = o.startPresence(
    { daemon: deps.daemon, residentId: deps.residentId },
    id,
  );
  // A Codex terminal agent learns its host's id from tool calls. A Claude Code one resumed with
  // `--continue` got a fresh id while its hooks report the resumed one with the Claude Code pid:
  // the daemon pairs them (daemon/session-link.ts); this asks it on a timer and on tool calls.
  let open =
    (deps.host === "codex" || deps.host === "claude_code") && !!deps.folderId;
  const linking = deps.host === "claude_code" && open;
  const linkUntil = Date.now() + (o.linkForMs ?? 10 * 60_000);
  let note: string | undefined;
  let tries = 0;
  let pending: Promise<string | undefined> | undefined;
  const follow = async (next: string): Promise<string | undefined> => {
    const a = await openTerminalAgent(
      { daemon: deps.daemon, residentId: deps.folderId!, host: deps.host },
      {
        sessionId: next,
        replaces: id,
        loadSigner: o.loadSigner ?? defaultLoadSigner,
        ...(o.timeoutMs !== undefined && { timeoutMs: o.timeoutMs }),
      },
    );
    if (!a) {
      if (++tries >= 3) open = false;
      return undefined;
    }
    open = false;
    const was = deps.residentId;
    const old = presence;
    deps.residentId = a.residentId;
    deps.signer = a.signer;
    deps.sessionLine = terminalAgentLine(a);
    deps.sessionId = next;
    id = next;
    // The daemon counted the new session open at session_open; start beating before the old
    // session says goodbye, so the agent never looks closed in between.
    presence = o.startPresence(
      { daemon: deps.daemon, residentId: a.residentId },
      next,
    );
    await deps.daemon
      .call("agent_session", {
        resident_id: a.residentId,
        host_session_id: next,
        state: "live",
      })
      .catch(() => undefined);
    if (o.announce) await o.announce(deps, next).catch(() => undefined);
    await old.stop();
    if (a.residentId === was) return undefined;
    return `This terminal resumed an earlier session: you are @${a.handle} (${a.displayName}) again, with that agent's mailbox. Ignore earlier mentions of a different name for you.`;
  };
  /** Claude Code: the session id the daemon paired this one with, if any. */
  const linked = async (): Promise<string | undefined> => {
    if (Date.now() > linkUntil) {
      open = false;
      return undefined;
    }
    try {
      // The parent pid lets the daemon find the Claude Code process its hooks name.
      const r = (await deps.daemon.call("session_link", {
        resident_id: deps.folderId,
        host_session_id: id,
        ppid: o.ppid ?? process.ppid,
      })) as { host_session_id?: unknown } | null;
      const y = r?.host_session_id;
      return typeof y === "string" && y !== id ? y : undefined;
    } catch {
      open = false; // an older daemon has no session_link
      return undefined;
    }
  };
  const check = async (meta: unknown): Promise<string | undefined> => {
    if (pending) return pending.then(() => undefined);
    if (!open) return undefined;
    pending = (async () => {
      const next = linking ? await linked() : metaSessionId(deps.host, meta);
      if (!open || !next || next === id) return undefined;
      // Kept until the next tool call shows it (a timer may be the one that switched).
      note = (await follow(next)) ?? note;
      return note;
    })().catch(() => undefined);
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
  let timer: NodeJS.Timeout | undefined;
  if (linking) {
    const tick = async () => {
      await check(undefined);
      if (!open) return;
      timer = setTimeout(tick, o.linkEveryMs ?? 3_000);
      timer.unref?.();
    };
    timer = setTimeout(tick, 0);
    timer.unref?.();
  }
  // A server that gave up waiting for session_open (a slow first start) works as the folder, but
  // the daemon still opens this terminal's agent and spools that agent's mail: become it then.
  // The folder's beat runs until exit: its goodbye now would close the agent's session too.
  let stopped = false;
  const kept: Presence[] = [];
  void deps.lateAgent?.then(async (a) => {
    if (stopped || deps.folderId) return;
    deps.residentId = a.residentId;
    deps.signer = a.signer;
    deps.folderId = a.folderId;
    deps.sessionLine = terminalAgentLine(a);
    kept.push(presence);
    presence = o.startPresence(
      { daemon: deps.daemon, residentId: a.residentId },
      id,
    );
    await deps.daemon
      .call("agent_session", {
        resident_id: a.residentId,
        host_session_id: id,
        state: "live",
      })
      .catch(() => undefined);
    if (o.announce) await o.announce(deps, id).catch(() => undefined);
    note = `Hawl: this terminal's own agent is ready. ${terminalAgentLine(a)} Ignore earlier lines that name the folder's agent as you.`;
  });
  return {
    onToolCall: async (meta) => {
      await check(meta);
      const n = note;
      note = undefined;
      return n;
    },
    stop: async () => {
      open = false;
      stopped = true;
      if (timer) clearTimeout(timer);
      await presence.stop();
      for (const p of kept) await p.stop();
    },
  };
}

const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Subagent keys already loaded, per resident id. */
const subSigners = new Map<string, NonNullable<McpDeps["signer"]>>();

/**
 * A tool call made inside a Claude Code subagent carries `hawl_agent` (the subagent's id, added
 * by the PreToolUse hook). The daemon answers that subagent's own agent (opened at
 * SubagentStart); the call then acts as it, with its key and only its own mailbox. The field is
 * always removed. No agent for it (its open failed, the cap was hit, this server fell back to the
 * folder's worker, daemon down): the call works as before, as this server's own agent.
 */
export async function actingAs(
  deps: McpDeps,
  args: unknown,
): Promise<{ deps: McpDeps; args: Record<string, unknown> }> {
  const { hawl_agent: tag, ...rest } = (args ?? {}) as Record<string, unknown>;
  if (typeof tag !== "string" || !AGENT_ID.test(tag))
    return { deps, args: rest };
  const r = (await deps.daemon
    .call("subagent_for", { resident_id: deps.residentId, agent_id: tag })
    .catch(() => null)) as { resident_id?: unknown } | null;
  const rid = r?.resident_id;
  let signer =
    typeof rid === "string" && RID.test(rid) ? subSigners.get(rid) : undefined;
  if (!signer && typeof rid === "string" && RID.test(rid)) {
    signer =
      (await (deps.loadSigner ?? defaultLoadSigner)(rid).catch(() => null)) ??
      undefined;
    if (signer) subSigners.set(rid, signer);
  }
  if (typeof rid !== "string" || !signer) return { deps, args: rest };
  return {
    deps: { ...deps, residentId: rid, signer, folderId: undefined },
    args: rest,
  };
}

/** The SDK's request context, as far as hawl reads it: `_meta`, and `signal` (the client cancelled). */
type ToolCtx = { mcpReq?: { _meta?: unknown; signal?: AbortSignal } };

/**
 * A tool handler that first passes the call's `_meta` to `deps.onToolCall` and puts the note it
 * answers (if any) before the result.
 */
export function withSessionNote<
  R extends { content: { type: "text"; text: string }[] },
>(
  deps: Pick<McpDeps, "onToolCall">,
  run: (args: unknown, ctx?: ToolCtx) => Promise<R>,
): (args: unknown, ctx?: ToolCtx) => Promise<R> {
  return async (args, ctx) => {
    const note = await deps
      .onToolCall?.(ctx?.mcpReq?._meta)
      .catch(() => undefined);
    const r = await run(args, ctx);
    if (note) r.content.unshift({ type: "text", text: note });
    return r;
  };
}
