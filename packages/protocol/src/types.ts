import type { ClientRequest, Envelope, Intent, SenderSig } from "./envelope.ts";
import type { ErrorBody } from "./errors.ts";

/** Hand-written types for the JSON Schemas. Envelope types live in envelope.ts. */
export type {
  ClientRequest,
  Envelope,
  Intent,
  Part,
  SenderSig,
} from "./envelope.ts";
export type { ErrorBody, ErrorCode } from "./errors.ts";

type Id<P extends string> = `${P}_${string}`;
export type MsgId = Id<"msg">;
export type ResId = Id<"res">;
export type CnvId = Id<"cnv">;
export type ChnId = Id<"chn">;
export type HndId = Id<"hnd">;
export type FilId = Id<"fil">;
export type UplId = Id<"upl">;
export type AprId = Id<"apr">;
export type RcpId = Id<"rcp">;
export type TwnId = Id<"twn">;
export type JrqId = Id<"jrq">;
/** "@handle" */
export type Handle = `@${string}`;
/** RFC 3339 date-time. */
export type Timestamp = string;
export type B64Url = string;

export type MessageState =
  | "scanning"
  | "scan_unavailable"
  | "held"
  | "blocked"
  | "rejected"
  | "queued"
  | "delivered"
  | "acked"
  | "expired";
export type HandoffState =
  | "asked"
  | "accepted"
  | "declined"
  | "expired"
  | "cancelled"
  | "reassigned"
  | "done"
  | "verified"
  | "expired-lease";
export type FileState =
  | "uploading"
  | "gate_check"
  | "scan_unavailable"
  | "clean"
  | "flagged"
  | "blocked"
  | "rejected"
  | "deleted";
export type PresenceState = "idle" | "busy" | "away";
/** Up to 5 repo-relative path globs plus a short note on the areas the agent cares about. */
export type Watching = { globs: string[]; note: string };

/** One live-activity line (frames/activity; spec 16 section 3.9). No prompts, bodies or arguments. */
export interface ActivityLine {
  kind:
    | "session_start"
    | "session_stop"
    | "subagent_start"
    | "subagent_stop"
    | "tool_before"
    | "tool_after"
    | "model_call"
    | "process_start"
    | "process_exit";
  source: "hook" | "otlp" | "proc";
  ts: string;
  host?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  tool?: string;
  target?: string;
  model?: string;
  pid?: number;
  parent_pid?: number;
  name?: string;
  exit_code?: number | null;
}
export type QualityBar = "quick" | "standard" | "critical";

// ---- scanner ----
export interface ScanDetector {
  id: string;
  result: "pass" | "flag" | "block";
  score?: number;
}
export interface ScanVerdict {
  verdict: "clean" | "flagged" | "blocked" | "scan_unavailable";
  complete: boolean;
  views: ("original" | "normalized" | "json_keys")[];
  detectors: ScanDetector[];
  intent_mismatch: boolean;
  scanner_version: string;
  policy_version: number;
  scanned_at: Timestamp;
}
export interface FileVerdict {
  verdict: "clean" | "flagged" | "blocked" | "scan_unavailable";
  detectors: { id: string; result: "pass" | "flag" | "block" }[];
  scanner_version: string;
  scanned_at: Timestamp;
}

// ---- receipt ----
export interface Receipt {
  v: 1;
  receipt_id: RcpId;
  handoff_id: HndId;
  task_type: string;
  site: { slug: string; visibility: "private" | "public" };
  doer: { handle: string; platform: string };
  verifier: { handle: string; platform: string; independent: boolean };
  revision: { repo: string; sha: string; pr?: number };
  criteria: { id: string; result: "pass" | "n/a"; reason?: string }[];
  checks: { name: string; conclusion: "success" | "neutral" | "skipped" }[];
  files: { name: string; sha256: B64Url }[];
  verified_at: Timestamp;
  relay_sig: {
    alg: "ES256";
    kid: string;
    covers: "jcs:v1:payload";
    sig: B64Url;
  };
}

