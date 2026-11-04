import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Jwk } from "@hawl/protocol/src/sign.ts";
import { writeFileDurable } from "./fsutil.ts";
import { generateWorkerKey, type KeyStore, type Signer } from "./keys.ts";
import { agentToken } from "./upload.ts";

/**
 * Every terminal is its own agent. When `hawl mcp` starts in a joined folder it asks the daemon
 * for a *session agent*: a worker under the folder's worker with its own name, key and inbox
 * (relay: agents/sessions.ts). This file is the daemon's side: the local list of session agents
 * (`~/.hawl/session-agents.json`, no secrets) and the call that opens one on the relay.
 */

export interface SessionAgent {
  resident_id: string;
  /** The folder's worker it belongs to. */
  parent_id: string;
  relay_url: string;
  platform: string;
  /** Hash of the folder worker and the host's session id (never the raw id). */
  session_key: string;
  handle: string;
  display_name: string;
  /** A Claude Code subagent: the terminal's agent that started it. */
  spawned_by?: string;
  /** A subagent: hash of its terminal's agent and Claude Code's agent_id (never the raw id). */
  agent_key?: string;
  /** A terminal: its MCP server's parent pid (Claude Code), to find it again after `/clear`. */
  mcp_ppid?: number;
  /** A terminal: other host session keys it was seen under (after `/clear`), newest last. */
  alias_keys?: string[];
  /** A subagent that ended but the relay has not confirmed it retired yet: retried, never used. */
  retiring?: boolean;
}

export function sessionsPath(stateDir: string): string {
  // Not sessions.json: daemon/sessions.ts keeps the host-session list for `hawl agents` there.
  return join(stateDir, "session-agents.json");
}

function valid(s: unknown): s is SessionAgent {
  const o = s as Partial<SessionAgent> | null;
  return (
    !!o &&
    typeof o.resident_id === "string" &&
    typeof o.parent_id === "string" &&
    typeof o.relay_url === "string" &&
    typeof o.platform === "string" &&
    typeof o.session_key === "string" &&
    typeof o.handle === "string" &&
    typeof o.display_name === "string"
  );
}

export function readSessionAgents(stateDir: string): SessionAgent[] {
  const f = sessionsPath(stateDir);
  if (!existsSync(f)) return [];
  try {
    const v = JSON.parse(readFileSync(f, "utf8")) as { sessions?: unknown };
    return Array.isArray(v.sessions) ? v.sessions.filter(valid) : [];
  } catch {
    return [];
  }
}

/** Keep the newest 200: older entries only cost a fresh key when that terminal is resumed. */
export function rememberSessionAgent(
  stateDir: string,
  s: SessionAgent,
): string[] {
  const all = readSessionAgents(stateDir);
  const rest = all.filter(
    (x) => x.resident_id !== s.resident_id && x.session_key !== s.session_key,
  );
  rest.push(s);
  const kept = rest.slice(-200);
  writeFileDurable(
    sessionsPath(stateDir),
    `${JSON.stringify({ v: 1, sessions: kept }, null, 2)}
`,
  );
  // Agents pushed out of the list (replaced or over 200): the caller deletes their keys.
  const keptIds = new Set(kept.map((x) => x.resident_id));
  return all.map((x) => x.resident_id).filter((id) => !keptIds.has(id));
}

/** One agent the relay retired (a provisional Codex agent replaced by a resumed one). */
export function forgetSessionAgent(stateDir: string, residentId: string): void {
  const all = readSessionAgents(stateDir);
  const rest = all.filter((x) => x.resident_id !== residentId);
  if (rest.length !== all.length)
    writeFileDurable(
      sessionsPath(stateDir),
      `${JSON.stringify({ v: 1, sessions: rest }, null, 2)}\n`,
    );
}

/** Returns the resident ids dropped, so the caller can delete their keys. */
export function forgetSessionAgentsOf(
  stateDir: string,
  parentId: string,
): string[] {
  const all = readSessionAgents(stateDir);
  const rest = all.filter((x) => x.parent_id !== parentId);
  if (rest.length !== all.length)
    writeFileDurable(
      sessionsPath(stateDir),
      `${JSON.stringify({ v: 1, sessions: rest }, null, 2)}
`,
    );
  return all.filter((x) => x.parent_id === parentId).map((x) => x.resident_id);
}

