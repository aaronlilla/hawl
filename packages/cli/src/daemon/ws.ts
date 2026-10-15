import { randomBytes } from "node:crypto";
import type { Envelope } from "@hawl/protocol/src/envelope.ts";
import { b64url } from "@hawl/protocol/src/hash.ts";
import {
  handshakeSignInput,
  readySignInput,
  verifyDetached,
} from "@hawl/protocol/src/sign.ts";
import { validateFrame } from "@hawl/protocol/src/validate.ts";
import WebSocket from "ws";
import type { Signer } from "./keys.ts";
import type { ManifestStore } from "./manifest.ts";
import type { Spool } from "./spool.ts";
import {
  type DropReason,
  type VerifyContext,
  verifyEnvelope,
} from "./verify.ts";

export type WorkerState = "connecting" | "handshake" | "connected" | "stopped";

export interface WorkerOptions {
  /** wss://relay.example/v1/ws (or ws:// in tests). */
  wsUrl: string;
  residentId: string;
  platform: string;
  signer: Signer;
  manifests: ManifestStore;
  spool: Spool;
  senderKey?: VerifyContext["senderKey"];
  version?: string;
  /** Called when a delivery fails verification. It is dropped, never spooled, never ACKed. */
  onDrop?: (reason: DropReason, messageId: string | undefined) => void;
  onNotice?: (n: { unread: number; needs_action: number }) => void;
  onState?: (s: WorkerState) => void;
  /** Called when the handshake is refused (bad ready.relay_sig, wrong resident). */
  onRefused?: (why: string) => void;
  /** Called when the manifest has lapsed or lacks the relay key: refetch it. */
  onManifestStale?: () => void;
  reconnectMs?: { min: number; max: number };
  handshakeTimeoutMs?: number;
  /**
   * The relay pings every 25 s and drops us after 51 s of silence. With no frame from the relay
   * for this long the socket is half-open (Wi-Fi change, NAT timeout): drop it and reconnect.
   */
  staleMs?: number;
  /** How often the liveness check runs; a gap far above it means the machine slept. */
  watchdogMs?: number;
  /** Jitter source in [0, 1), so a relay restart does not get every daemon back at once. */
  random?: () => number;
}

/** Close codes after which retrying fast cannot help (refused handshake, CLI too old). */
const SLOW_RETRY = new Set([4401, 4403, 4426]);

interface Hello {
  t: "hello";
  nonce: string;
  server_time: string;
  relay_kid: string;
}

/** One WS per worker (spec 16 §3.1). Handshake 04 §5.2, ACK only after the spool is durable. */
/** A relay error that keeps `code`, `details` and `retry_after` (they cross the helper socket too). */
export interface ToolErrorInfo {
  code?: string;
  details?: Record<string, unknown>;
  retry_after?: number;
}
export class ToolError extends Error {
  info: ToolErrorInfo;
  constructor(message: string, info: ToolErrorInfo = {}) {
    super(message);
    this.name = "ToolError";
    this.info = info;
  }
}

export class WorkerConnection {
  state: WorkerState = "connecting";
  notice = { unread: 0, needs_action: 0 };
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private backoff: number;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private lastSeen = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private lastTick = 0;
  private rpcSeq = 0;
  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  private readonly o: WorkerOptions;

  constructor(o: WorkerOptions) {
    this.o = o;
    this.backoff = o.reconnectMs?.min ?? 1000;
  }

  private set(s: WorkerState): void {
    this.state = s;
    this.o.onState?.(s);
  }

  start(): void {
    this.stopped = false;
    this.connect();
    const every = this.o.watchdogMs ?? 5_000;
    this.lastTick = Date.now();
    this.watchdog = setInterval(() => this.tick(every), every);
    this.watchdog.unref();
  }