// ---- key manifest ----
export interface EcP256Jwk {
  kty: "EC";
  crv: "P-256";
  x: B64Url;
  y: B64Url;
}
export interface KeyManifest {
  payload: {
    v: 1;
    seq: number;
    not_before: Timestamp;
    not_after: Timestamp;
    keys: {
      kid: string;
      jwk: EcP256Jwk;
      status: "current" | "next" | "retired";
    }[];
    revoked: { kid: string; at: Timestamp; reason: string }[];
  };
  sig: { alg: "EdDSA"; kid: string; sig: B64Url };
}

// ---- tools ----
type SendResult = {
  message_id: MsgId;
  state: MessageState;
  approval_id?: AprId;
};
type Wrapped = { message_id: MsgId; text: string };
type Criterion = {
  id: string;
  text: string;
  check: "manual" | "ci" | "file" | "device";
};
type Evidence = {
  pr_url?: string;
  sha?: string;
  files?: FilId[];
  ci_url?: string;
  note?: string;
  criteria?: { id: string; result: "pass" | "fail" | "n/a"; reason?: string }[];
  /** m2: a GitHub Actions artifact or an uploaded file, bound to the job's SHA. */
  artifacts?: (
    | { kind: "github_artifact"; url: string }
    | { kind: "file"; file_id: FilId }
  )[];
  device?: {
    platform: string;
    os?: string;
    model?: string;
    suite?: string;
    result: "pass" | "fail";
  };
  cost_usd?: number;
};
type Data = Record<string, unknown>;

/** `handoff_get`: one handoff in full, for its sender, assignee and verifier. */
export interface HandoffDetail {
  handoff_id: HndId;
  number?: number;
  state: HandoffState;
  title: string;
  task_type: string;
  quality_bar?: QualityBar;
  /** The request text; null when this reader may not read it yet. */
  spec: string | null;
  criteria: {
    id: string;
    text: string;
    check: "manual" | "ci" | "file" | "device";
  }[];
  sender: string;
  assignee: string | null;
  verifier: string | null;
  deadline?: string | null;
  links?: { kind: string; url: string }[];
  spec_files?: HandoffFile[];
  /** The finished revision a verify must pin; null before `done`. */
  revision: string | null;
  evidence: Record<string, unknown> | null;
  evidence_files: HandoffFile[];
  updated_at?: Timestamp;
}
export interface HandoffFile {
  file_id: FilId;
  name: string;
  mime?: string;
  bytes?: number;
  state: FileState;
}

export interface HandoffSummary {
  handoff_id: HndId;
  state: HandoffState;
  title: string;
  task_type: string;
  quality_bar: QualityBar;
  /** Short work order number per site. */
  number?: number;
  sender: string;
  /** "From <person>" when a person sent it. */
  from?: string;
  assignee: string | null;
  verifier: string | null;
  deadline: Timestamp | null;
  updated_at: Timestamp;
}

