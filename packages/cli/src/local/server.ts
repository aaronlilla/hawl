import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ClientRequest,
  type Envelope,
  parseClientRequest,
  RELAY_SIG_COVERS,
  type SenderSig,
  verifySenderSig,
} from "@hawl/protocol/src/envelope.ts";
import { viewSha256 } from "@hawl/protocol/src/hash.ts";
import { newId } from "@hawl/protocol/src/ids.ts";
import {
  importPrivateJwk,
  importPublicJwk,
  type Jwk,
  keyId,
} from "@hawl/protocol/src/sign.ts";
import { writeFileDurable } from "../daemon/fsutil.ts";
import {
  type Request,
  readToken,
  request,
  socketPath,
  startSocketServer,
} from "../daemon/socket.ts";
import { daemonLink, runMcp, wrapMessage } from "../mcp/server.ts";
import {
  defaultLocalDir,
  type HandoffRec,
  type HandoffState,
  type LocalEvent,
  LocalLog,
  type LocalState,
  type MsgRec,
  type WorkerRec,
} from "./log.ts";

type Json = Record<string, unknown>;

const NO_FILES = "not available in local mode: files need an account";
const TOWN_ID = "twn_00000000-0000-7000-8000-000000000000";
const DAY_MS = 86_400_000;

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || !v) throw new Error(`${what} is required`);
  return v;
}

/** The whole local site: one machine, one append-only log, state rebuilt from it on start. */
export class LocalHub {
  readonly state: LocalState;
  private readonly seen = new Map<string, string>();
  private readonly seenTools = new Map<string, unknown>();

  readonly log: LocalLog;
  private readonly now: () => Date;

  constructor(log: LocalLog, now: () => Date = () => new Date()) {
    this.log = log;
    this.now = now;
    this.state = log.replay();
    if (!this.state.siteChannel) {
      this.commit({ t: "site", at: this.at(), channel_id: newId("chn") });
    }
  }

  private at(): string {
    return this.now().toISOString();
  }

  private commit(ev: LocalEvent): void {
    this.log.append(ev);
    this.state.apply(ev);
  }

  // ---- workers ----

  /** Register a worker by handle. Idempotent: the same handle returns the same resident. */
  join(a: { handle: string; platform?: string; pub: Jwk }): {
    resident_id: string;
    handle: string;
  } {
    const handle = str(a.handle, "handle");
    if (!/^@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(handle)) {
      throw new Error("bad handle");
    }
    for (const w of this.state.workers.values()) {
      if (w.handle === handle) return { resident_id: w.resident_id, handle };
    }
    const resident_id = newId("res");
    this.commit({
      t: "worker",
      at: this.at(),
      resident_id,
      handle,
      platform: a.platform ?? "claude_code",
      pub: a.pub,
    });
    return { resident_id, handle };
  }

  private worker(rid: unknown): WorkerRec {
    const w = typeof rid === "string" ? this.state.workers.get(rid) : undefined;
    if (!w) throw new Error("unknown worker");
    return w;
  }

  private byHandle(handle: unknown): WorkerRec {
    for (const w of this.state.workers.values()) {
      if (w.handle === handle) return w;
    }
    throw new Error(`unknown worker ${String(handle)}`);
  }

  // ---- mailbox ----

  private recipients(m: MsgRec): string[] {
    if (m.to.kind === "worker") return [m.to.resident_id];
    return [...this.state.workers.values()]
      .filter((w) => w.resident_id !== m.from && w.joined_seq < m.seq)
      .map((w) => w.resident_id);
  }

  private visibleTo(m: MsgRec, rid: string): boolean {
    return m.from === rid || this.recipients(m).includes(rid);
  }

  envelope(m: MsgRec, recipient: string): Envelope {
    const from = this.worker(m.from);
    const view = { parts: m.parts };
    return {
      v: 1,
      client_request: m.client_request ?? "",
      view,
      relay: {
        message_id: m.message_id,
        conversation_id: m.conversation_id,
        task_id: null,
        from: {
          resident_id: from.resident_id,
          handle: from.handle,
          town_id: TOWN_ID,
          town_slug: "local",
          owner_user_id: "local",
          platform: from.platform,
          key_id: keyId(from.pub as Jwk),
          key_state: "active",
        },
        origin: "agent",
        effective_intent: m.intent as Envelope["relay"]["effective_intent"],
        received_at: m.at,
        expires_at: new Date(Date.parse(m.at) + 30 * DAY_MS).toISOString(),
        request_hash: "",
        content_sha256: "",
        view_sha256: viewSha256(view),
        loop: {
          turn: 0,
          turn_cap: 0,
          hop: 0,
          hop_cap: 0,
          trace: [],
          last_human_touch_at: null,
        },
        trust: { scope: "same_town", taint: "none", taint_sources: [] },
        scan: { verdict: "unscanned" },
        approval: null,
        ...(m.handoff ? { handoff: m.handoff } : {}),
        delivery: {
          recipient_resident_id: recipient,
          inbox_seq: m.seq,
          attempt: 1,
        },
      },
      relay_sig: {
        alg: "ES256",
        kid: "local",
        covers: RELAY_SIG_COVERS,
        sig: "",
      },
    };
  }