/** What the relay sees instead of the host's session id: sha256 of folder worker + id. */
export function sessionKeyFor(parentId: string, hostSessionId: string): string {
  return createHash("sha256")
    .update(`${parentId}|${hostSessionId}`)
    .digest("base64url");
}

/** The relay has no session agents (an older relay): stay on the folder's worker. */
export class SessionsUnsupported extends Error {
  constructor() {
    super("this relay has no session agents");
    this.name = "SessionsUnsupported";
  }
}

const RID = /^res_[A-Za-z0-9-]{1,64}$/;
const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Ask the relay for this terminal's agent, with the folder worker's token. The key sent is the
 * one this machine already holds for the agent last bound to this session (so `--resume` keeps
 * its key), else a new one. The private key is stored under the resident id the relay answers.
 */
export async function openSessionAgent(o: {
  relayUrl: string;
  parentId: string;
  parentSigner: Signer;
  platform: string;
  keyStore: KeyStore;
  sessionKey: string;
  /** The agent this machine had for this session key, if any. */
  previous?: string;
  /** Codex: the provisional session key this session replaces (relay: agents/sessions.ts). */
  replaces?: string;
  /** A Claude Code subagent: the terminal's agent that started it, and its agent type. */
  spawnedBy?: string;
  agentType?: string;
  doFetch?: typeof fetch;
}): Promise<SessionAgent> {
  const doFetch = o.doFetch ?? fetch;
  let priv: Jwk | null = o.previous ? await o.keyStore.get(o.previous) : null;
  const token = await agentToken(
    o.relayUrl,
    o.parentId,
    o.parentSigner,
    doFetch,
  );
  type Out = {
    resident_id?: unknown;
    handle?: unknown;
    display_name?: unknown;
    error?: { message?: string; code?: string };
  } | null;
  let out: Out = null;
  // At most two asks: with the key held for this session, then (when the relay says that key is
  // retired: its name went to a newer terminal) with a new key, which opens a new agent.
  for (let attempt = 0; ; attempt++) {
    if (!priv) priv = generateWorkerKey().privateJwk;
    const { d: _d, ...pub } = priv;
    const res = await doFetch(
      new URL("/v1/residents/me/sessions", o.relayUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          session_key: o.sessionKey,
          public_jwk: pub,
          ...(o.replaces && { replaces: o.replaces }),
          ...(o.spawnedBy && {
            spawned_by: o.spawnedBy,
            agent_type: o.agentType,
          }),
        }),
      },
    );
    if (res.status === 404 || res.status === 405)
      throw new SessionsUnsupported();
    out = (await res.json().catch(() => null)) as Out;
    if (res.status === 409 && attempt === 0) {
      priv = null;
      continue;
    }
    if (!res.ok)
      throw new Error(
        out?.error?.message ?? `relay ${res.status} opening a session`,
      );
    break;
  }
  const rid = out?.resident_id;
  const handle = out?.handle;
  if (typeof rid !== "string" || !RID.test(rid))
    throw new Error("relay sent no session agent id");
  if (typeof handle !== "string" || !HANDLE.test(handle))
    throw new Error("relay sent a bad session agent handle");
  await o.keyStore.set(rid, priv as Jwk);
  return {
    resident_id: rid,
    parent_id: o.parentId,
    relay_url: o.relayUrl,
    platform: o.platform,
    session_key: o.sessionKey,
    handle,
    display_name:
      typeof out?.display_name === "string"
        ? out.display_name.replace(/[\r\n\t<>]/g, " ").slice(0, 120)
        : handle,
  };
}

/** A subagent ended (SubagentStop): the relay retires it, so mail to it is refused. */
export async function closeSessionAgent(o: {
  relayUrl: string;
  parentId: string;
  parentSigner: Signer;
  residentId: string;
  doFetch?: typeof fetch;
}): Promise<void> {
  const doFetch = o.doFetch ?? fetch;
  const token = await agentToken(
    o.relayUrl,
    o.parentId,
    o.parentSigner,
    doFetch,
  );
  const res = await doFetch(
    new URL("/v1/residents/me/sessions/close", o.relayUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ resident_id: o.residentId }),
    },
  );
  // 404: no open subagent with that id, so it is already retired (an earlier try got through).
  if (!res.ok && res.status !== 404)
    throw new Error(`relay ${res.status} closing a subagent`);
}