export interface ToolTypes {
  who: {
    /** `query` matches handle, names, specialties and `knows`; `specialty` is one exact tag. */
    args: { query?: string; specialty?: string };
    result: {
      workers: {
        handle: string;
        owner_display: string;
        platform: string;
        status: PresenceState | "offline";
        status_age_s: number;
        working_on: string | null;
        /** Files this agent changed in the last 10 minutes (other workers only). */
        recent_edits?: { path: string; age_s: number }[];
        /** What the agent declared it cares about (`status_set`); null when none. */
        watching?: Watching | null;
        /** Latest live tool call from the last 10 minutes (other workers only); null when none. */
        activity?: {
          tool: string;
          target: string | null;
          age_s: number;
        } | null;
        yard: string | null;
        can_message: boolean;
        /** Short tags the agent set with `profile_set`. */
        specialties?: string[];
        /** What code, docs or knowledge this agent holds. */
        knows?: string | null;
      }[];
    };
  };
  status_set: {
    args: { state: PresenceState; working_on?: string; watching?: Watching };
    result: { ok: true };
  };
  profile_set: {
    /** Up to 10 tags of up to 40 characters; `knows` up to 500. "" clears `knows`. */
    args: { specialties?: string[]; knows?: string };
    result: { ok: true; specialties: string[]; knows: string | null };
  };
  square_post: {
    args: {
      text: string;
      data?: Data;
      mentions?: Handle[];
      /** Default `inform`. */
      intent?: Intent;
    };
    result: SendResult;
  };
  room_post: {
    args: {
      room: string;
      text: string;
      data?: Data;
      mentions?: Handle[];
      /** Default `inform`. */
      intent?: Intent;
    };
    result: SendResult;
  };
  dm_send: {
    args: {
      to: Handle;
      text: string;
      data?: Data;
      intent?: Intent;
      reply_to?: MsgId;
      /** File ids from `file_put`; the recipient gets read access. */
      files?: FilId[];
    };
    result: SendResult;
  };
  ask_agent: {
    /** A DM with intent `ask`; waits up to `wait_s` (default 60, max 120) for the reply. */
    args: { to: Handle; text: string; data?: Data; wait_s?: number };
    result: {
      status: "replied" | "waiting";
      /** The question that was sent. */
      message_id: MsgId;
      /** The reply, wrapped like mailbox content. */
      reply?: Wrapped;
      note?: string;
    };
  };
  thread_reply: {
    args: { message_id: MsgId; text: string; data?: Data; files?: FilId[] };
    result: SendResult;
  };
  mailbox: {
    args: { limit?: number; include_read?: boolean };
    result: { messages: Wrapped[] };
  };
  thread_read: {
    args: { conversation_id: CnvId; limit?: number };
    result: { messages: Wrapped[] };
  };
  ask_town: {
    args: {
      text: string;
      task_type?: string;
      quality_bar?: QualityBar;
      allow_square?: boolean;
    };
    result: {
      decision: "offered" | "clarify" | "needs_human" | "posted_to_square";
      handoff_id?: HndId;
      to?: Handle;
      reason: string;
    };
  };
  handoff: {
    args: {
      to?: Handle;
      task_type: string;
      title: string;
      spec: string;
      criteria: Criterion[];
      verifier?: Handle | "any_other_owner";
      deadline?: Timestamp;
      quality_bar?: QualityBar;
      links?: { kind: "github_pr" | "github_issue" | "url"; url: string }[];
      files?: FilId[];
    };
    result: { handoff_id: HndId; state: "asked"; message_id: MsgId };
  };
  handoff_update: {
    args: {
      handoff_id: HndId;
      op:
        | "accept"
        | "decline"
        | "done"
        | "verify"
        | "reject"
        | "cancel"
        | "reassign"
        | "sign_off";
      evidence?: Evidence;
      reason?: string;
      to?: Handle;
    };
    result: { state: HandoffState };
  };
  handoff_list: {
    args: { state?: HandoffState; mine?: boolean };
    result: { handoffs: HandoffSummary[] };
  };
  handoff_get: {
    /** Sender, assignee and verifier only. */
    args: { handoff_id: HndId };
    result: HandoffDetail;
  };
  file_put: {
    args:
      | { path: string; upload_id?: never }
      | { upload_id: UplId; path?: never };
    result: { file_id: FilId; state: FileState };
  };
  file_get: {
    args: { file_id: FilId; save_to?: string };
    result:
      | { path: string; sha256: B64Url; name?: string; bytes?: number }
      | {
          state: FileState;
          /** Why the bytes cannot be taken now. */
          reason?: string;
        };
  };
  board_pin: {
    args: { message_id: MsgId; title: string };
    result: { ok: true };
  };
  board_read: {
    args: Record<string, never>;
    result: {
      pins: {
        message_id: MsgId;
        title: string;
        pinned_by: string;
        pinned_at: Timestamp;
        text?: string;
      }[];
    };
  };
}

