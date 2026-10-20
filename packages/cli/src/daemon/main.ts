import type { KeyObject } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ActivityForwarder,
  type ActivityLine,
  ProcessPoller,
  sanitizeLine,
  startOtlpReceiver,
} from "./activity.ts";
import { countAimed } from "./aimed.ts";
import { ensureDir } from "./fsutil.ts";
import { CodexIdleWake } from "./idle-wake.ts";
import { type KeyStore, loadSigner, openKeyStore } from "./keys.ts";
import { announceFrames, LiveSessions } from "./live.ts";
import { ManifestStore, pinnedRoots, refreshManifest } from "./manifest.ts";
import { senderKeyFetcher } from "./senderkeys.ts";
import { SessionLog } from "./sessions.ts";
import {
  type Request,
  readToken,
  request,
  socketPath,
  startSocketServer,
} from "./socket.ts";
import { Spool } from "./spool.ts";
import {
  agentToken,
  downloadFile,
  fileMeta,
  tokenSource,
  uploadFile,
} from "./upload.ts";
import type { DropReason } from "./verify.ts";
import { forgetWorker, readWorkers, rememberWorker } from "./workers.ts";
import { WorkerConnection } from "./ws.ts";

/** How long a call waits for the startup attach before it is answered anyway. */
const STARTUP_WAIT_MS = 8_000;

export interface WorkerSpec {
  relay_url: string;
  resident_id: string;
  platform: string;
}

/** `who` returns handles with a leading @; older relays did not. */
const bare = (h: string | undefined): string => (h ?? "").replace(/^@/, "");

type ChannelItem = { channel_id: string; kind: string; name: string };

export interface DaemonOptions {
  stateDir?: string;
  keyStore?: KeyStore;
  manifests?: ManifestStore;
  senderKey?: (
    relayUrl: string,
    kid: string,
    at: string,
  ) => Promise<KeyObject | null>;
  fetch?: typeof fetch;
  workers?: WorkerSpec[];
  version?: string;
  /** OTLP receiver port on 127.0.0.1. Default 4318; 0 picks a free one. */
  otlpPort?: number;
  /** Replaces the relay WS sink for activity batches (tests). */
  activitySink?: (batch: ActivityLine[]) => boolean;
  /** Replaces the process lister (tests). */
  listProcesses?: () => Promise<{ pid: number; ppid: number; name: string }[]>;
  /** Called after a `shutdown` request has stopped the daemon. Default: exit 0, so autostart does not restart it. */
  onShutdown?: () => void;
  /** Codex idle wake: queue the fixed notice on a thread (tests). Default: `codex queue`. */
  codexQueue?: (threadId: string, unread: number) => Promise<boolean>;
  /** Seconds between idle-wake sweeps. Default 15; 0 turns the sweep off (relay notices still trigger). */
  idleWakeSweepMs?: number;
}

/** Thrown when another daemon already answers on this machine's socket. */
export class DaemonRunningError extends Error {
  readonly pid: number | undefined;
  constructor(pid: number | undefined) {
    super(`hawl daemon is already running${pid ? ` (pid ${pid})` : ""}`);
    this.name = "DaemonRunningError";
    this.pid = pid;
  }
}

/** One daemon per user: a second one would steal the socket and open duplicate WS sessions. */
async function runningDaemon(stateDir: string): Promise<number | null> {
  const token = readToken(stateDir);
  if (!token) return null;
  try {
    const r = await request(
      socketPath(stateDir),
      { op: "status", token },
      1000,
    );
    if (!r.ok) return null;
    return (r.result as { pid?: number }).pid ?? 0;
  } catch {
    return null; // stale token file or dead socket
  }
}

export function defaultStateDir(): string {
  return process.env.HAWL_HOME ?? join(homedir(), ".hawl");
}

function wsUrlFor(relayUrl: string): string {
  const u = new URL("/v1/ws", relayUrl);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  return u.toString();
}

/**
 * `file_put` answers `gate_check` while the scanner works. Poll the relay for up to `waitMs` so
 * the uploader gets the final state (and the reason when a file ends blocked). A scan that is
 * still running at the end returns `gate_check`; calling `file_put` again shows the result.
 */
