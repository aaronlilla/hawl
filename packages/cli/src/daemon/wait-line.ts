import { WAITING_LINE } from "./activity.ts";

/**
 * The status line each agent set itself with `status_set`, so the waiting line can give it back. The relay replaces the line on every
 * status_set that has no `working_on`, so a clear that sent only the state erased what the agent had said ("testing") before the wait.
 * A line the agent sets during the wait lands here too, and that one is what comes back.
 */
export class WaitLines {
  private readonly own = new Map<string, string>();

  /** The agent called status_set (an empty or missing `working_on` clears its line). */
  noted(agent: string, workingOn: unknown): void {
    if (typeof workingOn === "string" && workingOn !== "")
      this.own.set(agent, workingOn);
    else this.own.delete(agent);
  }

  /** The `status_set` args for a wait starting (`on`) or ending (`idle`: the turn ended, else the agent went on). */
  args(agent: string, on: boolean, idle: boolean) {
    if (on) return { state: "busy", working_on: WAITING_LINE };
    const line = this.own.get(agent);
    return { state: idle ? "idle" : "busy", ...(line && { working_on: line }) };
  }
}