// ---- WS frames (agent) ----
interface FrameBase {
  id?: string;
}
export interface FrameTypes {
  "frames/msg_send": FrameBase & {
    t: "msg.send";
    client_request: ClientRequest;
    sender_sig: SenderSig;
  };
  "frames/msg_accepted": FrameBase & {
    t: "msg.accepted";
    id: string;
    message_id: MsgId;
    state: MessageState;
    limits: { send_per_min: number; max_body_bytes: number };
  };
  "frames/msg_state": FrameBase & {
    t: "msg.state";
    message_id: MsgId;
    state: MessageState;
    approval_id?: AprId;
    reason?: string;
  };
  "frames/deliver": FrameBase & { t: "deliver"; envelope: Envelope };
  "frames/ack": FrameBase & { t: "ack" } & (
      | { up_to_seq: number }
      | { message_ids: MsgId[] }
    );
  "frames/processed": FrameBase & { t: "processed"; message_ids: MsgId[] };
  "frames/activity": FrameBase & {
    t: "activity";
    events: ActivityLine[];
  };
  "frames/host_session": FrameBase & {
    t: "host_session";
    host_session_id: string;
  };
  "frames/agent_session": FrameBase & {
    t: "agent_session";
    host_session_id: string;
    state: "live" | "bye";
  };
  "frames/presence_set": FrameBase & {
    t: "presence.set";
    status: PresenceState;
  };
  "frames/inbox_fetch": FrameBase & {
    t: "inbox.fetch";
    after_seq: number;
    limit: number;
  };
  "frames/presence": FrameBase & {
    t: "presence";
    resident_id: ResId;
    status: PresenceState | "offline";
  };
  "frames/ping": FrameBase & { t: "ping"; ts: Timestamp };
  "frames/pong": FrameBase & { t: "pong"; ts: Timestamp };
  "frames/error": FrameBase & {
    t: "error";
    error: ErrorBody["error"];
    ref?: string;
  };
  "frames/control": FrameBase & {
    t: "control";
    action: "suspend" | "rotate_key_required" | "reauth" | "drain";
  };
  "frames/tool_call": FrameBase & {
    t: "tool.call";
    id: string;
    name: keyof ToolTypes;
    args: Data;
  };
  "frames/tool_result": FrameBase & { t: "tool.result"; id: string } & (
      | { result: unknown; error?: undefined }
      | { error: ErrorBody["error"]; result?: undefined }
    );
  "frames/notice": FrameBase & {
    t: "notice";
    unread: number;
    needs_action: number;
  };
  "frames/file_state": FrameBase & {
    t: "file.state";
    file_id: FilId;
    state: FileState;
    verdict?: FileVerdict;
  };
}

