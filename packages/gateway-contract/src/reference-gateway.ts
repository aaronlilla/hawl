import { readFileSync } from "node:fs";
import { checkSchema, type Schema } from "./schema-check.ts";

export type Visibility = "private" | "summary" | "full";

export interface Capability {
  id: string;
  description: string;
  inputs?: string[];
  outputs?: string[];
  quality_bar?: string[];
  typical_minutes?: number;
  accepts_files?: string[];
}

export interface Menu {
  yard: string;
  owner: string;
  display_name: string;
  visibility: Visibility;
  capabilities: Capability[];
  routing_policy?: {
    accept_from?: string[];
    auto_accept?: boolean;
    daily_budget_usd?: number;
  };
}

export interface Heartbeat {
  yard: string;
  state: "online" | "busy" | "degraded" | "paused" | "offline";
  load: { active_tasks: number; queued: number };
  workers: { busy: number; idle: number };
  needs_human: number;
  as_of: string;
  agents?: {
    id: string;
    status: "busy" | "idle" | "blocked" | "needs_human";
  }[];
}

export type LifecycleEventName =
  | "offer"
  | "accept"
  | "decline"
  | "progress"
  | "done"
  | "verify"
  | "cancel"
  | "expire"
  | "reassign"
  | "direct_line_open"
  | "direct_line_approve"
  | "direct_line_reject";

export interface LifecycleEvent {
  yard: string;
  task_id: string;
  event: LifecycleEventName;
  at: string;
  capability?: string;
  acceptance?: string[];
  quality_bar?: string;
  deadline?: string;
  note?: string;
  reason?: string;
  to?: string;
  revision_sha?: string;
  evidence?: { kind: "sha" | "ci" | "pr" | "artifact"; ref: string }[];
  result?: "pass" | "reject";
  from_inner?: string;
  to_village?: string;
  purpose?: string;
  ttl_minutes?: number;
}

/** Handoff states from 12 section 5, as seen through the gateway. */
export type TaskState =
  | "asked"
  | "accepted"
  | "declined"
  | "done"
  | "verified"
  | "cancelled"
  | "expired"
  | "reassigned";

export type ContractKind = "menu" | "heartbeat" | "lifecycle";

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

const schemaCache = new Map<ContractKind, Schema>();

/** Load schemas/<kind>.schema.json. */
export function loadSchema(kind: ContractKind): Schema {
  let s = schemaCache.get(kind);
  if (!s) {
    const url = new URL(`../schemas/${kind}.schema.json`, import.meta.url);
    s = JSON.parse(readFileSync(url, "utf8")) as Schema;
    schemaCache.set(kind, s);
  }
  return s;
}

/** Returns null when the value matches the schema, else a one-line error. */
export function check(kind: ContractKind, value: unknown): string | null {
  const errs = checkSchema(loadSchema(kind), value);
  return errs.length === 0 ? null : errs.join("; ");
}

/** Validate, then decode and encode through JSON. Throws ContractError when invalid. */
export function roundTrip<T = unknown>(kind: ContractKind, value: unknown): T {
  const err = check(kind, value);
  if (err) throw new ContractError(`invalid ${kind}: ${err}`);
  return JSON.parse(JSON.stringify(value)) as T;
}

const TERMINAL: readonly TaskState[] = [
  "declined",
  "verified",
  "cancelled",
  "expired",
];

/**
 * Legal moves per current state. progress keeps the state. A rejected verify returns
 * the task to accepted so the worker can resubmit; a reassigned task can be offered again.
 */
const MOVES: Record<TaskState | "none", Partial<Record<string, TaskState>>> = {
  none: { offer: "asked" },
  asked: {
    accept: "accepted",
    decline: "declined",
    cancel: "cancelled",
    expire: "expired",
    reassign: "reassigned",
  },
  accepted: {
    progress: "accepted",
    done: "done",
    cancel: "cancelled",
    expire: "expired",
  },
  done: { verify: "verified", cancel: "cancelled", expire: "expired" },
  reassigned: { offer: "asked" },
  declined: {},
  verified: {},
  cancelled: {},
  expired: {},
};

/**
 * Reference gateway. It holds one menu, accepts heartbeats and lifecycle events for it,
 * and enforces what JSON Schema cannot: task ordering, the direct-line handshake, and
 * the visibility rule (inner agents leave only at visibility full).
 */
export class ReferenceGateway {
  readonly #menu: Menu;
  readonly #tasks = new Map<string, TaskState>();
  readonly #lines = new Set<string>();

  constructor(menu: unknown) {
    this.#menu = roundTrip<Menu>("menu", menu);
  }

  publishMenu(): Menu {
    return roundTrip<Menu>("menu", this.#menu);
  }

  /** Validate a heartbeat for this yard. Inner agents are dropped unless visibility is full. */
  heartbeat(beat: unknown): Heartbeat {
    const hb = roundTrip<Heartbeat>("heartbeat", beat);
    if (hb.yard !== this.#menu.yard) {
      throw new ContractError(
        `heartbeat: yard ${hb.yard} is not ${this.#menu.yard}`,
      );
    }
    if (this.#menu.visibility !== "full") delete hb.agents;
    return hb;
  }

  stateOf(taskId: string): TaskState | undefined {
    return this.#tasks.get(taskId);
  }

  /** Apply one lifecycle event and return the task state afterwards. */
  apply(raw: unknown): TaskState {
    const ev = roundTrip<LifecycleEvent>("lifecycle", raw);
    const cur = this.#tasks.get(ev.task_id);

    if (ev.event.startsWith("direct_line_")) {
      return this.#directLine(ev, cur);
    }

    const event: string = ev.event;
    let next: TaskState | undefined;
    if (event === "verify" && ev.result === "reject") {
      next = cur === "done" ? "accepted" : undefined;
    } else {
      next = MOVES[cur ?? "none"][event];
    }
    if (!next) {
      throw new ContractError(
        `transition: ${event} not allowed from ${cur ?? "no task"}`,
      );
    }
    this.#tasks.set(ev.task_id, next);
    if (TERMINAL.includes(next)) this.#lines.delete(ev.task_id);
    return next;
  }

  #directLine(ev: LifecycleEvent, cur: TaskState | undefined): TaskState {
    const id = ev.task_id;
    if (ev.event === "direct_line_open") {
      if (cur !== "accepted") {
        throw new ContractError("direct line needs an accepted task");
      }
      if (this.#lines.has(id))
        throw new ContractError("direct line already requested");
      this.#lines.add(id);
    } else {
      if (!this.#lines.has(id))
        throw new ContractError("no pending direct line");
      this.#lines.delete(id);
    }
    return cur as TaskState;
  }
}