  /** Reconnect now: after a sleep, a network change or a stale socket. Skips the backoff wait. */
  kick(): void {
    if (this.stopped) return;
    this.backoff = this.o.reconnectMs?.min ?? 1000;
    if (this.ws) {
      this.ws.terminate(); // 'close' schedules the reconnect
    } else if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.connect();
    }
  }

  private tick(every: number): void {
    const now = Date.now();
    const slept = now - this.lastTick > every + 30_000;
    this.lastTick = now;
    if (slept) return this.kick();
    const stale = this.o.staleMs ?? 70_000;
    if (this.state === "connected" && now - this.lastSeen > stale) this.kick();
  }

  /** Fire-and-forget frame to the relay. False when the socket is not ready. */
  sendFrame(frame: Record<string, unknown>): boolean {
    if (this.state !== "connected" || this.ws?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  /** Send a frame that carries an `id` and wait for the relay's answer with that id. */
  rpc(frame: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    const id = `r${++this.rpcSeq}`;
    return new Promise((resolve, reject) => {
      if (!this.sendFrame({ ...frame, id })) {
        return reject(new Error("relay not connected"));
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("relay timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private failPending(why: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
      this.pending.delete(id);
    }
  }

  private answer(f: Record<string, unknown>): boolean {
    // Relay error frames name the request in `ref`; answers carry `id`.
    const id =
      typeof f.id === "string"
        ? f.id
        : typeof f.ref === "string"
          ? f.ref
          : undefined;
    const p = id ? this.pending.get(id) : undefined;
    if (!id || !p) return false;
    if (!validateFrame(f).ok) return true;
    this.pending.delete(id);
    clearTimeout(p.timer);
    const err = f.error as
      | {
          message?: string;
          code?: string;
          details?: Record<string, unknown>;
          retry_after?: number | null;
        }
      | undefined;
    if (f.t === "tool.result" && err === undefined) p.resolve(f.result);
    else if (err)
      p.reject(
        new ToolError(err.message ?? err.code ?? "relay error", {
          code: err.code,
          details: err.details,
          retry_after: err.retry_after ?? undefined,
        }),
      );
    else p.resolve(f);
    return true;
  }

  stop(): void {
    this.failPending("worker stopped");
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close(1000);
    this.set("stopped");
  }

  private connect(): void {
    if (this.stopped) return;
    this.set("connecting");
    const ws = new WebSocket(this.o.wsUrl, "relay.v1");
    this.ws = ws;
    let hello: Hello | null = null;
    let clientNonce = "";
    let ready = false;
    const hsTimer = setTimeout(
      () => ws.close(4408, "handshake timeout"),
      this.o.handshakeTimeoutMs ?? 10_000,
    );

    const refuse = (why: string) => {
      this.o.onRefused?.(why);
      ws.close(4401, "handshake refused");
    };

    ws.on("message", (raw) => {
      this.lastSeen = Date.now();
      let f: Record<string, unknown>;
      try {
        f = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!ready) {
        if (f.t === "hello" && !hello) {
          hello = f as unknown as Hello;
          this.set("handshake");
          clientNonce = b64url(randomBytes(32));
          const sig = this.o.signer.sign(
            handshakeSignInput({
              nonce: hello.nonce,
              clientNonce,
              residentId: this.o.residentId,
              serverTime: hello.server_time,
            }),
          );
          ws.send(
            JSON.stringify({
              t: "auth",
              resident_id: this.o.residentId,
              kid: this.o.signer.kid,
              client_nonce: clientNonce,
              sig: b64url(sig),
              resume: { last_acked_seq: this.o.spool.lastSeq() },
              client: {
                name: "hawl",
                version: this.o.version ?? "0.0.0",
                platform: this.o.platform,
              },
            }),
          );
          return;
        }
        if (f.t === "ready" && hello) {
          const key = this.o.manifests.relayKey(
            hello.relay_kid,
            hello.server_time,
          );
          if (!key) {
            this.o.onManifestStale?.();
            return refuse("relay key not in the pinned manifest");
          }
          if (
            f.resident_id !== this.o.residentId ||
            typeof f.session_id !== "string" ||
            typeof f.relay_sig !== "string"
          ) {
            return refuse("ready frame malformed");
          }
          const ok = verifyDetached(
            "ES256",
            key,
            readySignInput({
              nonce: hello.nonce,
              client_nonce: clientNonce,
              resident_id: this.o.residentId,
              session_id: f.session_id,
              server_time: hello.server_time,
            }),
            f.relay_sig,
          );
          if (!ok) return refuse("ready.relay_sig does not verify");
          ready = true;
          clearTimeout(hsTimer);
          this.backoff = this.o.reconnectMs?.min ?? 1000;
          this.set("connected");
          return;
        }
        return; // nothing else is trusted before a verified ready
      }
      this.onFrame(ws, f);
    });

    ws.on("close", (code) => {
      clearTimeout(hsTimer);
      if (this.ws !== ws) return; // an old socket closing after a kick already replaced it
      this.ws = null;
      this.failPending("relay connection closed");
      if (this.stopped) return;
      this.set("connecting");
      const max = this.o.reconnectMs?.max ?? 30_000;
      if (SLOW_RETRY.has(code)) this.backoff = max;
      // Equal jitter: half the backoff fixed, half random.
      const r = (this.o.random ?? Math.random)();
      const wait = Math.round(this.backoff / 2 + (this.backoff / 2) * r);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.connect();
      }, wait);
      this.backoff = Math.min(this.backoff * 2, max);
    });
    ws.on("error", () => {
      // 'close' follows and drives the reconnect
    });
  }

  private onFrame(ws: WebSocket, f: Record<string, unknown>): void {
    if (f.t === "ping") {
      ws.send(JSON.stringify({ t: "pong", ts: f.ts }));
      return;
    }
    if (
      (f.t === "tool.result" || f.t === "msg.accepted" || f.t === "error") &&
      this.answer(f)
    ) {
      return;
    }
    if (f.t === "notice") {
      if (validateFrame(f).ok) {
        this.notice = {
          unread: f.unread as number,
          needs_action: f.needs_action as number,
        };
        this.o.onNotice?.(this.notice);
      }
      return;
    }
    if (f.t === "deliver") {
      // Deliveries are handled one at a time so spool order and ACK order match.
      this.queue = this.queue.then(() => this.onDeliver(ws, f)).catch(() => {});
    }
  }

  private async onDeliver(
    ws: WebSocket,
    f: Record<string, unknown>,
  ): Promise<void> {
    const env = f.envelope as Envelope | undefined;
    const id = env?.relay?.message_id;
    if (!env || !validateFrame(f).ok) return void this.o.onDrop?.("schema", id);
    // Already durable: re-ACK, do not re-process (04 §4.2).
    if (this.o.spool.has(env.relay.message_id)) return this.ack(ws, env);
    const bad = await verifyEnvelope(env, {
      manifests: this.o.manifests,
      residentId: this.o.residentId,
      senderKey: this.o.senderKey,
    });
    if (bad) {
      if (bad === "manifest_unusable" || bad === "relay_key_unknown")
        this.o.onManifestStale?.();
      return void this.o.onDrop?.(bad, id);
    }
    this.o.spool.put(env); // fsynced before the ACK below
    this.ack(ws, env);
  }

  private ack(ws: WebSocket, env: Envelope): void {
    if (ws.readyState === WebSocket.OPEN)
      ws.send(
        JSON.stringify({ t: "ack", message_ids: [env.relay.message_id] }),
      );
  }
}
