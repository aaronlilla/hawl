/**
 * Agent sessions (Claude Code, Codex, ...) that are open right now, per joined worker.
 *
 * The MCP server sends a heartbeat every 15 s and a goodbye when its host closes. The daemon
 * forwards both to the relay, which decides `here` or `away`. This list is only what the daemon
 * needs to repeat itself after a reconnect: a relay restart or a Wi-Fi change must not turn a
 * running agent into "away".
 */
export const SESSION_FRESH_MS = 45_000;

export class LiveSessions {
  private readonly seen = new Map<string, Map<string, number>>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A heartbeat from one session. */
  beat(residentId: string, sessionId: string): void {
    const m = this.seen.get(residentId) ?? new Map<string, number>();
    m.set(sessionId, this.now());
    this.seen.set(residentId, m);
  }

  /** The session's host closed. */
  bye(residentId: string, sessionId: string): void {
    this.seen.get(residentId)?.delete(sessionId);
  }

  /** Sessions with a recent heartbeat. */
  live(residentId: string): string[] {
    const m = this.seen.get(residentId);
    if (!m) return [];
    const out: string[] = [];
    for (const [id, at] of m) {
      if (this.now() - at <= SESSION_FRESH_MS) out.push(id);
      else m.delete(id);
    }
    return out;
  }

  forget(residentId: string): void {
    this.seen.delete(residentId);
  }
}

/**
 * The frames to send the relay after (re)connecting: one `live` per open session, or a single
 * `bye` when none is open, so the relay knows this helper reports sessions and "none" is true.
 */
export function announceFrames(
  live: string[],
): { t: "agent_session"; host_session_id: string; state: "live" | "bye" }[] {
  if (live.length === 0)
    return [{ t: "agent_session", host_session_id: "daemon", state: "bye" }];
  return live.map((id) => ({
    t: "agent_session" as const,
    host_session_id: id,
    state: "live" as const,
  }));
}
