import type { TownFile } from "../town-file.ts";

/**
 * Idle wake: when mail aimed at an agent arrives and its session sits idle, start it on the
 * fixed notice (hook/notice.ts) without its person typing. Claude Code gets it as a channel
 * event from `hawl mcp`; Codex gets it as a queued message on its open thread (`codex queue`).
 * Only the notice template and an integer ever reach the agent; it reads bodies via `mailbox`.
 *
 * Relay caps apply before anything reaches this machine: wakes per day per site and worker,
 * agent turns since a person's touch, the hop limit and the site-wide wake switch all decide
 * whether mail is pushed at all. This gate adds local limits on top.
 */

/** No hook activity from this agent for this long counts as idle (busy agents get hook notices). */
export const IDLE_QUIET_MS = 10_000;
/** At most one wake per agent in this window. */
export const WAKE_MIN_INTERVAL_MS = 30_000;
/** And at most this many per rolling hour. */
export const MAX_IDLE_WAKES_PER_HOUR = 12;

/** `hawl config wake on|off` for the folder. Absent means on. */
export function wakeOn(
  town: Pick<TownFile, "wake"> | null | undefined,
): boolean {
  return !!town && town.wake !== false;
}

export interface WakeInput {
  /** Unread mail aimed at this agent (DM, ask, reply, handoff, mention). */
  aimed: number;
  /** Ms since the agent's last hook activity; null when it never reported any. */
  quietMs: number | null;
  now?: number;
}

/**
 * Decides whether to wake one agent. It wakes only when the aimed count rose past what the
 * agent was last told, the agent is quiet, and the local rate limits allow it. A drop (the
 * agent read its mail) is recorded, so the next arrival wakes again.
 */
export class WakeGate {
  private told = 0;
  private wakes: number[] = [];

  /** The count a hook or an earlier wake already told the agent about. */
  seen(aimed: number): void {
    this.told = aimed;
  }

  shouldWake(i: WakeInput): boolean {
    const now = i.now ?? Date.now();
    if (!Number.isSafeInteger(i.aimed) || i.aimed < 0) return false;
    if (i.aimed < this.told) this.told = i.aimed;
    if (i.aimed === 0 || i.aimed <= this.told) return false;
    if (i.quietMs !== null && i.quietMs < IDLE_QUIET_MS) return false;
    this.wakes = this.wakes.filter((t) => now - t < 3_600_000);
    const last = this.wakes[this.wakes.length - 1];
    if (last !== undefined && now - last < WAKE_MIN_INTERVAL_MS) return false;
    if (this.wakes.length >= MAX_IDLE_WAKES_PER_HOUR) return false;
    return true;
  }

  /** Record a wake that was sent. */
  woke(aimed: number, now = Date.now()): void {
    this.told = aimed;
    this.wakes.push(now);
  }

  /**
   * The wake did not go out (host missing, command failed): the agent was not told, so a later
   * check tries again. The attempt still counts toward the interval and hourly limits.
   */
  failed(toldBefore: number): void {
    this.told = toldBefore;
  }

  /** What the agent was last told (for `failed`). */
  get toldCount(): number {
    return this.told;
  }
}
