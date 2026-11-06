import type { ActivityLine } from "./activity.ts";

type Line = Pick<ActivityLine, "kind" | "pid" | "session_id" | "reason">;

/**
 * Whose row a process line shows on. A subagent shares its terminal's session: a process goes to
 * the agent whose tool call it was linked to (session + reason, see ReasonLinker), its children
 * too, else to the agent that started the session (the terminal), else nobody (first connection).
 * A Monitor's shell is linked late (ReasonLinker.confirm sends its start again with the reason):
 * if that moves it to another agent, the first row gets an exit so no stale process stays there.
 * shortcut: two agents of one session giving the same reason within 10 s share the later one's
 * row; key by tool_use_id if that ever matters.
 */
export class ProcessActors {
  private bySession = new Map<string, string | undefined>();
  private byReason = new Map<string, string>();
  /** Every live process's row, so an exit goes where its start went. */
  private byPid = new Map<number, string | undefined>();

  started(session: string, actor: string | undefined): void {
    this.bySession.set(session, actor);
  }

  stopped(session: string): void {
    this.bySession.delete(session);
    for (const k of this.byReason.keys())
      if (k.startsWith(`${session}\n`)) this.byReason.delete(k);
  }

  /** A tool call about to run: the processes linked to `reason` belong to `actor`. */
  noted(session: string, reason: string, actor: string): void {
    this.byReason.set(`${session}\n${reason}`, actor);
  }

  /** Where to send the line: one target, or two when a process moves to another agent's row. */
  route<L extends Line>(l: L): { to: string | undefined; line: L }[] {
    const session = l.session_id ? this.bySession.get(l.session_id) : undefined;
    if (!l.pid) return [{ to: session, line: l }];
    if (l.kind === "process_exit") {
      const to = this.byPid.has(l.pid) ? this.byPid.get(l.pid) : session;
      this.byPid.delete(l.pid);
      return [{ to, line: l }];
    }
    const by =
      l.kind === "process_start" && l.reason && l.session_id
        ? this.byReason.get(`${l.session_id}\n${l.reason}`)
        : undefined;
    const had = this.byPid.has(l.pid);
    const was = this.byPid.get(l.pid);
    const to = by ?? (had ? was : session);
    this.byPid.set(l.pid, to);
    return had && was !== to
      ? [
          { to: was, line: { ...l, kind: "process_exit" } },
          { to, line: l },
        ]
      : [{ to, line: l }];
  }
}