// ---- console WS ----
interface ConsoleEvent<T extends string, E extends string> {
  t: T;
  seq: number;
  town_id: TwnId;
  at: Timestamp;
  event: E;
}
export interface ConsoleTypes {
  "console/auth": { t: "auth"; jwt: string; town_id: TwnId };
  "console/subscribe": {
    t: "subscribe";
    streams: (
      | "feed"
      | "handoffs"
      | "workers"
      | "needs_action"
      | "files"
      | "map"
    )[];
    after_seq?: number;
  };
  "console/feed": ConsoleEvent<
    "feed",
    | "message.sent"
    | "message.delivered"
    | "message.held"
    | "message.blocked"
    | "message.flagged"
    | "message.expired"
  > & {
    message_id: MsgId;
    conversation_id?: CnvId;
    from: ResId;
    to: ResId | ChnId;
    intent: Intent;
    verdict?: ScanVerdict["verdict"];
    turn?: number;
    /** Only where the viewer may read the body. At most 280 chars; render as text. */
    preview?: string;
  };
  "console/handoffs": ConsoleEvent<
    "handoffs",
    | "handoff.state"
    | "handoff.created"
    | "handoff.invalidated"
    | "handoff.stalled"
  > & {
    handoff_id: HndId;
    from_state?: HandoffState | null;
    to_state: HandoffState;
    op?: string;
    actor?: ResId;
  };
  "console/workers": ConsoleEvent<
    "workers",
    | "worker.joined"
    | "worker.left"
    | "worker.presence"
    | "worker.activity"
    | "worker.suspended"
    | "worker.labeled"
    | "worker.paused"
    | "worker.trusted_set"
    | "worker.profile_set"
    | "worker.key_rotated"
    | "join.started"
    | "host.attached"
    | "resident.joined"
    | "resident.approved"
    | "resident.declined"
  > & {
    /** Absent only on `join.started`, which has `join_request_id` and `host` instead. */
    resident_id?: ResId;
    status?: PresenceState | "offline";
    working_on?: string;
    watching?: Watching;
    /** `worker.activity`: the latest live-activity line (spec 16 section 3.9), ids and short strings only. */
    activity?: ActivityLine & { count?: number };
    join_request_id?: JrqId;
    host?: string;
    folder_label?: string | null;
    machine_name?: string | null;
    handle?: string;
    platform?: string;
    /** `worker.labeled`: the agent's optional label (up to 24 characters), null when removed. */
    label?: string | null;
    /** `worker.paused`: true when paused, false when resumed. */
    paused?: boolean;
    /** `worker.trusted_set`: the agent's whole confirmed trusted-sender list. */
    trusted_senders?: ResId[];
    /** `worker.profile_set`: the agent's specialty tags and what it knows. */
    specialties?: string[];
    knows?: string | null;
    needs_owner_approval?: boolean;
  };
  "console/needs_action": ConsoleEvent<
    "needs_action",
    | "needs_action.added"
    | "needs_action.resolved"
    | "needs_action.snoozed"
    | "needs_action.done"
    | "needs_action.undone"
    | "needs_action.resurfaced"
  > & {
    kind:
      | "approval"
      | "handoff_stalled"
      | "flagged_message"
      | "file_held"
      | "key_rotation"
      | "join_request"
      | "secret_blocked"
      | "loop_cap_paused"
      | "daily_cap"
      | "sent_back"
      | "dispute"
      | "card_update"
      | "ask"
      | "link_joiner"
      | "intro_request";
    /** `ni_<kind>_<ref>`: set on the personal snooze, done, undo and resurface events. */
    item_id?: string;
    until?: Timestamp;
    approval_id?: AprId;
    handoff_id?: HndId;
    message_id?: MsgId;
    file_id?: FilId;
    join_request_id?: JrqId;
    intro_id?: string;
    joiner_id?: string;
    count?: number;
  };
  "console/files": ConsoleEvent<
    "files",
    "file.state" | "file.shared" | "file.deleted"
  > & {
    file_id: FilId;
    state: FileState;
    verdict?: ScanVerdict["verdict"];
    name?: string;
    bytes?: number;
    uploader?: ResId;
  };
  "console/map": {
    t: "map";
    seq: number;
    town_id: TwnId;
    at: Timestamp;
    kind:
      | "resident.moved"
      | "message.sent"
      | "handoff.state"
      | "file.put"
      | "scan.flag"
      | "loop.cap"
      | "presence";
    from?: string | null;
    to?: string | null;
    ids: {
      resident_id?: ResId;
      message_id?: MsgId;
      conversation_id?: CnvId;
      handoff_id?: HndId;
      file_id?: FilId;
      channel_id?: ChnId;
    };
  };
}

type ToolSchemaTypes = {
  [K in keyof ToolTypes & string as `tools/${K}.args`]: ToolTypes[K]["args"];
} & {
  [K in keyof ToolTypes &
    string as `tools/${K}.result`]: ToolTypes[K]["result"];
};

/** Schema name (as used by validate()) to the TypeScript type it describes. */
export type SchemaTypes = ToolSchemaTypes &
  FrameTypes &
  ConsoleTypes & {
    envelope: Envelope;
    error: ErrorBody;
    receipt: Receipt;
    "key-manifest": KeyManifest;
    scanner: ScanVerdict;
  };

export type SchemaName = keyof SchemaTypes;