  mailbox(rid: string, unreadOnly: boolean): { envelopes: Envelope[] } {
    this.worker(rid);
    const read = this.state.reads.get(rid) ?? new Set<string>();
    const envelopes = this.state.msgs
      .filter((m) => this.recipients(m).includes(rid))
      .filter((m) => !unreadOnly || !read.has(m.message_id))
      .map((m) => this.envelope(m, rid));
    return { envelopes };
  }

  markRead(rid: string, ids: string[]): { ok: true } {
    this.worker(rid);
    this.commit({
      t: "read",
      at: this.at(),
      resident_id: rid,
      message_ids: ids,
    });
    return { ok: true };
  }

  notice(rid?: string): { unread: number; needs_action: number } {
    const ids = rid ? [rid] : [...this.state.workers.keys()];
    let unread = 0;
    let needs_action = 0;
    for (const id of ids) {
      for (const e of this.mailbox(id, true).envelopes) {
        unread += 1;
        const i = e.relay.effective_intent;
        if (i === "request_action" || i === "ask") needs_action += 1;
      }
    }
    return { unread, needs_action };
  }

  // ---- sends ----

  private roomChannel(name: string): string {
    const have = this.state.rooms.get(name);
    if (have) return have;
    const channel_id = newId("chn");
    this.commit({ t: "room", at: this.at(), name, channel_id });
    return channel_id;
  }

  resolve(rid: string, tool: string, args: Json) {
    this.worker(rid);
    const site = this.state.siteChannel as string;
    const none = { conversation_id: null, reply_to: null };
    switch (tool) {
      case "square_post":
        return {
          to: { kind: "channel", channel_id: site, mentions: [] },
          ...none,
        };
      case "room_post":
        return {
          to: {
            kind: "channel",
            channel_id: this.roomChannel(str(args.room, "room")),
            mentions: [],
          },
          ...none,
        };
      case "handoff":
      case "dm_send": {
        const to = this.byHandle(args.to);
        const reply =
          typeof args.reply_to === "string"
            ? this.state.msgById.get(args.reply_to)
            : undefined;
        return {
          to: { kind: "worker", resident_id: to.resident_id },
          conversation_id: reply?.conversation_id ?? null,
          reply_to: reply?.message_id ?? null,
        };
      }
      case "thread_reply": {
        const m = this.state.msgById.get(str(args.message_id, "message_id"));
        if (!m || !this.visibleTo(m, rid)) throw new Error("unknown message");
        const to =
          m.to.kind === "channel"
            ? { kind: "channel", channel_id: m.to.channel_id, mentions: [] }
            : {
                kind: "worker",
                resident_id: m.from === rid ? m.to.resident_id : m.from,
              };
        return {
          to,
          conversation_id: m.conversation_id,
          reply_to: m.message_id,
        };
      }
      default:
        throw new Error(`${tool} does not send`);
    }
  }

  /** Parses a client_request after checking it against the sending worker's own key. */
  private verified(
    rid: string,
    clientRequest: string,
    senderSig: SenderSig,
  ): ClientRequest {
    const w = this.worker(rid);
    if (
      !senderSig ||
      !verifySenderSig(clientRequest, senderSig, importPublicJwk(w.pub as Jwk))
    ) {
      throw new Error("bad sender signature");
    }
    const cr: ClientRequest = parseClientRequest(clientRequest);
    if (cr.sender_resident_id !== rid) throw new Error("sender mismatch");
    return cr;
  }

  /**
   * A send tool with effects beyond the message (handoff), as `hawl mcp` calls it: the signed
   * request is checked like `send`, then the tool runs and posts the ask itself.
   */
  sendTool(
    rid: string,
    name: string,
    args: Json,
    clientRequest: string,
    senderSig: SenderSig,
  ) {
    const cr = this.verified(rid, clientRequest, senderSig);
    if (name !== "handoff") throw new Error(`${name} does not send`);
    const prior = this.seenTools.get(cr.idempotency_key);
    if (prior) return prior;
    const r = this.tool(rid, name, args);
    this.seenTools.set(cr.idempotency_key, r);
    return r;
  }