export async function settleFilePut(
  call: () => Promise<unknown>,
  waitMs = 15_000,
  stepMs = 1_000,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<unknown> {
  let out = await call();
  for (let spent = 0; spent < waitMs; spent += stepMs) {
    const state = (out as { state?: unknown } | null)?.state;
    if (state !== "gate_check" && state !== "scan_unavailable") break;
    await sleep(stepMs);
    out = await call();
  }
  return out;
}

/**
 * What "N waiting" says. The relay counts every delivery the worker has not acked, including
 * ones this daemon dropped (failed verification, never spooled, never acked). Those are not
 * waiting for the agent: it cannot read them. Subtract them, unless they got spooled later.
 */
export function unreadCount(
  relayUnread: number,
  spoolUnread: number,
  dropped: ReadonlySet<string> | undefined,
  inSpool: (messageId: string) => boolean,
  /** How long the relay has counted more than the spool holds. Past the grace it is stale. */
  excessAgeMs = 0,
): number {
  let lost = 0;
  for (const id of dropped ?? []) if (!inSpool(id)) lost++;
  const fromRelay = Math.max(0, relayUnread - lost);
  // The mailbox tool reads only the local spool. A relay count that stays above it for longer
  // than a delivery takes is something the agent can never read: do not announce it.
  if (fromRelay > spoolUnread && excessAgeMs > NOTICE_EXCESS_GRACE_MS)
    return spoolUnread;
  return Math.max(fromRelay, spoolUnread);
}

/** A delivery the relay counts but the daemon has not spooled is "in flight" for this long. */
export const NOTICE_EXCESS_GRACE_MS = 20_000;

/** Tracks, per worker, since when the relay count has exceeded what the spool holds. */
export class ExcessClock {
  private m = new Map<string, { excess: number; since: number }>();
  /** Returns the age of the current excess in ms (0 when there is none or it just changed). */
  age(key: string, excess: number, now: number): number {
    if (excess <= 0) {
      this.m.delete(key);
      return 0;
    }
    const e = this.m.get(key);
    if (!e || e.excess !== excess) {
      this.m.set(key, { excess, since: now });
      return 0;
    }
    return now - e.since;
  }
}

/**
 * Transport owner (02 §7.4): one WS per worker, the spool, key access, the manifest and the
 * local socket. Workers are attached over the socket (`attach`) or passed in `workers`.
 */
export async function startDaemon(opts: DaemonOptions = {}) {
  const stateDir = opts.stateDir ?? defaultStateDir();
  ensureDir(stateDir);
  const other = await runningDaemon(stateDir);
  if (other !== null) throw new DaemonRunningError(other || undefined);
  const doFetch = opts.fetch ?? fetch;
  const keyStore =
    opts.keyStore ??
    (await openKeyStore({ stateDir, passphrase: process.env.HAWL_PASSPHRASE }));
  const manifests =
    opts.manifests ?? new ManifestStore(stateDir, pinnedRoots());
  const conns = new Map<
    string,
    { spec: WorkerSpec; conn: WorkerConnection; spool: Spool }
  >();
  /** First upload id per worker and file content (see upload.ts). */
  const uploads = new Map<string, string>();
  const drops: { reason: DropReason; message_id?: string; at: string }[] = [];
  /** Per worker: message ids this daemon dropped. The relay still counts them unread. */
  const droppedIds = new Map<string, Set<string>>();
  /** Remembered workers that could not reattach at start (shown by `hawl status`). */
  const failed: string[] = [];
  const excessClock = new ExcessClock();

  const sessions = new SessionLog(stateDir);
  /** Agent sessions open right now (heartbeats from `hawl mcp`), repeated to the relay on reconnect. */
  const liveSessions = new LiveSessions();
  /** Last hook activity per worker, so idle wake leaves a busy agent to its hooks. */
  const lastActivity = new Map<string, number>();
  const aimedFor = (rid: string): number => {
    const w = conns.get(rid);
    return w ? countAimed(w.spool.unread(), w.spec.resident_id) : 0;
  };
  const quietFor = (rid: string): number | null => {
    const t = lastActivity.get(rid);
    return t === undefined ? null : Date.now() - t;
  };
  const codexWake = new CodexIdleWake({
    counts: (rid) => ({ aimed: aimedFor(rid), quietMs: quietFor(rid) }),
    sessions: () => sessions.all(),
    queue: opts.codexQueue,
  });
  // Lines from a hook that knows its worker go out on that worker's own connection, so they
  // reach that worker's site; one 250 ms batcher per worker.
  const routed = new Map<string, ActivityForwarder>();
  const forwarderFor = (rid: string | undefined): ActivityForwarder => {
    if (!rid || !conns.has(rid)) return forwarder;
    let f = routed.get(rid);
    if (!f) {
      f = new ActivityForwarder({
        sink: (events) =>
          conns.get(rid)?.conn.sendFrame({ t: "activity", events }) ?? false,
      });
      routed.set(rid, f);
    }
    return f;
  };
  // Live activity (spec 16 §3.9): one collector, batched to the relay at most every 250 ms.
  // Lines with no known worker (OTLP, process poller) use the first connected one.
  const forwarder = new ActivityForwarder({
    sink:
      opts.activitySink ??
      ((events) => {
        for (const w of conns.values()) {
          if (w.conn.sendFrame({ t: "activity", events })) return true;
        }
        return false;
      }),
  });
  const poller = new ProcessPoller({
    emit: (l) => forwarder.push(l),
    list: opts.listProcesses,
  });
  // Another daemon on this machine may already hold the port: live activity from this one
  // is then off, but messaging still works.
  const otlp = await startOtlpReceiver(
    (lines) => lines.forEach((l) => forwarder.push(l)),
    opts.otlpPort ?? 4318,
  ).catch(() => null);

  const refresh = async (relayUrl: string) => {
    await refreshManifest(manifests, relayUrl, doFetch);
  };

  async function attach(spec: WorkerSpec): Promise<void> {
    if (conns.has(spec.resident_id)) return;
    const signer = await loadSigner(keyStore, spec.resident_id);
    if (!signer) throw new Error(`no key for ${spec.resident_id}`);
    if (!manifests.usable) await refresh(spec.relay_url);
    const tokens = tokenSource(
      spec.relay_url,
      spec.resident_id,
      signer,
      doFetch,
    );
    const spool = new Spool(join(stateDir, "spool"), spec.resident_id);
    const conn = new WorkerConnection({
      wsUrl: wsUrlFor(spec.relay_url),
      residentId: spec.resident_id,
      platform: spec.platform,
      signer,
      manifests,
      spool,
      version: opts.version,
      senderKey: opts.senderKey
        ? (kid, at) => opts.senderKey!(spec.relay_url, kid, at)
        : senderKeyFetcher({
            relayUrl: spec.relay_url,
            fetch: doFetch,
            // GET /v1/keys/{kid} takes an AgentToken.
            headers: async () => ({
              authorization: `Bearer ${await tokens()}`,
            }),
          }),
      onDrop: (reason, message_id) => {
        drops.push({ reason, message_id, at: new Date().toISOString() });
        if (message_id) {
          const set = droppedIds.get(spec.resident_id) ?? new Set<string>();
          set.add(message_id);
          if (set.size > 200) set.delete(set.values().next().value as string);
          droppedIds.set(spec.resident_id, set);
        }
        if (drops.length > 100) drops.shift();
      },
      onManifestStale: () => void refresh(spec.relay_url),
      // A fresh socket knows nothing about which agents are open: say so right after the handshake.
      onState: (s) => {
        if (s !== "connected") return;
        for (const f of announceFrames(liveSessions.live(spec.resident_id)))
          conn.sendFrame(f);
      },
      // The relay sends a notice after each push: new mail may be aimed at an idle Codex session.
      // Deliveries verify and spool one at a time, so look a moment later.
      onNotice: () =>
        void setTimeout(() => void codexWake.check(spec.resident_id), 1000),
    });
    conns.set(spec.resident_id, { spec, conn, spool });
    rememberWorker(stateDir, spec);
    conn.start();
  }

  /** `forget`: the worker left (`hawl leave`), so the next start must not reconnect it. */
  function detach(
    residentId: string,
    destroySpool = false,
    forget = false,
  ): void {
    if (forget) forgetWorker(stateDir, residentId);
    liveSessions.forget(residentId);
    routed.get(residentId)?.stop();
    routed.delete(residentId);
    const w = conns.get(residentId);
    if (!w) return;
    w.conn.stop();
    if (destroySpool) w.spool.destroy();
    conns.delete(residentId);
  }

  const handle = async (req: Request): Promise<unknown> => {
    const rid =
      typeof req.resident_id === "string" ? req.resident_id : undefined;
    switch (req.op) {
      case "attach":
        await attach(req.worker as WorkerSpec);
        return { attached: true };
      case "host_session": {
        // `hawl mcp` linked to this daemon: tell the relay the host loaded Hawl (EXP-16).
        const w = rid ? conns.get(rid) : undefined;
        if (!w) throw new Error("unknown worker");
        const id =
          typeof req.host_session_id === "string" ? req.host_session_id : "";
        if (!id) throw new Error("bad host_session_id");
        if (typeof req.host === "string")
          sessions.seen({
            host: req.host.slice(0, 32),
            session_id: id,
            resident_id: w.spec.resident_id,
            root: typeof req.root === "string" ? req.root : undefined,
            via: "mcp",
          });
        liveSessions.beat(w.spec.resident_id, id);
        w.conn.sendFrame({
          t: "agent_session",
          host_session_id: id,
          state: "live",
        });
        return {
          sent: w.conn.sendFrame({ t: "host_session", host_session_id: id }),
        };
      }
      case "agent_session": {
        // The MCP server's heartbeat (live) or goodbye (bye): is the agent itself still open?
        const w = rid ? conns.get(rid) : undefined;
        if (!w) throw new Error("unknown worker");
        const id =
          typeof req.host_session_id === "string" ? req.host_session_id : "";
        if (!id) throw new Error("bad host_session_id");
        const state = req.state === "bye" ? "bye" : "live";
        if (state === "live") liveSessions.beat(w.spec.resident_id, id);
        else liveSessions.bye(w.spec.resident_id, id);
        return {
          sent: w.conn.sendFrame({
            t: "agent_session",
            host_session_id: id,
            state,
          }),
        };
      }
      case "detach":
        // Destroying the spool means the worker left; a plain detach keeps it for next start.
        if (rid)
          detach(rid, req.destroy_spool === true, req.destroy_spool === true);
        return { detached: true };
      case "shutdown":
        // The tray's Stop. Exit 0 so Task Scheduler and launchd treat it as a clean stop.
        setTimeout(() => {
          void self.stop().finally(opts.onShutdown ?? (() => process.exit(0)));
        }, 20);
        return { stopping: true };
      case "status":
        return {
          pid: process.pid,
          version: opts.version ?? "0.0.0",
          key_store: keyStore.kind,
          manifest_seq: manifests.seq,
          manifest_usable: manifests.usable,
          drops: drops.length,
          attach_failed: failed,
          workers: [...conns.values()].map((w) => ({
            resident_id: w.spec.resident_id,
            platform: w.spec.platform,
            state: w.conn.state,
            queued: w.spool.list().length,
            unread: w.spool.unread().length,
            ...(w.conn.refusal && { refused: w.conn.refusal }),
          })),
        };
      case "notice": {
        // Counts only. Prefer the relay's own notice; fall back to the verified spool.
        const ws = rid ? [conns.get(rid)] : [...conns.values()];
        let unread = 0;
        let needs_action = 0;
        let aimed = 0;
        for (const w of ws) {
          if (!w) continue;
          const mine = w.spool.unread();
          const dropped = droppedIds.get(w.spec.resident_id);
          const lost = [...(dropped ?? [])].filter(
            (id) => !w.spool.has(id),
          ).length;
          const age = excessClock.age(
            w.spec.resident_id,
            w.conn.notice.unread - lost - mine.length,
            Date.now(),
          );
          unread += unreadCount(
            w.conn.notice.unread,
            mine.length,
            dropped,
            (id) => w.spool.has(id),
            age,
          );
          needs_action += w.conn.notice.needs_action;
          aimed += countAimed(mine, w.spec.resident_id);
        }
        // quiet_ms: since this worker's last hook activity (idle wake skips busy agents).
        return {
          unread,
          needs_action,
          aimed,
          ...(rid && { quiet_ms: quietFor(rid) }),
        };
      }
      case "mailbox": {
        const w = rid ? conns.get(rid) : undefined;
        if (!w) throw new Error("unknown worker");
        return {
          envelopes: req.unread_only ? w.spool.unread() : w.spool.list(),
        };
      }
      case "mark_read": {
        const w = rid ? conns.get(rid) : undefined;
        if (!w) throw new Error("unknown worker");
        w.spool.markRead(req.message_ids as string[]);
        return { ok: true };
      }
      case "drops":
        return drops;
      case "sessions":
        return { sessions: sessions.all() };
      case "activity": {
        // One line from a host hook. Whitelisted and clamped; the daemon stamps the time.
        const line = sanitizeLine(req.line, "hook");
        if (!line) throw new Error("bad activity line");
        forwarderFor(rid).push(line);
        if (rid) lastActivity.set(rid, Date.now());
        const host = (req.line as { host?: unknown }).host;
        if (typeof host === "string")
          sessions.seen({
            host: host.slice(0, 32),
            session_id: line.session_id,
            resident_id: rid,
            root: typeof req.root === "string" ? req.root : undefined,
            via: "hook",
          });
        const pid = (req.line as { agent_pid?: unknown }).agent_pid;
        if (line.kind === "session_start" && Number.isInteger(pid)) {
          poller.track(pid as number, line.session_id);
        } else if (line.kind === "session_stop" && line.session_id) {
          poller.untrackSession(line.session_id);
        }
        return { queued: true };
      }
      case "tool": {
        // Non-send MCP tools: one tool.call frame over the worker's WS (spec 16 §2.4.2).
        const w = rid ? conns.get(rid) : undefined;
        if (!w) throw new Error("unknown worker");
        let args = (req.args as Record<string, unknown> | undefined) ?? {};
        if (req.name === "file_put" && typeof args.path === "string") {
          const signer = await loadSigner(keyStore, w.spec.resident_id);
          if (!signer) throw new Error(`no key for ${w.spec.resident_id}`);
          const upload_id = await uploadFile({
            relayUrl: w.spec.relay_url,
            residentId: w.spec.resident_id,
            signer,
            path: args.path,
            seen: uploads,
            doFetch,
          });
          args = { upload_id };
          // The scan takes seconds. Wait for the verdict so the agent learns a blocked file now.
          return settleFilePut(() =>
            w.conn.rpc({ t: "tool.call", name: req.name, args }),
          );
        }
        return w.conn.rpc({ t: "tool.call", name: req.name, args });
      }
      case "file_meta": {
        // The file part a send tool signs: name, mime, size and sha256 from the relay.
        const w = rid ? conns.get(rid) : undefined;
        if (!w) throw new Error("unknown worker");
        const signer = await loadSigner(keyStore, w.spec.resident_id);
        if (!signer) throw new Error(`no key for ${w.spec.resident_id}`);
        return fileMeta({
          relayUrl: w.spec.relay_url,
          residentId: w.spec.resident_id,
          signer,
          fileId: String(req.file_id),
          doFetch,
        });
      }
      case "file_download": {
        const w = rid ? conns.get(rid) : undefined;
        if (!w) throw new Error("unknown worker");
        const signer = await loadSigner(keyStore, w.spec.resident_id);
        if (!signer) throw new Error(`no key for ${w.spec.resident_id}`);
        return downloadFile({
          relayUrl: w.spec.relay_url,
          residentId: w.spec.resident_id,
          signer,
          fileId: String(req.file_id),
          dir: String(req.dir),
          ...(typeof req.save_to === "string" ? { saveTo: req.save_to } : {}),
          doFetch,
        });
      }
      case "send_tool": {
        // A send tool with side effects beyond the message (handoff): REST with the signed request.
        const w = rid ? conns.get(rid) : undefined;
        if (!w) throw new Error("unknown worker");
        const signer = await loadSigner(keyStore, w.spec.resident_id);
        if (!signer) throw new Error(`no key for ${w.spec.resident_id}`);
        const token = await agentToken(
          w.spec.relay_url,
          w.spec.resident_id,
          signer,
          doFetch,
        );
        const res = await doFetch(new URL("/v1/tools/call", w.spec.relay_url), {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: req.name,
            args: req.args,
            client_request:
              typeof req.client_request === "string"
                ? JSON.parse(
                    Buffer.from(req.client_request, "base64url").toString(
                      "utf8",
                    ),
                  )
                : req.client_request,
            sender_sig: req.sender_sig,
          }),
        });
        const out = (await res.json().catch(() => null)) as {
          error?: { message?: string; code?: string };
        } | null;
        if (!res.ok)
          throw new Error(
            out?.error?.message ?? out?.error?.code ?? `relay ${res.status}`,
          );
        return out;
      }
      case "send": {
        const w = rid ? conns.get(rid) : undefined;
        if (!w) throw new Error("unknown worker");
        return w.conn.rpc({
          t: "msg.send",
          // The CLI signs the exact JCS bytes and carries them as base64url; the frame carries the
          // object, which the relay re-canonicalizes to the same bytes to check sender_sig.
          client_request:
            typeof req.client_request === "string"
              ? JSON.parse(
                  Buffer.from(req.client_request, "base64url").toString("utf8"),
                )
              : req.client_request,
          sender_sig: req.sender_sig,
        });
      }
      case "resolve": {
        // Directory lookups for send tools: handle -> worker, message -> thread (spec 16 2.4).
        const w = rid ? conns.get(rid) : undefined;
        if (!w) throw new Error("unknown worker");
        const tool = req.tool as string;
        const a = (req.args as Record<string, unknown> | undefined) ?? {};
        if (tool === "thread_reply") {
          const id = String(a.message_id);
          const env = w.spool.list().find((e) => e.relay.message_id === id);
          if (!env) throw new Error("unknown message_id");
          return {
            to: { kind: "worker", resident_id: env.relay.from.resident_id },
            conversation_id: env.relay.conversation_id,
            reply_to: id,
          };
        }
        if (tool === "ask_town") {
          // The request goes to the site's Dispatcher as a signed message; the relay routes it.
          const r = (await w.conn.rpc({
            t: "tool.call",
            name: "who",
            args: { query: "dispatcher" },
          })) as { workers?: { handle?: string; resident_id?: string }[] };
          const hit = r.workers?.find((x) => bare(x.handle) === "dispatcher");
          if (!hit?.resident_id)
            throw new Error("this site has no Dispatcher yet");
          return {
            to: { kind: "worker", resident_id: hit.resident_id },
            conversation_id: null,
            reply_to: null,
          };
        }
        if (tool === "dm_send" || tool === "handoff") {
          if (a.to === undefined)
            throw new Error(
              "name the worker in `to`: routing by ask_town is not available yet",
            );
          const handle = String(a.to).replace(/^@/, "");
          const r = (await w.conn.rpc({
            t: "tool.call",
            name: "who",
            args: { query: handle },
          })) as { workers?: { handle?: string; resident_id?: string }[] };
          const hit = r.workers?.find((x) => bare(x.handle) === handle);
          if (!hit) throw new Error(`no worker @${handle}`);
          if (!hit.resident_id)
            throw new Error("relay directory did not return resident_id");
          return {
            to: { kind: "worker", resident_id: hit.resident_id },
            conversation_id: null,
            reply_to: (a.reply_to as string | undefined) ?? null,
          };
        }
        if (tool === "square_post" || tool === "room_post") {
          // The relay owns channel ids (GET /v1/channels) and resident ids (`who`); the signed
          // request names both (spec 16 2.4.1: to.channel_id, mentions as res_ ids).
          const signer = await loadSigner(keyStore, w.spec.resident_id);
          if (!signer) throw new Error(`no key for ${w.spec.resident_id}`);
          const token = await agentToken(
            w.spec.relay_url,
            w.spec.resident_id,
            signer,
            doFetch,
          );
          const res = await doFetch(new URL("/v1/channels", w.spec.relay_url), {
            headers: { authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error(`relay ${res.status} listing channels`);
          const items =
            ((await res.json()) as { items?: ChannelItem[] }).items ?? [];
          const room = String(a.room ?? "").replace(/^#/, "");
          const chan =
            tool === "square_post"
              ? items.find((c) => c.kind === "square")
              : items.find((c) => c.kind === "room" && c.name === room);
          if (!chan)
            throw new Error(
              tool === "square_post" ? "no site channel" : `no room #${room}`,
            );
          const mentions: string[] = [];
          for (const m of (a.mentions as string[] | undefined) ?? []) {
            const handle = String(m).replace(/^@/, "");
            const r = (await w.conn.rpc({
              t: "tool.call",
              name: "who",
              args: { query: handle },
            })) as { workers?: { handle?: string; resident_id?: string }[] };
            const hit = r.workers?.find((x) => bare(x.handle) === handle);
            if (!hit?.resident_id) throw new Error(`no worker @${handle}`);
            mentions.push(hit.resident_id);
          }
          return {
            to: { kind: "channel", channel_id: chan.channel_id, mentions },
            conversation_id: null,
            reply_to: null,
          };
        }
        throw new Error(`cannot resolve a target for ${tool}`);
      }
      default:
        throw new Error(`unknown op ${req.op}`);
    }
  };

  // The socket answers before the remembered workers are back (the keychain read can take a
  // while). A tool call in that window would fail with "unknown worker", so every op but
  // `status` and `shutdown` waits for the startup attach, for at most STARTUP_WAIT_MS.
  let startupDone: () => void = () => {};
  const startup = new Promise<void>((r) => {
    startupDone = r;
  });
  const gated = async (req: Request): Promise<unknown> => {
    if (req.op !== "status" && req.op !== "shutdown") {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        startup,
        new Promise<void>((r) => {
          timer = setTimeout(r, STARTUP_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    return handle(req);
  };
  const sock = await startSocketServer(stateDir, gated);
  try {
    for (const w of opts.workers ?? []) await attach(w);
    // Every worker joined on this machine reconnects at start (login, crash restart, update),
    // before any agent opens. One bad entry (key gone) must not stop the others.
    for (const w of readWorkers(stateDir)) {
      try {
        await attach(w);
      } catch (e) {
        failed.push(`${w.resident_id}: ${(e as Error).message}`);
      }
    }
  } finally {
    startupDone();
  }

  // Revokes queued by an offline `hawl leave` go out once the relay is reachable, with or
  // without any folder membership left. Dynamic import: leave.ts imports this module.
  const flushQueued = () =>
    import("../commands/leave.ts")
      .then((m) => m.flushRevokes({ stateDir, keyStore, fetch: doFetch }))
      .catch(() => 0);
  void flushQueued();
  const revokeTimer = setInterval(() => void flushQueued(), 5 * 60_000);
  revokeTimer.unref();
  // A wake held back (agent busy, too soon) goes out on a later sweep once the agent is idle.
  const sweepMs = opts.idleWakeSweepMs ?? 15_000;
  const wakeTimer =
    sweepMs > 0
      ? setInterval(() => {
          for (const rid of conns.keys()) void codexWake.check(rid);
        }, sweepMs)
      : undefined;
  wakeTimer?.unref();

  const self = {
    stateDir,
    socketPath: sock.path,
    token: sock.token,
    manifests,
    otlpPort: otlp?.port ?? 0,
    forwarder,
    codexWake,
    attach,
    detach,
    async stop() {
      clearInterval(revokeTimer);
      if (wakeTimer) clearInterval(wakeTimer);
      for (const id of [...conns.keys()]) detach(id);
      forwarder.stop();
      for (const f of routed.values()) f.stop();
      poller.stop();
      await otlp?.close();
      await sock.close();
    },
  };
  return self;
}

if (import.meta.main) {
  startDaemon({ version: "0.0.0" }).catch((e: Error) => {
    process.stderr.write(`hawl daemon: ${e.message}\n`);
    process.exit(e instanceof DaemonRunningError ? 0 : 1);
  });
}
