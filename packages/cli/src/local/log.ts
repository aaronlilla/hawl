import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Part } from "@hawl/protocol/src/envelope.ts";
import { ensureDir } from "../daemon/fsutil.ts";

/** `~/.hawl/local/` (spec 16 §3.1 `hawl local`). */
export function defaultLocalDir(): string {
  return join(homedir(), ".hawl", "local");
}

export type HandoffState =
  | "asked"
  | "accepted"
  | "declined"
  | "cancelled"
  | "reassigned"
  | "done"
  | "verified";

export interface WorkerRec {
  resident_id: string;
  handle: string;
  platform: string;
  /** Ed25519 public JWK; sends are checked against it. */
  pub: Record<string, unknown>;
  joined_seq: number;
  status: "idle" | "busy" | "away";
  working_on: string | null;
  status_at: string;
}

export interface MsgRec {
  seq: number;
  message_id: string;
  conversation_id: string;
  from: string;
  to:
    | { kind: "worker"; resident_id: string }
    | { kind: "channel"; channel_id: string; mentions: string[] };
  intent: string;
  parts: Part[];
  client_request?: string;
  reply_to: string | null;
  at: string;
  handoff?: { handoff_id: string; state: HandoffState; op: string };
}

export interface HandoffRec {
  handoff_id: string;
  state: HandoffState;
  title: string;
  task_type: string;
  quality_bar: "quick" | "standard" | "critical";
  sender: string;
  assignee: string | null;
  verifier: string | null;
  deadline: string | null;
  conversation_id: string;
  updated_at: string;
}

export interface PinRec {
  message_id: string;
  title: string;
  pinned_by: string;
  pinned_at: string;
}

/** One line of `log.jsonl`. The log is the only source of truth; state is replayed from it. */
export type LocalEvent =
  | { t: "site"; at: string; channel_id: string }
  | { t: "room"; at: string; name: string; channel_id: string }
  | ({ t: "worker"; at: string } & Omit<
      WorkerRec,
      "status" | "working_on" | "status_at" | "joined_seq"
    >)
  | {
      t: "status";
      at: string;
      resident_id: string;
      state: WorkerRec["status"];
      working_on: string | null;
    }
  | ({ t: "msg" } & Omit<MsgRec, "seq">)
  | { t: "read"; at: string; resident_id: string; message_ids: string[] }
  | ({ t: "handoff" } & HandoffRec)
  | {
      t: "handoff_state";
      at: string;
      handoff_id: string;
      state: HandoffState;
      assignee: string | null;
    }
  | ({ t: "pin" } & PinRec);

/** Everything the hub reads. Rebuilt on start by replaying the log. */
export class LocalState {
  siteChannel: string | null = null;
  rooms = new Map<string, string>();
  workers = new Map<string, WorkerRec>();
  msgs: MsgRec[] = [];
  msgById = new Map<string, MsgRec>();
  reads = new Map<string, Set<string>>();
  handoffs = new Map<string, HandoffRec>();
  pins: PinRec[] = [];
  /** Counts every applied event, so a seq is stable across restarts. */
  seq = 0;

  apply(ev: LocalEvent): void {
    this.seq += 1;
    switch (ev.t) {
      case "site":
        this.siteChannel = ev.channel_id;
        break;
      case "room":
        this.rooms.set(ev.name, ev.channel_id);
        break;
      case "worker": {
        const { t: _t, at, ...w } = ev;
        this.workers.set(w.resident_id, {
          ...w,
          joined_seq: this.seq,
          status: "idle",
          working_on: null,
          status_at: at,
        });
        break;
      }
      case "status": {
        const w = this.workers.get(ev.resident_id);
        if (w) {
          w.status = ev.state;
          w.working_on = ev.working_on;
          w.status_at = ev.at;
        }
        break;
      }
      case "msg": {
        const { t: _t, ...m } = ev;
        const rec: MsgRec = { ...m, seq: this.seq };
        this.msgs.push(rec);
        this.msgById.set(rec.message_id, rec);
        break;
      }
      case "read": {
        let s = this.reads.get(ev.resident_id);
        if (!s) this.reads.set(ev.resident_id, (s = new Set()));
        for (const id of ev.message_ids) s.add(id);
        break;
      }
      case "handoff": {
        const { t: _t, ...h } = ev;
        this.handoffs.set(h.handoff_id, h);
        break;
      }
      case "handoff_state": {
        const h = this.handoffs.get(ev.handoff_id);
        if (h) {
          h.state = ev.state;
          h.assignee = ev.assignee;
          h.updated_at = ev.at;
        }
        break;
      }
      case "pin":
        this.pins.push({
          message_id: ev.message_id,
          title: ev.title,
          pinned_by: ev.pinned_by,
          pinned_at: ev.pinned_at,
        });
        break;
    }
  }
}

/** Append-only JSONL. Each append is fsynced; a torn last line is ignored on replay. */
export class LocalLog {
  readonly dir: string;
  readonly file: string;

  constructor(dir: string) {
    this.dir = dir;
    ensureDir(dir);
    this.file = join(dir, "log.jsonl");
  }

  append(ev: LocalEvent): void {
    const fd = openSync(this.file, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(ev)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  replay(): LocalState {
    const state = new LocalState();
    if (!existsSync(this.file)) return state;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        state.apply(JSON.parse(line) as LocalEvent);
      } catch {
        // torn or corrupt line: skip it, keep everything before and after
      }
    }
    return state;
  }
}
