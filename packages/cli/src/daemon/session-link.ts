/**
 * Claude Code resumed with `--continue` (or a bare `--resume` from the picker) gives its MCP
 * server a new CLAUDE_CODE_SESSION_ID, while its hooks get the resumed session's id
 * (code.claude.com/docs/en/env-vars; seen live on 2.1.301: the hook's input `session_id` and its
 * own env carry the resumed id, only the MCP server gets a fresh one). Hooks also get CLAUDE_PID,
 * the Claude Code process, which started the MCP server: directly (macOS, Linux) or through
 * hawl.cmd's cmd.exe (Windows). So a hook line names (session, Claude pid), the MCP server names
 * (its id, its parent pid), and this pairs them: same id first, then by process.
 */

/** How long a hook's report stays good for pairing. */
export const LINK_WINDOW_MS = 10 * 60_000;

type Claim = { session: string; at: number };

export class SessionLinks {
  /** Per folder: Claude Code pid -> the session its hooks last reported. */
  private readonly claims = new Map<string, Map<number, Claim>>();
  private readonly linked = new Map<string, string>();
  private readonly now: () => number;

  constructor(o: { now?: () => number } = {}) {
    this.now = o.now ?? Date.now;
  }

  /** A hook line from session `session` of the Claude Code process `claudePid`, in `folder`. */
  hookSaw(folder: string, session: string, claudePid: number): void {
    const m = this.claims.get(folder) ?? new Map<number, Claim>();
    m.set(claudePid, { session, at: this.now() });
    this.claims.set(folder, m);
  }

  /**
   * The MCP server holding session `x` in `folder`, whose parent process is `ppid`, asks which
   * session its terminal really is. `parentOf` answers a pid's parent; `live(id)` says whether
   * an MCP server holds `id` right now. Returns the session id to take, or undefined. Once
   * paired, the same answer every time.
   */
  async link(
    folder: string,
    x: string,
    o: {
      ppid?: number;
      parentOf: (pid: number) => Promise<number | undefined>;
      live: (id: string) => boolean;
    },
  ): Promise<string | undefined> {
    const key = `${folder}\n${x}`;
    const done = this.linked.get(key);
    if (done) return done;
    const m = this.claims.get(folder);
    if (!m || !o.ppid) return undefined;
    const now = this.now();
    for (const [pid, c] of m) if (now - c.at > LINK_WINDOW_MS) m.delete(pid);
    // Its own session's hooks report its id: nothing to change.
    if ([...m.values()].some((c) => c.session === x)) return undefined;
    let c = m.get(o.ppid);
    if (!c) {
      const gp = await o.parentOf(o.ppid);
      c = gp ? m.get(gp) : undefined;
    }
    if (!c || c.session === x || o.live(c.session)) return undefined;
    this.linked.set(key, c.session);
    return c.session;
  }
}
