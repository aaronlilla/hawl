import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileDurable } from "./fsutil.ts";

/** One agent session the daemon has heard from: a hook event or an MCP server start. */
export interface SessionSeen {
  host: string;
  session_id?: string;
  resident_id?: string;
  /** The joined folder the session routed through. */
  root?: string;
  via: "hook" | "mcp";
  first_seen: string;
  last_seen: string;
}

const MAX = 200;
const KEEP_MS = 30 * 24 * 3600_000;

/**
 * Agent sessions seen on this machine, for `hawl agents` (is each host really hooked?).
 * Kept in `~/.hawl/sessions.json` so the answer survives a daemon restart. Written on a new
 * session only, not on every tool call.
 */
export class SessionLog {
  private list: SessionSeen[];
  private readonly file: string;
  private readonly now: () => number;

  constructor(stateDir: string, now: () => number = Date.now) {
    this.file = join(stateDir, "sessions.json");
    this.now = now;
    this.list = [];
    try {
      if (existsSync(this.file)) {
        const v = JSON.parse(readFileSync(this.file, "utf8")) as {
          sessions?: SessionSeen[];
        };
        if (Array.isArray(v.sessions)) this.list = v.sessions;
      }
    } catch {
      // a torn file only loses history
    }
  }

  seen(s: Omit<SessionSeen, "first_seen" | "last_seen">): void {
    const at = new Date(this.now()).toISOString();
    const hit = this.list.find(
      (x) =>
        x.host === s.host &&
        x.via === s.via &&
        x.session_id === s.session_id &&
        x.root === s.root,
    );
    if (hit) {
      hit.last_seen = at;
      if (s.resident_id) hit.resident_id = s.resident_id;
      return;
    }
    this.list.push({ ...s, first_seen: at, last_seen: at });
    const cutoff = this.now() - KEEP_MS;
    this.list = this.list
      .filter((x) => Date.parse(x.last_seen) >= cutoff)
      .slice(-MAX);
    try {
      writeFileDurable(
        this.file,
        `${JSON.stringify({ v: 1, sessions: this.list })}\n`,
      );
    } catch {
      // the list still answers from memory
    }
  }

  all(): SessionSeen[] {
    return [...this.list];
  }
}
