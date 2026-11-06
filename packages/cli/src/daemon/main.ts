import type { KeyObject } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../api/http.ts";
import {
  claimOverlap,
  RECENT_EDIT_S,
  recentEditors,
  watchers,
} from "../hook/peers.ts";
import { toolDefs } from "../mcp/tool-defs.ts";
import { runTool } from "../mcp/tool-run.ts";
import { requestTrace, tracedLink } from "../mcp/trace.ts";
import { checkAndStage } from "../update/apply.ts";
import { type Next, swapWhenIdle } from "../update/live-swap.ts";
import { startUpdater, type UpdaterDeps } from "../update/schedule.ts";
import {
  ActivityForwarder,
  type ActivityLine,
  listProcesses,
  ProcessPoller,
  ReasonLinker,
  sanitizeLine,
  startOtlpReceiver,
} from "./activity.ts";
import { countAimed, isAimed } from "./aimed.ts";
import { ensureDir } from "./fsutil.ts";
import { recordAck } from "./handover.ts";
import { CodexIdleWake } from "./idle-wake.ts";
import {
  type KeyStore,
  keyIsFresh,
  loadLocalSigner,
  loadSigner,
  openKeyStore,
  pruneKeys,
} from "./keys.ts";
import { announceFrames, LiveSessions } from "./live.ts";
import {
  applyDebug,
  createDaemonLogger,
  type DaemonLogger,
  pruneLogs,
  traceFrameField,
  traceHeader,
  traceIdOf,
} from "./log.ts";
import { ManifestStore, pinnedRoots, refreshManifest } from "./manifest.ts";
import { pinOnFirstUse } from "./passkey.ts";
import { answerPcFile } from "./pc-file.ts";
import { ProcessActors } from "./process-actor.ts";
import { senderKeyFetcher } from "./senderkeys.ts";
import {
  closeSessionAgent,
  forgetSessionAgent,
  forgetSessionAgentsOf,
  openSessionAgent,
  readSessionAgents,
  rememberSessionAgent,
  type SessionAgent,
  SessionsUnsupported,
  sessionKeyFor,
} from "./session-agents.ts";
import { SessionLinks } from "./session-link.ts";
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
import { WaitLines } from "./wait-line.ts";
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
  /** Delete `res_*` keys no worker, session agent or queued revoke refers to (the real daemon sets it). */
  pruneStaleKeys?: boolean;
  /** Wait before pruning, so a `hawl join` still writing its key is not caught. Default 30 s. */
  pruneDelayMs?: number;
  manifests?: ManifestStore;
  senderKey?: (
    relayUrl: string,
    kid: string,
    at: string,
  ) => Promise<KeyObject | null>;
  fetch?: typeof fetch;
  workers?: WorkerSpec[];
  version?: string;
  /** Local log (default: <stateDir>/logs/daemon.log). */
  log?: DaemonLogger;
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
  /** Tests: the clock for heartbeats and how often closed terminals are let go (default 15 s). */
  now?: () => number;
  closedSweepMs?: number;
  /** Tests: whether a process is still running (default: signal 0). */
  pidAlive?: (pid: number) => boolean;
  /** Tests: how often the verbose-logging switch is read (default 5 s). */
  debugSweepMs?: number;
  /** Daily signed-release check (spec H11). Only the long-lived helper passes it; absent = no updater. */
  update?: Omit<UpdaterDeps, "stateDir">;
  /** The relay announced a newer release. Default: run the same stage check as the daily timer. */
  onUpdateAvailable?: (u: { version: string; severity: string }) => void;
  /**
   * Replace this helper with a staged newer one while agent sessions stay open: when idle, release
   * the socket, start `next().launch()`, exit. `stage` runs at most daily (npx: stage hawl.ai@X).
   */
  liveSwap?: {
    next: () => Next | null;
    stage?: () => Promise<unknown>;
    drainMs?: number;
    firstMs?: number;
    intervalMs?: number;
  };
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
  const log = opts.log ?? createDaemonLogger(stateDir);
  // `hawl debug on` writes a file; read it now and every few seconds so no restart is needed.
  const clock = () => opts.now?.() ?? Date.now();
  applyDebug(log, stateDir, clock());
  pruneLogs(stateDir, clock());
  let lastPrune = clock();
  const debugTimer = setInterval(() => {
    applyDebug(log, stateDir, clock());
    if (clock() - lastPrune > 3_600_000) {
      lastPrune = clock();
      pruneLogs(stateDir, lastPrune);
    }
  }, opts.debugSweepMs ?? 5_000);
  debugTimer.unref();
  const other = await runningDaemon(stateDir);
  if (other !== null) throw new DaemonRunningError(other || undefined);
  const doFetch = opts.fetch ?? fetch;
  /** file_from_pc upload links already used by this daemon. */
  const pcSent = new Set<string>();
  const keyStore =
    opts.keyStore ??
    (await openKeyStore({ stateDir, passphrase: process.env.HAWL_PASSPHRASE }));
  /** Delete keys nothing uses any more; never one a live connection signs with. */
  const dropKeys = (ids: string[]) => {
    for (const id of ids) if (!conns.has(id)) void keyStore.delete(id);
  };
  const rememberSession = (s: SessionAgent) =>
    dropKeys(rememberSessionAgent(stateDir, s));
  const manifests =
    opts.manifests ?? new ManifestStore(stateDir, pinnedRoots());
  const conns = new Map<
    string,
    {
      spec: WorkerSpec;
      conn: WorkerConnection;
      spool: Spool;
      tokens: () => Promise<string>;
    }
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
  const liveSessions = new LiveSessions(opts.now);
  /** Claude Code `--continue`: the MCP server's id paired with the id its hooks report. */
  const links = new SessionLinks();
  /** A process's parent, asked of the OS once per pid (only when a hook named a Claude pid). */
  const parents = new Map<number, number | undefined>();
  const parentOf = async (pid: number): Promise<number | undefined> => {
    if (!parents.has(pid)) {
      const all = await (opts.listProcesses ?? listProcesses)().catch(() => []);
      parents.set(pid, all.find((p) => p.pid === pid)?.ppid);
    }
    return parents.get(pid);
  };
  /** Last hook activity per worker, so idle wake leaves a busy agent to its hooks. */
  const lastActivity = new Map<string, number>();
  /** Per worker: the last `who` answer for the hook's "others now" block, refreshed at most every 20 s. */
  const peers = new Map<
    string,
    { at: number; who: unknown; fetching?: Promise<void> }
  >();
  /** Cached `who` (refreshed at most every 20 s): a cold or stale cache waits 150 ms, nothing is older than 60 s. */
  const peersWho = async (
    rid: string,
    w: { conn: { rpc(f: unknown): Promise<unknown> } },
    wait = true,
  ): Promise<unknown> => {
    const e = peers.get(rid) ?? { at: 0, who: null };
    peers.set(rid, e);
    if (Date.now() - e.at > 20_000 && !e.fetching) {
      e.fetching = Promise.resolve(
        w.conn.rpc({ t: "tool.call", name: "who", args: {} }),
      )
        .then((r) => {
          e.who = r;
          e.at = Date.now();
        })
        .catch(() => {})
        .finally(() => {
          e.fetching = undefined;
        });
    }
    if (e.fetching && wait)
      await Promise.race([
        e.fetching,
        new Promise((r) => setTimeout(r, 150).unref()),
      ]);
    return Date.now() - e.at < 60_000 ? e.who : null;
  };
  /** The worker key for signing messages here; one keystore read per worker. */
  const signers = new Map<
    string,
    Awaited<ReturnType<typeof loadLocalSigner>>
  >();
  const signerFor = async (rid: string) => {
    let s = signers.get(rid);
    if (!s) {
      s = await loadLocalSigner(keyStore, rid);
      if (s) signers.set(rid, s);
    }
    return s ?? undefined;
  };
  /** `rid|handle|path` -> when the overlap was last reported. */
  const overlapSeen = new Map<string, number>();
  /** An ordinary signed DM to the other agent, so it lands in its mailbox and wakes it. */
  const tellOverlap = async (
    rid: string,
    to: string,
    me: string | undefined,
    path: string,
  ): Promise<void> => {
    const signer = await signerFor(rid);
    if (!signer) return;
    const { send } = await import("../mcp/tool-run.ts");
    const who = me && /^@[a-z0-9_-]{1,32}$/.test(me) ? me : "another agent";
    await send(
      {
        daemon: { call: (op, a) => handle({ op, ...a }) },
        residentId: rid,
        signer,
      },
      "dm_send",
      {
        to,
        intent: "ask",
        text: `Hawl overlap: ${who} is about to edit ${path}, which matches what you said you are watching. Please talk to it (ask_agent or dm_send) to agree who does what, or hand the work off.`,
      },
    );
  };
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
  // Process lines go out on the connection of the worker whose session started them, with the
  // agent's reason attached (ReasonLinker). conhost is console plumbing, not something the agent ran.
  const linker = new ReasonLinker();
  // Each terminal and subagent is its own agent: its processes show on its own row.
  const procActors = new ProcessActors();
  const poller = new ProcessPoller({
    annotate: (starts) => linker.annotateBatch(starts, Date.now()),
    confirm: (alive) => linker.confirm(alive, Date.now()),
    emit: (l) => {
      if (l.name?.toLowerCase() === "conhost.exe") return;
      if (l.kind === "process_exit") linker.exit(l.pid);
      for (const r of procActors.route(l)) forwarderFor(r.to).push(r.line);
    },
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

  /** One log line per tool call: name, duration, ok or error code. Never args or bodies. */
  async function logTool<T>(
    req: { name?: unknown; trace?: unknown; [k: string]: unknown },
    worker: string | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const t0 = Date.now();
    const line = {
      worker,
      tool: String(req.name),
      trace_id: traceIdOf(req.trace),
    };
    log.debug(line, "tool call start");
    try {
      const out = await run();
      log.info({ ...line, ms: Date.now() - t0, ok: true }, "tool call");
      return out;
    } catch (e) {
      const err = e as { code?: unknown; name?: string };
      log.warn(
        { ...line, ms: Date.now() - t0, ok: false, code: err.code ?? err.name },
        "tool call",
      );
      throw e;
    }
  }

  /** Session agents attached now (one per open terminal): child resident id -> folder worker. */
  const childOf = new Map<string, string>();
  /**
   * Claude Code subagents (SubagentStart): `<terminal agent>|<agent_id>` -> its own agent, null
   * when it could not open (its tool calls then act as the terminal). Gone at SubagentStop.
   */
  const subs = new Map<string, Promise<string | null>>();
  /** Open subagent -> the terminal's agent that started it. */
  const spawnedOf = new Map<string, string>();
  /** The same key as `subs`, once its agent is open. */
  const subRid = new Map<string, string>();
  // Both maps are rebuilt from `session-agents.json` (spawned_by, agent_key) after a restart: subOf.

  /** Attaches on their way: a second caller waits for the first, so one agent gets one socket. */
  const attaching = new Map<string, Promise<void>>();

  function attach(spec: WorkerSpec, remember = true): Promise<void> {
    const rid = spec.resident_id;
    if (conns.has(rid)) return Promise.resolve();
    const have = attaching.get(rid);
    if (have) return have;
    // Cleared on failure too, so a later call can try again.
    const p = attachNow(spec, remember).finally(() => attaching.delete(rid));
    attaching.set(rid, p);
    return p;
  }

  async function attachNow(spec: WorkerSpec, remember: boolean): Promise<void> {
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
    /** The owner's passkeys as the relay lists them (pairing, passkey.ts). */
    const listKeys = async () => {
      const r = await doFetch(new URL("/v1/agent/passkeys", spec.relay_url), {
        headers: { authorization: `Bearer ${await tokens()}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`passkeys ${r.status}`);
      return (await r.json()) as never;
    };
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
      // Verbose only: frame type and ids, never the body.
      onWire: (dir, f) =>
        log.debug(
          {
            worker: spec.resident_id,
            dir,
            t: f.t,
            id: f.id,
            ref: f.ref,
            trace_id: traceIdOf(f.trace),
          },
          "frame",
        ),
      onReconnect: (waitMs, code) =>
        log.debug({ worker: spec.resident_id, waitMs, code }, "reconnect"),
      onClose: (code, reason) =>
        log.warn({ worker: spec.resident_id, code, reason }, "ws closed"),
      onSocketError: (message) =>
        log.error({ worker: spec.resident_id, err: message }, "ws error"),
      onRefused: (why) =>
        log.warn({ worker: spec.resident_id, why }, "ws refused"),
      onDrop: (reason, message_id) => {
        log.warn({ worker: spec.resident_id, reason, message_id }, "drop");
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
      onPcFile: (f) =>
        answerPcFile(f, {
          relayUrl: spec.relay_url,
          sent: pcSent,
          doFetch,
          stateDir,
          residentId: spec.resident_id,
          pinKeys: listKeys,
        }),
      // A fresh socket knows nothing about which agents are open: say so right after the handshake.
      onState: (s) => {
        log.info({ worker: spec.resident_id, state: s }, "ws state");
        if (s !== "connected") return;
        // Pairing: pin the owner's passkeys the first time this helper connects (passkey.ts).
        void pinOnFirstUse(stateDir, spec.resident_id, listKeys).catch((err) =>
          log.warn(
            { worker: spec.resident_id, err: String(err) },
            "passkey pin",
          ),
        );
        for (const f of announceFrames(liveSessions.live(spec.resident_id)))
          conn.sendFrame(f);
      },
      // The relay sends a notice after each push: new mail may be aimed at an idle Codex session.
      // Deliveries verify and spool one at a time, so look a moment later.
      onNotice: () =>
        void setTimeout(() => void codexWake.check(spec.resident_id), 1000),
      onUpdateAvailable: (u) => {
        log.info(
          { version: u.version, severity: u.severity },
          "update available",
        );
        if (opts.onUpdateAvailable) return opts.onUpdateAvailable(u);
        if (opts.liveSwap) {
          lastStage = Date.now();
          void swapTick(true).catch(() => {});
        } else if (opts.update)
          void checkAndStage({
            ...opts.update,
            stateDir,
            channel: "latest",
          }).catch((e: Error) =>
            log.warn({ err: e.message }, "update check failed"),
          );
      },
    });
    // Two live sockets for one agent kick each other off (4409): never leave the old one running.
    conns.get(spec.resident_id)?.conn.stop();
    conns.set(spec.resident_id, { spec, conn, spool, tokens });
    // Session agents are attached while their terminal is open, never at daemon start.
    if (remember) rememberWorker(stateDir, spec);
    conn.start();
  }

  /** `forget`: the worker left (`hawl leave`), so the next start must not reconnect it. */
  function detach(
    residentId: string,
    destroySpool = false,
    forget = false,
  ): void {
    signers.delete(residentId);
    if (forget) {
      forgetWorker(stateDir, residentId);
      dropKeys(forgetSessionAgentsOf(stateDir, residentId));
      for (const [kid, parent] of childOf)
        if (parent === residentId) detach(kid, true);
    }
    childOf.delete(residentId);
    liveSessions.forget(residentId);
    routed.get(residentId)?.stop();
    routed.delete(residentId);
    const w = conns.get(residentId);
    if (!w) return;
    w.conn.stop();
    if (destroySpool) w.spool.destroy();
    conns.delete(residentId);
  }

  /**
   * The worker a call names. A session agent the daemon no longer holds (daemon restarted while
   * its terminal stayed open) is attached again from `session-agents.json`.
   */
  async function get(rid: string) {
    const have = conns.get(rid);
    if (have) return have;
    const s = readSessionAgents(stateDir).find((x) => x.resident_id === rid);
    if (!s || s.retiring || !conns.has(s.parent_id)) return undefined;
    await attach(
      { relay_url: s.relay_url, resident_id: rid, platform: s.platform },
      false,
    );
    childOf.set(rid, s.parent_id);
    if (s.spawned_by) spawnedOf.set(rid, s.spawned_by);
    // A terminal back after a daemon restart: its running subagents are online again too.
    else
      for (const sub of readSessionAgents(stateDir))
        if (sub.spawned_by === rid && !conns.has(sub.resident_id))
          void get(sub.resident_id).catch(() => {});
    return conns.get(rid);
  }

  /**
   * A terminal's subagent by Claude Code's agent_id: the one opening or open now, else the one
   * this machine recorded before a daemon restart. null: no agent of its own here.
   */
  function subOf(terminal: string, agentId: string): Promise<string | null> {
    const key = `${terminal}|${agentId}`;
    const have = subs.get(key);
    if (have) return have;
    const agentKey = sessionKeyFor(terminal, agentId);
    const rec = readSessionAgents(stateDir).find(
      (x) => x.spawned_by === terminal && x.agent_key === agentKey,
    );
    if (!rec || rec.retiring) return Promise.resolve(null);
    const p = get(rec.resident_id).then(
      (w) => {
        if (!w) return null;
        if (subs.get(key) === p) subRid.set(key, rec.resident_id);
        return rec.resident_id;
      },
      () => null,
    );
    subs.set(key, p);
    return p;
  }

  /**
   * A terminal's agent with no heartbeat left: let its socket go, so the site shows it offline.
   * `ended`: the terminal said goodbye, so its subagents end too. Heartbeats that only lapsed
   * (the PC slept) take the subagents offline but keep them; the terminal's return brings them back.
   */
  function dropIfClosed(rid: string, ended: boolean): void {
    // A subagent has no heartbeat of its own: it ends with SubagentStop or with its terminal.
    if (spawnedOf.has(rid)) return;
    if (!childOf.has(rid) || liveSessions.live(rid).length > 0) return;
    detach(rid);
    if (!ended) {
      for (const [sub, term] of [...spawnedOf])
        if (term === rid) {
          spawnedOf.delete(sub);
          detach(sub);
        }
      // Hooks look them up again (and so attach them again) once the terminal is back.
      for (const k of [...subs.keys()])
        if (k.startsWith(`${rid}|`)) {
          subs.delete(k);
          subRid.delete(k);
        }
      return;
    }
    // Its subagents end with it: no SubagentStop comes from a closed terminal. Recorded ones
    // first (also those from before a restart), then any still opening; each retired once.
    const done = new Set<string>();
    const retire = (sub: string | null) => {
      if (!sub || done.has(sub)) return;
      done.add(sub);
      void retireSub(sub);
    };
    for (const s of readSessionAgents(stateDir))
      if (s.spawned_by === rid) retire(s.resident_id);
    for (const [k, p] of [...subs]) {
      if (!k.startsWith(`${rid}|`)) continue;
      subs.delete(k);
      subRid.delete(k);
      void p.then(retire);
    }
  }

  /** The terminal's agent for a hook's folder and session id (the MCP server opened it). */
  async function terminalOf(
    folder: string,
    hsid: string,
    claudePid?: unknown,
  ): Promise<string | undefined> {
    const key = sessionKeyFor(folder, hsid);
    const all = readSessionAgents(stateDir).filter(
      (x) => x.parent_id === folder && !x.spawned_by,
    );
    // This session's own agent, also one seen under it after /clear. A hook from the session
    // proves it is open: one not attached yet (daemon restarted) is attached again.
    const t = all.find(
      (x) => x.session_key === key || x.alias_keys?.includes(key),
    );
    if (t) return (await get(t.resident_id)) ? t.resident_id : undefined;
    // `/clear` gives the hooks a new session id while the MCP server (and its agent) stays: the
    // terminal is the one whose MCP server Claude Code started (CLAUDE_PID in the hook).
    if (!Number.isInteger(claudePid) || (claudePid as number) <= 0) return;
    // Exact parent first, then through a shim. Two terminals on one pid: neither (never guess).
    const live = all.filter((x) => x.mcp_ppid && conns.has(x.resident_id));
    let found = live.filter((x) => x.mcp_ppid === claudePid);
    if (!found.length) {
      found = [];
      for (const x of live)
        if ((await parentOf(x.mcp_ppid as number)) === claudePid) found.push(x);
    }
    const one = found.length === 1 ? found[0] : undefined;
    if (!one) return;
    // Remember the new id, so resuming that session later is this same terminal.
    rememberSession({
      ...one,
      alias_keys: [...(one.alias_keys ?? []), key].slice(-20),
    });
    return one.resident_id;
  }

  /**
   * Whose call a hook made: the subagent's or the terminal's own agent, else the folder's. A
   * subagent still opening counts as its terminal for activity; tool calls wait (subagent_for).
   */
  async function actorFor(
    folder: string,
    hsid: unknown,
    agentId: unknown,
    claudePid?: unknown,
  ): Promise<string> {
    const terminal =
      typeof hsid === "string" && hsid
        ? await terminalOf(folder, hsid, claudePid)
        : undefined;
    if (!terminal) return folder;
    if (typeof agentId !== "string" || !agentId) return terminal;
    const key = `${terminal}|${agentId}`;
    const open = subRid.get(key);
    if (open) return open;
    if (subs.has(key)) return terminal;
    return (await subOf(terminal, agentId)) ?? terminal;
  }

  /** One agent's relay-only counts: open work orders and a waiting handover (its own token). */
  async function inboxFacts(id: string): Promise<
    | {
        open_work?: unknown;
        handover?: unknown;
        role_brief?: unknown;
        goal_rev?: unknown;
      }
    | undefined
  > {
    const w = conns.get(id);
    if (!w) return undefined;
    const res = await doFetch(new URL("/v1/inbox?limit=0", w.spec.relay_url), {
      headers: { authorization: `Bearer ${await w.tokens()}` },
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok ? ((await res.json()) as never) : undefined;
  }

  /**
   * SessionStart's extras for the agent a hook acts as. The handover is its own only (its
   * handover_get reads only its own); open work adds its folder's, which a terminal works too.
   * Any failure: nothing, so the hook skips both lines.
   */
  async function relayExtras(
    folder: string | undefined,
    actor: string,
  ): Promise<{
    open_work?: number;
    handover?: boolean;
    role_brief?: boolean;
    goal_rev?: string;
  }> {
    try {
      const withFolder =
        folder && folder !== actor && !spawnedOf.has(actor) ? [folder] : [];
      const [mine, ...rest] = await Promise.all(
        [actor, ...withFolder].map(inboxFacts),
      );
      if (typeof mine?.handover !== "boolean") return {};
      const work = [mine, ...rest].map((x) =>
        typeof x?.open_work === "number" ? x.open_work : 0,
      );
      return {
        handover: mine.handover,
        ...(typeof mine.role_brief === "boolean" && {
          role_brief: mine.role_brief,
        }),
        ...(typeof mine.goal_rev === "string" && { goal_rev: mine.goal_rev }),
        open_work: work.reduce((a, b) => a + b, 0),
      };
    } catch {
      return {};
    }
  }

  /**
   * The agent a hook call acts as (notice, peers, overlap, activity). Sent with the folder's id
   * and the host's session id, it is that session's own agent: never the folder while a terminal
   * identity exists, so one terminal's activity or peers never stand in for another's.
   */
  async function hookActor(req: Request, rid: string): Promise<string> {
    if (childOf.has(rid)) return rid;
    const line = (req.line ?? {}) as Record<string, unknown>;
    return actorFor(
      rid,
      req.host_session_id ?? line.session_id,
      req.agent_id ?? line.agent_id,
      req.claude_pid ?? line.claude_pid,
    );
  }

  const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const AGENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
  /** What each agent set with status_set, for the waiting line to give back. */
  const waitLines = new WaitLines();
  /** Ops a host hook sends with the folder's id: they act as the session's own agent. */
  const HOOK_OPS = new Set([
    "notice",
    "peers",
    "overlap",
    "activity",
    "goal",
    "wait",
  ]);

  /**
   * SubagentStart from a terminal's hook: the subagent gets its own agent under that terminal
   * (relay: agents/sessions.ts, spawned_by). Opens in the background so the hook returns at once;
   * `subagent_for` waits for it.
   */
  async function subagentOpen(req: Request) {
    const folder = typeof req.resident_id === "string" ? req.resident_id : "";
    const parent = conns.get(folder);
    if (!parent || childOf.has(folder)) throw new Error("unknown agent");
    const hsid =
      typeof req.host_session_id === "string" ? req.host_session_id : "";
    const agentId = typeof req.agent_id === "string" ? req.agent_id : "";
    if (!hsid || hsid.length > 200 || !AGENT_ID.test(agentId))
      throw new Error("bad subagent");
    const terminal = await terminalOf(folder, hsid, req.claude_pid);
    if (!terminal) return { opened: false };
    const key = `${terminal}|${agentId}`;
    if (subs.has(key)) return { opened: true };
    const agentType =
      typeof req.agent_type === "string" && AGENT_TYPE.test(req.agent_type)
        ? req.agent_type
        : "subagent";
    const p = (async () => {
      const signer = await loadSigner(keyStore, folder);
      if (!signer) return null;
      const agent = await openSessionAgent({
        relayUrl: parent.spec.relay_url,
        parentId: folder,
        parentSigner: signer,
        platform: parent.spec.platform,
        keyStore,
        sessionKey: sessionKeyFor(folder, `${hsid}|${agentId}`),
        spawnedBy: terminal,
        agentType,
        doFetch,
      });
      // Recorded with its terminal and id, so a daemon restart keeps it (subOf).
      rememberSession({
        ...agent,
        spawned_by: terminal,
        agent_key: sessionKeyFor(terminal, agentId),
      });
      liveSessions.beat(agent.resident_id, hsid);
      await attach(
        {
          relay_url: agent.relay_url,
          resident_id: agent.resident_id,
          platform: agent.platform,
        },
        false,
      );
      childOf.set(agent.resident_id, folder);
      spawnedOf.set(agent.resident_id, terminal);
      if (subs.has(key)) subRid.set(key, agent.resident_id);
      return agent.resident_id;
    })().catch((e) => {
      log.warn({ worker: folder, err: String(e) }, "subagent open failed");
      return null;
    });
    subs.set(key, p);
    return { opened: true };
  }

  /** SubagentStop: retire it on the relay and let it go here (also one from before a restart). */
  async function subagentClose(
    terminal: string,
    agentId: string,
  ): Promise<boolean> {
    const key = `${terminal}|${agentId}`;
    const p = subs.get(key);
    subs.delete(key);
    subRid.delete(key);
    // Else its record (from before a restart, or one whose retirement has not reached the relay
    // yet): retired from the record, never attached again first.
    const agentKey = sessionKeyFor(terminal, agentId);
    const sub =
      (await p) ??
      readSessionAgents(stateDir).find(
        (x) => x.spawned_by === terminal && x.agent_key === agentKey,
      )?.resident_id;
    return sub ? retireSub(sub) : false;
  }

  /**
   * One subagent ended (SubagentStop, or its terminal closed): nothing here acts as it from now
   * on. Its record stays (marked retiring) until the relay confirms it retired, so a failed try
   * is retried (next Stop, or the sweep) and the relay never keeps it open unnoticed.
   */
  const closing = new Set<string>();
  async function retireSub(sub: string): Promise<boolean> {
    const rec = readSessionAgents(stateDir).find((x) => x.resident_id === sub);
    const folder = childOf.get(sub) ?? rec?.parent_id ?? "";
    spawnedOf.delete(sub);
    detach(sub, true);
    if (!rec) return true; // nothing recorded: never opened here, or already retired
    if (!rec.retiring) rememberSession({ ...rec, retiring: true });
    const parent = conns.get(folder);
    const signer = parent ? await loadSigner(keyStore, folder) : null;
    if (!parent || !signer || closing.has(sub)) return false;
    closing.add(sub);
    try {
      await closeSessionAgent({
        relayUrl: parent.spec.relay_url,
        parentId: folder,
        parentSigner: signer,
        residentId: sub,
        doFetch,
      });
      await keyStore.delete(sub);
      forgetSessionAgent(stateDir, sub);
      return true;
    } catch (e) {
      log.warn({ worker: sub, err: String(e) }, "subagent close failed");
      return false;
    } finally {
      closing.delete(sub);
    }
  }

  /**
   * `session_open` (`hawl mcp` in a joined folder): this terminal's own agent. Answers its
   * resident id, handle and name; the MCP process then signs with its key (stored here).
   */
  async function sessionOpen(req: Request) {
    const parentId = typeof req.resident_id === "string" ? req.resident_id : "";
    const parent = conns.get(parentId);
    if (!parent || childOf.has(parentId)) throw new Error("unknown agent");
    const hsid =
      typeof req.host_session_id === "string" ? req.host_session_id : "";
    if (!hsid || hsid.length > 200) throw new Error("bad host_session_id");
    const sessionKey = sessionKeyFor(parentId, hsid);
    const signer = await loadSigner(keyStore, parentId);
    if (!signer) throw new Error(`no key for ${parentId}`);
    // Codex: the provisional session this terminal started on, before its host said its id.
    const rhsid =
      typeof req.replaces_host_session_id === "string"
        ? req.replaces_host_session_id
        : "";
    if (rhsid.length > 200) throw new Error("bad replaces_host_session_id");
    let replaces =
      rhsid && rhsid !== hsid ? sessionKeyFor(parentId, rhsid) : undefined;
    const mine = readSessionAgents(stateDir).filter(
      (x) => x.parent_id === parentId,
    );
    const prov = replaces
      ? mine.find((x) => x.session_key === replaces)
      : undefined;
    // A session this terminal's agent was seen under after /clear: that agent takes it (the
    // relay moves the agent to this session when the agent's own key names its current one).
    const own = mine.find((x) => x.session_key === sessionKey);
    const seen = own
      ? undefined
      : mine.find((x) => !x.spawned_by && x.alias_keys?.includes(sessionKey));
    const open = (previous?: string, rp?: string) =>
      openSessionAgent({
        relayUrl: parent.spec.relay_url,
        parentId,
        parentSigner: signer,
        platform: parent.spec.platform,
        keyStore,
        sessionKey,
        ...(previous && { previous }),
        ...(rp && { replaces: rp }),
        doFetch,
      });
    // This session's own agent if this machine had one (a resume), else the one seen under it
    // after /clear, else the provisional one (its key proves to the relay it may take this session).
    const known = own ?? seen ?? prov;
    let agent: Awaited<ReturnType<typeof openSessionAgent>>;
    try {
      if (seen && prov && prov.resident_id !== seen.resident_id) {
        // `--continue` after /clear opened a provisional agent first: move the seen agent to
        // this session, then the open below retires the provisional one (a resume).
        await open(seen.resident_id, seen.session_key);
      } else if (seen) replaces = seen.session_key;
      agent = await open(known?.resident_id, replaces);
    } catch (e) {
      if (e instanceof SessionsUnsupported)
        return { unsupported: true, message: e.message };
      throw e;
    }
    // Its MCP server's parent (Claude Code): after `/clear` the hooks find it by that pid.
    const ppid =
      Number.isInteger(req.ppid) && (req.ppid as number) > 0
        ? (req.ppid as number)
        : undefined;
    // The same agent keeps the other ids it answers to (its earlier session among them).
    const aliases =
      known?.resident_id === agent.resident_id
        ? [...(known.alias_keys ?? []), known.session_key].filter(
            (k) => k !== agent.session_key,
          )
        : [];
    rememberSession({
      ...agent,
      ...(ppid && { mcp_ppid: ppid }),
      ...(aliases.length && { alias_keys: [...new Set(aliases)].slice(-20) }),
    });
    // A provisional agent the relay retired (this was a resume): let its socket go.
    if (prov && prov.resident_id !== agent.resident_id) {
      forgetSessionAgent(stateDir, prov.resident_id);
      detach(prov.resident_id);
      dropKeys([prov.resident_id]);
    }
    // A key the relay just replaced must not stay on a live socket.
    if (
      conns.has(agent.resident_id) &&
      known?.resident_id !== agent.resident_id
    )
      detach(agent.resident_id);
    liveSessions.beat(agent.resident_id, hsid);
    await attach(
      {
        relay_url: agent.relay_url,
        resident_id: agent.resident_id,
        platform: agent.platform,
      },
      false,
    );
    childOf.set(agent.resident_id, parentId);
    return {
      resident_id: agent.resident_id,
      handle: agent.handle,
      display_name: agent.display_name,
      session_of: parentId,
    };
  }

  const handle = async (
    req: Request,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const rid =
      typeof req.resident_id === "string" ? req.resident_id : undefined;
    // Hook calls act as the session's own agent (hookActor); everything else as the named worker.
    const actor =
      rid && HOOK_OPS.has(String(req.op)) ? await hookActor(req, rid) : rid;
    switch (req.op) {
      case "attach":
        await attach(req.worker as WorkerSpec);
        return { attached: true };
      case "session_open":
        return sessionOpen(req);
      case "subagent_open":
        return subagentOpen(req);
      case "subagent_close": {
        const folder = rid ?? "";
        const hsid =
          typeof req.host_session_id === "string" ? req.host_session_id : "";
        const terminal = hsid
          ? await terminalOf(folder, hsid, req.claude_pid)
          : undefined;
        // closed: the relay confirmed it retired. false: kept and retried (next Stop, sweep).
        const closed =
          !!terminal &&
          typeof req.agent_id === "string" &&
          (await subagentClose(terminal, req.agent_id));
        return { closed };
      }
      case "terminal_for": {
        // `hawl handover` run inside a terminal: that terminal's own agent. null: none (the folder's).
        const hsid =
          typeof req.host_session_id === "string" ? req.host_session_id : "";
        const t =
          rid && hsid ? await terminalOf(rid, hsid, req.claude_pid) : undefined;
        return t ? { resident_id: t } : null;
      }
      case "subagent_for": {
        // The terminal's MCP server: which agent a tool call made inside this subagent acts as.
        // Also one opened before a daemon restart. null: none here (the MCP server refuses).
        if (!rid || typeof req.agent_id !== "string") return null;
        const p = subOf(rid, req.agent_id);
        const sub = await Promise.race([
          p,
          new Promise<null>((r) => setTimeout(() => r(null), 10_000).unref()),
        ]);
        return sub ? { resident_id: sub } : null;
      }
      case "session_link": {
        // A Claude Code terminal's MCP server asks if its Claude's hooks report another session
        // (resumed with --continue): answers that session's id, which it opens with `replaces`.
        if (!rid || !conns.has(rid) || childOf.has(rid))
          throw new Error("unknown agent");
        const x =
          typeof req.host_session_id === "string" ? req.host_session_id : "";
        if (!x || x.length > 200) throw new Error("bad host_session_id");
        const ppid = Number.isInteger(req.ppid) ? (req.ppid as number) : 0;
        const y = await links.link(rid, x, {
          ...(ppid > 0 && { ppid }),
          parentOf,
          live: (id) => liveSessions.live(rid).includes(id),
        });
        return { host_session_id: y ?? null };
      }
      case "host_session": {
        // `hawl mcp` linked to this daemon: tell the relay the host loaded Hawl (EXP-16).
        const w = rid ? await get(rid) : undefined;
        if (!w) throw new Error("unknown agent");
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
        // A terminal's agent: its folder worker shows the agent open and the host attached too.
        const folder = conns.get(childOf.get(w.spec.resident_id) ?? "");
        if (folder) {
          liveSessions.beat(folder.spec.resident_id, id);
          folder.conn.sendFrame({
            t: "agent_session",
            host_session_id: id,
            state: "live",
          });
          folder.conn.sendFrame({ t: "host_session", host_session_id: id });
        }
        return {
          sent: w.conn.sendFrame({ t: "host_session", host_session_id: id }),
        };
      }
      case "agent_session": {
        // The MCP server's heartbeat (live) or goodbye (bye): is the agent itself still open?
        const w = rid ? await get(rid) : undefined;
        if (!w) throw new Error("unknown agent");
        const id =
          typeof req.host_session_id === "string" ? req.host_session_id : "";
        if (!id) throw new Error("bad host_session_id");
        // A server that gave up waiting for session_open beats as the folder, while the daemon
        // did open this session's own agent: those beats are the terminal's too, or the sweep
        // takes its socket every minute.
        if (rid && !childOf.has(rid)) {
          const key = sessionKeyFor(rid, id);
          const t = readSessionAgents(stateDir).find(
            (x) =>
              x.parent_id === rid &&
              !x.spawned_by &&
              (x.session_key === key || x.alias_keys?.includes(key)),
          );
          if (t && conns.has(t.resident_id))
            await handle({ ...req, resident_id: t.resident_id }, signal);
        }
        const state = req.state === "bye" ? "bye" : "live";
        if (state === "live") liveSessions.beat(w.spec.resident_id, id);
        else liveSessions.bye(w.spec.resident_id, id);
        const sent = w.conn.sendFrame({
          t: "agent_session",
          host_session_id: id,
          state,
        });
        const folderId = childOf.get(w.spec.resident_id);
        const folder = folderId ? conns.get(folderId) : undefined;
        if (folder) {
          if (state === "live") liveSessions.beat(folder.spec.resident_id, id);
          else liveSessions.bye(folder.spec.resident_id, id);
          folder.conn.sendFrame({
            t: "agent_session",
            host_session_id: id,
            state,
          });
        }
        // Its running subagents are open while it is (they send no heartbeat of their own).
        for (const [sub, term] of spawnedOf) {
          if (term !== w.spec.resident_id) continue;
          if (state === "live") liveSessions.beat(sub, id);
          else liveSessions.bye(sub, id);
          conns.get(sub)?.conn.sendFrame({
            t: "agent_session",
            host_session_id: id,
            state,
          });
        }
        // The terminal closed: its agent goes offline (the relay marks it on the socket close).
        if (state === "bye") dropIfClosed(w.spec.resident_id, true);
        return { sent };
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
            ...(childOf.has(w.spec.resident_id) && {
              session_of: childOf.get(w.spec.resident_id),
            }),
          })),
        };
      case "goal": {
        // The main-goal token of this session's own agent; one relay read, no other counts.
        const f = actor
          ? await inboxFacts(actor).catch(() => undefined)
          : undefined;
        return typeof f?.goal_rev === "string" ? { goal_rev: f.goal_rev } : {};
      }
      case "notice": {
        // Counts only. Prefer the relay's own notice; fall back to the verified spool.
        // A terminal's agent also reads its folder's mail, so the folder's count is added. A
        // folder worker named with the host's session id counts that terminal's agent too.
        // Inside a subagent (agent_id): only the subagent's own mail.
        let ws = rid ? [await get(rid)] : [...conns.values()];
        if (rid && childOf.has(rid)) ws.push(conns.get(childOf.get(rid) ?? ""));
        else if (actor && actor !== rid) {
          if (spawnedOf.has(actor)) ws = [conns.get(actor)];
          else ws.push(conns.get(actor));
        }
        let unread = 0;
        let needs_action = 0;
        // A room post can reach the terminal and its folder: count each message once.
        const spooled = new Set<string>();
        const aimedIds = new Set<string>();
        let copies = 0;
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
          for (const e of mine) {
            copies++;
            spooled.add(e.relay.message_id);
            if (isAimed(e, w.spec.resident_id))
              aimedIds.add(e.relay.message_id);
          }
        }
        unread = Math.max(unread - (copies - spooled.size), spooled.size);
        const aimed = aimedIds.size;
        // quiet_ms: since this agent's own last hook activity (idle wake skips busy agents).
        // `extras` (SessionStart): open work and a waiting handover, read with its own key.
        return {
          unread,
          needs_action,
          aimed,
          ...(actor && { as: actor, quiet_ms: quietFor(actor) }),
          ...(actor && req.extras === true && (await relayExtras(rid, actor))),
        };
      }
      case "peers": {
        const w = actor ? conns.get(actor) : undefined;
        if (!actor || !w) throw new Error("unknown agent");
        // `nowait`: PostToolUse reads the cache as it is and only starts a refresh behind it.
        return {
          who: await peersWho(actor, w, req.nowait !== true),
          as: actor,
        };
      }
      case "overlap": {
        // Tell-only: another agent's `watching` glob matches the file this agent is about to
        // edit. Returns who matched (once per file and agent per 30 min) and messages them.
        const w = actor ? conns.get(actor) : undefined;
        if (!actor || !w) throw new Error("unknown agent");
        const path = typeof req.path === "string" ? req.path : "";
        const who = await peersWho(actor, w);
        const now = Date.now();
        const hits = watchers(who, path).filter((h) =>
          claimOverlap(overlapSeen, `${actor}|${h.handle}|${path}`, now),
        );
        const me = (
          (who as { workers?: { resident_id?: string; handle?: string }[] })
            ?.workers ?? []
        ).find((x) => x.resident_id === actor)?.handle;
        for (const h of hits)
          void tellOverlap(actor, h.handle, me, path).catch(() => {});
        // Facts only, no message to the other agent: who changed this file in the last 10 min.
        const recent = recentEditors(who, path).filter((h) =>
          claimOverlap(
            overlapSeen,
            `${actor}|${h.handle}|${path}|recent`,
            now,
            RECENT_EDIT_S * 1000,
          ),
        );
        return { hits, recent, as: actor };
      }
      case "mailbox": {
        const w = rid ? await get(rid) : undefined;
        if (!w) throw new Error("unknown agent");
        return {
          envelopes: req.unread_only ? w.spool.unread() : w.spool.list(),
          // With read_state, one call answers which are read (mcp/server.ts mailbox).
          ...(req.read_state === true && { read: w.spool.readIds() }),
        };
      }
      case "mark_read": {
        const w = rid ? await get(rid) : undefined;
        if (!w) throw new Error("unknown agent");
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
        // Each terminal and subagent is its own agent: its line goes out on its own socket, and
        // only its own clock (with its terminal's and folder's) says it is busy.
        forwarderFor(actor).push(line);
        for (const id of [rid, actor, actor && spawnedOf.get(actor)])
          if (id) lastActivity.set(id, Date.now());
        const host = (req.line as { host?: unknown }).host;
        // Claude Code gives hooks CLAUDE_PID; the hook passes it so `--continue` can be paired.
        const claudePid = (req.line as { claude_pid?: unknown }).claude_pid;
        if (
          host === "claude_code" &&
          rid &&
          line.session_id &&
          line.kind !== "session_stop" &&
          Number.isInteger(claudePid) &&
          (claudePid as number) > 0
        )
          links.hookSaw(rid, line.session_id, claudePid as number);
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
          if (line.session_id) procActors.started(line.session_id, actor);
          poller.track(pid as number, line.session_id);
        } else if (line.kind === "session_stop" && line.session_id) {
          procActors.stopped(line.session_id);
          poller.untrackSession(line.session_id);
        }
        // A Bash/Monitor call with no description still shows, as "Bash (no reason given)".
        const why =
          line.reason ??
          (line.tool === "Bash" || line.tool === "Monitor"
            ? `${line.tool} (no reason given)`
            : undefined);
        const programs = (req.line as { programs?: unknown }).programs;
        if (line.kind === "tool_before" && why && line.session_id && actor)
          procActors.noted(line.session_id, why, actor);
        if (line.kind === "tool_before" && why && line.session_id)
          linker.note(
            line.session_id,
            why,
            Array.isArray(programs)
              ? programs
                  .filter((p) => typeof p === "string")
                  .slice(0, 12)
                  .map((p) => (p as string).slice(0, 64))
              : [],
            Date.now(),
            line.tool === "Monitor",
          );
        return { queued: true };
      }
      case "wait": {
        // A host stopped at a permission question (hook/hook.ts): the session's own status line says so, which the relay
        // already carries to its owner and to whoever asked. The end sets busy (the agent went on) or idle (its turn ended).
        // With no terminal agent for this session yet, `actor` is the folder: its line says nothing a person sees, so nothing is set and the hook keeps
        // its mark. Codex knows its hook session id to the helper only from its first Hawl tool call (seen on ws-b 2026-11-05), so a question before it waits unseen.
        const w = actor && actor !== rid ? await get(actor) : undefined;
        if (!w) return { ok: false };
        await w.conn.rpc({
          t: "tool.call",
          name: "status_set",
          // The end gives back the line the agent had set itself (the relay erases a line a status_set leaves out).
          args: waitLines.args(w.spec.resident_id, !!req.on, !!req.idle),
        });
        return { ok: true };
      }
      case "tool": {
        // Non-send MCP tools: one tool.call frame over the worker's WS (spec 16 §2.4.2).
        const w = rid ? await get(rid) : undefined;
        if (!w) throw new Error("unknown agent");
        let args = (req.args as Record<string, unknown> | undefined) ?? {};
        if (req.name === "status_set")
          waitLines.noted(w.spec.resident_id, args.working_on);
        // A shim of the thin kind (it sends its contract): the whole tool runs here and the
        // answer is the final MCP result. Callers without one (old shims, `hawl` commands)
        // get the raw relay answer below.
        if (typeof req.shim_contract === "number") {
          const signer = await signerFor(w.spec.resident_id);
          return runTool(
            {
              // One trace id per call: the caller's traceparent, or a minted one.
              daemon: tracedLink(
                { call: (op, a) => handle({ op, ...a }) },
                requestTrace({ traceparent: req.traceparent }),
              ),
              residentId: w.spec.resident_id,
              // A terminal's agent also reads the mail sent to its folder's worker.
              folderId: spawnedOf.has(w.spec.resident_id)
                ? undefined
                : childOf.get(w.spec.resident_id),
              signer,
              cwd: typeof req.cwd === "string" ? req.cwd : undefined,
              folder: typeof req.folder === "string" ? req.folder : undefined,
              signal,
            },
            String(req.name),
            args,
            {
              contract: req.shim_contract,
              host: typeof req.host === "string" ? req.host : undefined,
            },
          );
        }
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
          return logTool(req, rid, () =>
            settleFilePut(() =>
              w.conn.rpc({
                t: "tool.call",
                name: req.name,
                args,
                ...traceFrameField(req.trace),
              }),
            ),
          );
        }
        const out = await logTool(req, rid, () =>
          w.conn.rpc({
            t: "tool.call",
            name: req.name,
            args,
            ...traceFrameField(req.trace),
          }),
        );
        // The relay's own "stored" answer is the acknowledgement; keep it for `hawl handover status`.
        if (req.name === "handover_put" && rid) {
          try {
            recordAck(stateDir, rid, out);
          } catch {
            // The handover is stored on the relay; a local write failure only hides it from status.
          }
        }
        return out;
      }
      case "tools_list":
        // The tools this helper build offers, for a starting shim's tools/list.
        return { tools: toolDefs() };
      case "file_meta": {
        // The file part a send tool signs: name, mime, size and sha256 from the relay.
        const w = rid ? await get(rid) : undefined;
        if (!w) throw new Error("unknown agent");
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
        const w = rid ? await get(rid) : undefined;
        if (!w) throw new Error("unknown agent");
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
      case "yard": {
        // Does the relay give this worker a yard? A 404 is "no yard", not an error.
        const w = rid ? conns.get(rid) : undefined;
        if (!w) throw new Error("unknown agent");
        const signer = await loadSigner(keyStore, w.spec.resident_id);
        if (!signer) throw new Error(`no key for ${w.spec.resident_id}`);
        const token = await agentToken(
          w.spec.relay_url,
          w.spec.resident_id,
          signer,
          doFetch,
        );
        const res = await doFetch(new URL("/v1/agent/yard", w.spec.relay_url), {
          headers: { authorization: `Bearer ${token}` },
        });
        if (res.status === 404) return { yard: null };
        if (!res.ok) throw new Error(`relay ${res.status}`);
        return res.json();
      }
      case "send_tool": {
        // A send tool with side effects beyond the message (handoff): REST with the signed request.
        const w = rid ? await get(rid) : undefined;
        if (!w) throw new Error("unknown agent");
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
            // The relay's HTTP layer continues this trace (same id as a ws frame carries).
            ...traceHeader(req.trace),
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
        const w = rid ? await get(rid) : undefined;
        if (!w) throw new Error("unknown agent");
        return w.conn.sendMessage({
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
          ...traceFrameField(req.trace),
        });
      }
      case "resolve": {
        // Directory lookups for send tools: handle -> worker, message -> thread (spec 16 2.4).
        const w = rid ? await get(rid) : undefined;
        if (!w) throw new Error("unknown agent");
        const tool = req.tool as string;
        const a = (req.args as Record<string, unknown> | undefined) ?? {};
        if (tool === "thread_reply") {
          const id = String(a.message_id);
          // A terminal's agent may answer mail sent to its folder.
          const folder = conns.get(childOf.get(w.spec.resident_id) ?? "");
          const env = [...w.spool.list(), ...(folder?.spool.list() ?? [])].find(
            (e) => e.relay.message_id === id,
          );
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
            throw new Error("this site has no Hawl system agent yet");
          return {
            to: { kind: "worker", resident_id: hit.resident_id },
            conversation_id: null,
            reply_to: null,
          };
        }
        if (tool === "dm_send" || tool === "handoff") {
          if (a.to === undefined)
            throw new Error(
              "name the agent in `to`: routing by ask_town is not available yet",
            );
          const handle = String(a.to).replace(/^@/, "");
          const r = (await w.conn.rpc({
            t: "tool.call",
            name: "who",
            args: { query: handle },
          })) as { workers?: { handle?: string; resident_id?: string }[] };
          const hit = r.workers?.find((x) => bare(x.handle) === handle);
          if (!hit) throw new Error(`no agent @${handle}`);
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
            if (!hit?.resident_id) throw new Error(`no agent @${handle}`);
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
  /** Proxied calls running now; the live swap waits for zero. */
  let inflight = 0;
  const gated = async (
    req: Request,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (req.op === "status" || req.op === "shutdown") return handle(req);
    inflight++;
    try {
      return await gatedCall(req, signal);
    } finally {
      inflight--;
    }
  };
  const gatedCall = async (
    req: Request,
    signal?: AbortSignal,
  ): Promise<unknown> => {
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
    return handle(req, signal);
  };
  const sock = await startSocketServer(stateDir, gated);
  // The same tools for scripts and local models over 127.0.0.1 (api/http.ts). Best effort.
  const api = await startApiServer(
    stateDir,
    { call: (op, a) => gated({ op, ...a }) },
    () => [...conns.keys()].filter((id) => !childOf.has(id)),
    opts.version,
  ).catch((e: Error) => {
    log.info({ err: e.message }, "local api did not start");
    return null;
  });
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
  // Keys left behind by agents that ended before keys were deleted with them. Not when HAWL_HOME
  // moves the state: the OS keychain is shared by every state dir on the machine.
  if (
    opts.pruneStaleKeys &&
    (keyStore.kind !== "keychain" || !process.env.HAWL_HOME)
  ) {
    const prune = async () => {
      const m = await import("../commands/leave.ts");
      return pruneKeys(
        keyStore,
        () =>
          new Set([
            ...readWorkers(stateDir).map((w) => w.resident_id),
            ...readSessionAgents(stateDir).map((x) => x.resident_id),
            ...m.readRevokeQueue(stateDir).map((q) => q.resident_id),
            ...conns.keys(),
          ]),
        (a) => keyIsFresh(stateDir, a),
      );
    };
    setTimeout(
      () => void prune().catch(() => {}),
      opts.pruneDelayMs ?? 30_000,
    ).unref();
  }
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
  // A terminal killed without a goodbye: its agent's heartbeats stop, so let its socket go.
  const closedTimer = setInterval(() => {
    // A terminal closed by killing its tab sends no goodbye (Windows cannot catch the kill): its host process being gone is the goodbye,
    // so the site stops showing it as running now, not after the heartbeats' 45 s run out.
    const alive =
      opts.pidAlive ??
      ((pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (e) {
          return (e as NodeJS.ErrnoException).code === "EPERM";
        }
      });
    for (const s of readSessionAgents(stateDir)) {
      if (
        s.spawned_by ||
        !s.mcp_ppid ||
        !conns.has(s.resident_id) ||
        alive(s.mcp_ppid)
      )
        continue;
      for (const id of liveSessions.live(s.resident_id))
        void handle({
          op: "agent_session",
          resident_id: s.resident_id,
          host_session_id: id,
          state: "bye",
        }).catch(() => {});
    }
    for (const rid of [...childOf.keys()]) dropIfClosed(rid, false);
    // Ended subagents the relay has not confirmed retired yet: try again.
    for (const s of readSessionAgents(stateDir))
      if (s.retiring) void retireSub(s.resident_id);
  }, opts.closedSweepMs ?? 15_000);
  closedTimer.unref();

  const stopUpdater = opts.update
    ? startUpdater({ ...opts.update, stateDir })
    : undefined;

  const swapTick = async (checkStage: boolean) => {
    const ls = opts.liveSwap;
    if (!ls) return "none";
    if (checkStage) {
      try {
        await ls.stage?.();
      } catch (e) {
        log.info({ err: (e as Error).message }, "helper stage failed");
      }
    }
    return swapWhenIdle({
      stateDir,
      current: opts.version ?? "0.0.0",
      next: ls.next,
      idle: () => inflight === 0,
      drainMs: ls.drainMs,
      log: (l) => log.info({ update: l }, "swap"),
      stop: () => self.stop(),
    }).then((r) => {
      if (r === "swapped") (opts.onShutdown ?? (() => process.exit(0)))();
      return r;
    });
  };
  let lastStage = 0;
  const swapTimer = opts.liveSwap
    ? setInterval(
        () => {
          const due = Date.now() - lastStage >= 24 * 60 * 60_000;
          if (due) lastStage = Date.now();
          void swapTick(due).catch(() => {});
        },
        opts.liveSwap.intervalMs ?? 5 * 60_000,
      )
    : undefined;
  swapTimer?.unref();
  const swapFirst = opts.liveSwap
    ? setTimeout(() => {
        lastStage = Date.now();
        void swapTick(true).catch(() => {});
      }, opts.liveSwap.firstMs ?? 30_000)
    : undefined;
  swapFirst?.unref();

  const self = {
    stateDir,
    /** One staged-version check and swap attempt now (tests). */
    swapTick,
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
      if (swapTimer) clearInterval(swapTimer);
      if (swapFirst) clearTimeout(swapFirst);
      stopUpdater?.();
      clearInterval(closedTimer);
      clearInterval(debugTimer);
      if (wakeTimer) clearInterval(wakeTimer);
      for (const id of [...conns.keys()]) detach(id);
      forwarder.stop();
      for (const f of routed.values()) f.stop();
      poller.stop();
      await otlp?.close();
      await api?.close();
      await sock.close();
    },
  };
  return self;
}

if (import.meta.main) {
  startDaemon({ version: "0.0.0", pruneStaleKeys: true }).catch((e: Error) => {
    createDaemonLogger(defaultStateDir()).error(
      { err: e.message },
      "daemon failed",
    );
    process.stderr.write(`hawl daemon: ${e.message}\n`);
    process.exit(e instanceof DaemonRunningError ? 0 : 1);
  });
}