  /** A signed client_request from a worker, checked against that worker's own key. */
  send(rid: string, clientRequest: string, senderSig: SenderSig) {
    const cr = this.verified(rid, clientRequest, senderSig);
    const prior = this.seen.get(cr.idempotency_key);
    if (prior) return { message_id: prior, state: "delivered" };
    const m = this.post(rid, cr.to, cr.intent, cr.content.parts, {
      conversation_id: cr.conversation_id,
      reply_to: cr.reply_to ?? null,
      client_request: clientRequest,
    });
    this.seen.set(cr.idempotency_key, m.message_id);
    return { message_id: m.message_id, state: "delivered" };
  }

  private post(
    from: string,
    to: MsgRec["to"],
    intent: string,
    parts: MsgRec["parts"],
    o: {
      conversation_id?: string | null;
      reply_to?: string | null;
      client_request?: string;
      handoff?: MsgRec["handoff"];
    } = {},
  ): MsgRec {
    const message_id = newId("msg");
    this.commit({
      t: "msg",
      at: this.at(),
      message_id,
      conversation_id: o.conversation_id ?? newId("cnv"),
      from,
      to,
      intent,
      parts,
      reply_to: o.reply_to ?? null,
      ...(o.client_request ? { client_request: o.client_request } : {}),
      ...(o.handoff ? { handoff: o.handoff } : {}),
    });
    return this.state.msgById.get(message_id) as MsgRec;
  }

  // ---- tools that carry no signature ----

