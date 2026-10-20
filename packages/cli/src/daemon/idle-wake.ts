import { queueCodexNotice } from "../hosts/codex-app-server.ts";
import { readTownFile } from "../town-file.ts";
import { WakeGate, wakeOn } from "../wake/gate.ts";
import type { SessionSeen } from "./sessions.ts";

/** A Codex session seen this recently can still be woken; older ones are left alone. */
export const CODEX_SESSION_FRESH_MS = 12 * 3_600_000;
/** Codex session ids are UUIDs; anything else never reaches the command line. */
const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CodexIdleWakeDeps {
  /** Aimed unread count and quiet time for one worker (the daemon's `notice` op). */
  counts: (rid: string) => { aimed: number; quietMs: number | null };
  sessions: () => SessionSeen[];
  /** Queue the fixed notice on a Codex thread. Default: `codex queue`. */
  queue?: (threadId: string, unread: number) => Promise<boolean>;
  /** Folder switch; default reads `.hawl/hawl.json` in the session's root. */
  folderWakeOn?: (root: string) => boolean;
  now?: () => number;
}

/** The newest fresh Codex session of this worker that came through a hook, in a joined folder. */
export function codexTarget(
  sessions: SessionSeen[],
  rid: string,
  now: number,
): SessionSeen | undefined {
  return sessions
    .filter(
      (s) =>
        s.host === "codex" &&
        s.via === "hook" &&
        s.resident_id === rid &&
        !!s.root &&
        !!s.session_id &&
        SESSION_UUID.test(s.session_id) &&
        now - Date.parse(s.last_seen) < CODEX_SESSION_FRESH_MS,
    )
    .sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen))[0];
}

/**
 * Codex idle wake, run by the daemon: when aimed mail lands for a worker whose newest Codex
 * session is idle, queue the fixed notice on that thread. An idle thread starts a turn at once;
 * a busy one runs it after the current turn; a closed one runs it when resumed.
 */
export class CodexIdleWake {
  private gates = new Map<string, WakeGate>();
  private inflight = new Set<string>();
  private d: CodexIdleWakeDeps;
  constructor(d: CodexIdleWakeDeps) {
    this.d = d;
  }

  private gate(rid: string): WakeGate {
    let g = this.gates.get(rid);
    if (!g) {
      g = new WakeGate();
      this.gates.set(rid, g);
    }
    return g;
  }

  /** Returns the thread woken, or undefined. Never throws. */
  async check(rid: string): Promise<string | undefined> {
    if (this.inflight.has(rid)) return undefined;
    const now = this.d.now?.() ?? Date.now();
    try {
      const target = codexTarget(this.d.sessions(), rid, now);
      if (!target?.root || !target.session_id) return undefined;
      const on =
        this.d.folderWakeOn ??
        ((root: string) => {
          try {
            return wakeOn(readTownFile(root));
          } catch {
            return false;
          }
        });
      if (!on(target.root)) return undefined;
      const { aimed, quietMs } = this.d.counts(rid);
      const g = this.gate(rid);
      if (!g.shouldWake({ aimed, quietMs, now })) return undefined;
      this.inflight.add(rid);
      const before = g.toldCount;
      g.woke(aimed, now);
      const ok = await (this.d.queue ?? queueCodexNotice)(
        target.session_id,
        aimed,
      ).catch(() => false);
      if (!ok) g.failed(before);
      return ok ? target.session_id : undefined;
    } catch {
      return undefined;
    } finally {
      this.inflight.delete(rid);
    }
  }
}