  tool(rid: string, name: string, a: Json): unknown {
    const me = this.worker(rid);
    switch (name) {
      case "who":
        return {
          workers: [...this.state.workers.values()]
            .filter(
              (w) => typeof a.query !== "string" || w.handle.includes(a.query),
            )
            .map((w) => ({
              handle: w.handle,
              owner_display: "local",
              platform: w.platform,
              status: w.status,
              status_age_s: Math.max(
                0,
                Math.floor(
                  (this.now().getTime() - Date.parse(w.status_at)) / 1000,
                ),
              ),
              working_on: w.working_on,
              yard: null,
              can_message: true,
            })),
        };
      case "status_set":
        this.commit({
          t: "status",
          at: this.at(),
          resident_id: rid,
          state: a.state as WorkerRec["status"],
          working_on: typeof a.working_on === "string" ? a.working_on : null,
        });
        return { ok: true };
      case "thread_read": {
        const limit = typeof a.limit === "number" ? a.limit : 20;
        const msgs = this.state.msgs
          .filter(
            (m) =>
              m.conversation_id === a.conversation_id && this.visibleTo(m, rid),
          )
          .slice(-limit);
        return {
          messages: msgs.map((m) => ({
            message_id: m.message_id,
            text: wrapMessage(this.envelope(m, rid)),
          })),
        };
      }
      case "handoff":
        return this.handoff(me, a);
      case "handoff_update":
        return this.handoffUpdate(me, a);
      case "handoff_list":
        return {
          handoffs: [...this.state.handoffs.values()]
            .filter((h) => !a.state || h.state === a.state)
            .filter(
              (h) =>
                a.mine !== true ||
                h.sender === me.handle ||
                h.assignee === me.handle,
            )
            .map((h) => ({
              handoff_id: h.handoff_id,
              state: h.state,
              title: h.title,
              task_type: h.task_type,
              quality_bar: h.quality_bar,
              sender: h.sender,
              assignee: h.assignee,
              verifier: h.verifier,
              deadline: h.deadline,
              updated_at: h.updated_at,
            })),
        };
      case "board_pin": {
        const m = this.state.msgById.get(str(a.message_id, "message_id"));
        if (!m || !this.visibleTo(m, rid)) throw new Error("unknown message");
        this.commit({
          t: "pin",
          message_id: m.message_id,
          title: str(a.title, "title"),
          pinned_by: me.handle,
          pinned_at: this.at(),
        });
        return { ok: true };
      }
      case "board_read":
        return {
          pins: this.state.pins.map((p) => {
            const m = this.state.msgById.get(p.message_id);
            return {
              ...p,
              ...(m ? { text: wrapMessage(this.envelope(m, rid)) } : {}),
            };
          }),
        };
      case "file_put":
      case "file_get":
        throw new Error(NO_FILES);
      case "ask_town":
        throw new Error("not available in local mode: there is no dispatcher");
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  private handoff(me: WorkerRec, a: Json) {
    const assignee = a.to ? this.byHandle(a.to) : null;
    const handoff_id = newId("hnd");
    const conversation_id = newId("cnv");
    const criteria =
      (a.criteria as { id: string; text: string; check: string }[]) ?? [];
    const text = [
      `Handoff ${handoff_id}: ${String(a.title)}`,
      String(a.spec),
      "Criteria:",
      ...criteria.map((c) => `- ${c.id}: ${c.text} (${c.check})`),
    ].join("\n");
    const to: MsgRec["to"] = assignee
      ? { kind: "worker", resident_id: assignee.resident_id }
      : {
          kind: "channel",
          channel_id: this.state.siteChannel as string,
          mentions: [],
        };
    const m = this.post(
      me.resident_id,
      to,
      "request_action",
      [{ kind: "text", text }],
      {
        conversation_id,
        handoff: { handoff_id, state: "asked", op: "create" },
      },
    );
    this.commit({
      t: "handoff",
      handoff_id,
      state: "asked",
      title: String(a.title),
      task_type: String(a.task_type),
      quality_bar: (a.quality_bar as HandoffRec["quality_bar"]) ?? "standard",
      sender: me.handle,
      assignee: assignee?.handle ?? null,
      verifier: typeof a.verifier === "string" ? a.verifier : null,
      deadline: typeof a.deadline === "string" ? a.deadline : null,
      conversation_id,
      updated_at: this.at(),
    });
    return { handoff_id, state: "asked", message_id: m.message_id };
  }

  private handoffUpdate(me: WorkerRec, a: Json) {
    const h = this.state.handoffs.get(str(a.handoff_id, "handoff_id"));
    if (!h) throw new Error("unknown handoff");
    const op = str(a.op, "op");
    const isSender = h.sender === me.handle;
    const isAssignee = h.assignee === me.handle;
    const deny = (): never => {
      throw new Error(`cannot ${op} a handoff that is ${h.state}`);
    };
    let state: HandoffState;
    let assignee = h.assignee;
    let notify: string;
    switch (op) {
      case "accept":
        if (h.state !== "asked" || isSender || (h.assignee && !isAssignee)) {
          deny();
        }
        state = "accepted";
        assignee = me.handle;
        notify = h.sender;
        break;
      case "decline":
        if (h.state !== "asked" || !isAssignee) deny();
        state = "declined";
        notify = h.sender;
        break;
      case "done":
        if (h.state !== "accepted" || !isAssignee) deny();
        state = "done";
        notify = h.verifier?.startsWith("@") ? h.verifier : h.sender;
        break;
      case "verify":
      case "reject": {
        const okVerifier = h.verifier?.startsWith("@")
          ? h.verifier === me.handle
          : !isAssignee;
        if (h.state !== "done" || !okVerifier) deny();
        state = op === "verify" ? "verified" : "accepted";
        notify = h.assignee as string;
        break;
      }
      case "cancel":
        if (!isSender || (h.state !== "asked" && h.state !== "accepted")) {
          deny();
        }
        state = "cancelled";
        notify = h.assignee ?? h.sender;
        break;
      case "reassign": {
        if (!isSender || (h.state !== "asked" && h.state !== "accepted")) {
          deny();
        }
        const next = this.byHandle(a.to);
        state = "asked";
        assignee = next.handle;
        notify = next.handle;
        break;
      }
      default:
        throw new Error(`unknown op ${op}`);
    }
    this.commit({
      t: "handoff_state",
      at: this.at(),
      handoff_id: h.handoff_id,
      state,
      assignee,
    });
    if (notify !== me.handle) {
      const note = typeof a.reason === "string" ? ` ${a.reason}` : "";
      const evidence = a.evidence
        ? ` evidence ${JSON.stringify(a.evidence)}`
        : "";
      this.post(
        me.resident_id,
        { kind: "worker", resident_id: this.byHandle(notify).resident_id },
        "status",
        [
          {
            kind: "text",
            text: `Handoff ${h.handoff_id} ${op}: now ${state}.${note}${evidence}`,
          },
        ],
        {
          conversation_id: h.conversation_id,
          handoff: { handoff_id: h.handoff_id, state, op },
        },
      );
    }
    return { state };
  }

  // ---- socket dispatch (same wire as the real daemon) ----

  handle = (req: Request): unknown => {
    const rid = typeof req.resident_id === "string" ? req.resident_id : "";
    switch (req.op) {
      case "join":
        return this.join(
          req as unknown as { handle: string; platform?: string; pub: Jwk },
        );
      case "status":
        return {
          pid: process.pid,
          mode: "local",
          workers: [...this.state.workers.values()].map((w) => ({
            resident_id: w.resident_id,
            handle: w.handle,
            unread: this.mailbox(w.resident_id, true).envelopes.length,
          })),
        };
      case "notice":
        return this.notice(rid || undefined);
      case "activity":
        return { queued: false };
      case "mailbox":
        return this.mailbox(rid, req.unread_only === true);
      case "mark_read":
        return this.markRead(rid, (req.message_ids as string[]) ?? []);
      case "resolve":
        return this.resolve(
          rid,
          str(req.tool, "tool"),
          (req.args as Json) ?? {},
        );
      case "send":
        return this.send(
          rid,
          str(req.client_request, "client_request"),
          req.sender_sig as SenderSig,
        );
      case "send_tool":
        return this.sendTool(
          rid,
          str(req.name, "name"),
          (req.args as Json) ?? {},
          str(req.client_request, "client_request"),
          req.sender_sig as SenderSig,
        );
      case "tool":
        return this.tool(rid, str(req.name, "name"), (req.args as Json) ?? {});
      default:
        throw new Error(`unknown op ${req.op}`);
    }
  };
}

/** True when a hub already answers on this state dir's socket. */
export async function localHubRunning(dir: string): Promise<boolean> {
  const token = readToken(dir);
  if (!token) return false;
  try {
    return (await request(socketPath(dir), { op: "status", token }, 1000)).ok;
  } catch {
    return false;
  }
}

/**
 * `hawl local`: serve the hub on the daemon's socket for this state dir. Refuses when a hub
 * already serves it: a second one would take over the socket and split the workers between two logs.
 */
export async function startLocalServer(
  opts: { dir?: string; now?: () => Date } = {},
) {
  const dir = opts.dir ?? defaultLocalDir();
  if (await localHubRunning(dir))
    throw Object.assign(new Error(`a hub already serves ${dir}`), {
      code: "already_running",
    });
  const hub = new LocalHub(new LocalLog(dir), opts.now);
  const sock = await startSocketServer(dir, (req) => {
    if (req.op === "shutdown") {
      setTimeout(() => void sock.close(), 50);
      return { stopped: true };
    }
    return hub.handle(req);
  });
  return { hub, dir, ...sock };
}

// ---- worker keys: one 0600 JWK per worker in <dir>/keys ----

export function keyFile(dir: string, residentId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(residentId)) throw new Error("bad resident id");
  return join(dir, "keys", `${residentId}.jwk`);
}

export function saveKey(
  dir: string,
  residentId: string,
  privateJwk: Jwk,
): void {
  writeFileDurable(keyFile(dir, residentId), JSON.stringify(privateJwk));
}

export function loadLocalSigner(dir: string, residentId: string) {
  const f = keyFile(dir, residentId);
  if (!existsSync(f)) throw new Error(`no key for ${residentId}`);
  const jwk = JSON.parse(readFileSync(f, "utf8")) as Jwk;
  const { d: _d, ...pub } = jwk;
  return { kid: keyId(pub), privateKey: importPrivateJwk(jwk) };
}

/**
 * Starts `hawl local` for `dir`, detached, with this same CLI entry. A visitor who ran
 * `npx hawl.ai join --local` has no `hawl` on PATH, and `hawl daemon` would serve the account
 * wire, not the local hub.
 */
export function spawnLocalHub(dir: string): void {
  const entry = process.argv[1];
  if (!entry) return;
  const child = spawn(process.execPath, [...process.execArgv, entry, "local"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, HAWL_HOME: dir },
  });
  child.on("error", () => {});
  child.unref();
}

/** `hawl mcp --local`: the stdio MCP server wired to the local hub, started on first use. */
export function runLocalMcp(dir: string, residentId: string): void {
  runMcp({
    // A cold `node` start can take a few seconds on a slow machine; starting a second hub
    // meanwhile would be refused, but waiting is cheaper than a spawn.
    daemon: daemonLink(dir, { spawn: spawnLocalHub, startWaitMs: 15_000 }),
    residentId,
    signer: loadLocalSigner(dir, residentId),
  });
}

if (import.meta.main) {
  const dir = process.env.HAWL_HOME ?? defaultLocalDir();
  const rid = process.env.HAWL_RESIDENT_ID;
  if (rid) {
    runLocalMcp(dir, rid);
  } else if (await localHubRunning(dir)) {
    process.stderr.write(`hawl local: already serving ${dir}\n`);
  } else {
    const s = await startLocalServer({ dir });
    process.stderr.write(`hawl local: serving ${dir}\n`);
    process.on("SIGINT", () => void s.close().then(() => process.exit(0)));
  }
}
