import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { formatNotice } from "../hook/notice.ts";

/**
 * Codex dedicated resident thread (owner opt-in, spec 16 §10.1 #5, 02 §7.3 `app_server_turn`).
 * The daemon owns `codex app-server` over stdio. The only text ever sent in a turn is the fixed
 * notice template. The thread is sensitive (forced).
 */
export const CODEX_THREAD_SENSITIVE = true as const;
export const DEFAULT_TURN_TIMEOUT_MS = 60_000;

export interface ProcLike {
  stdin: { write(s: string): unknown };
  stdout: NodeJS.ReadableStream;
  kill(): unknown;
  on(ev: "exit", cb: () => void): unknown;
}

export interface CodexAppServerOpts {
  /** Fixed working directory for the thread. Never taken from a message. */
  cwd: string;
  /** Thread id to resume; omit to start a new one. */
  threadId?: string;
  turnTimeoutMs?: number;
  effort?: "low" | "medium" | "high";
  spawnFn?: () => ProcLike;
}

type Pending = { res: (v: any) => void; rej: (e: Error) => void };

export class CodexAppServer {
  readonly sensitive = CODEX_THREAD_SENSITIVE;
  threadId: string | undefined;
  private p: ProcLike | undefined;
  private id = 1;
  private pending = new Map<number, Pending>();
  private waiters: Array<(m: any) => boolean> = [];
  private busy = false;

  private o: CodexAppServerOpts;
  constructor(o: CodexAppServerOpts) {
    this.o = o;
    this.threadId = o.threadId;
  }

  private start(): ProcLike {
    const p: ProcLike =
      this.o.spawnFn?.() ??
      spawn("codex", ["app-server"], {
        shell: true,
        stdio: ["pipe", "pipe", "ignore"],
        cwd: this.o.cwd,
        windowsHide: true,
      });
    createInterface({ input: p.stdout }).on("line", (l) => this.onLine(l));
    p.on("exit", () => {
      for (const w of this.pending.values())
        w.rej(new Error("app-server exited"));
      this.pending.clear();
      this.p = undefined;
    });
    return p;
  }

  private onLine(l: string) {
    let m: any;
    try {
      m = JSON.parse(l);
    } catch {
      return;
    }
    if (m.id !== undefined && (m.result !== undefined || m.error)) {
      const w = this.pending.get(m.id);
      if (!w) return;
      this.pending.delete(m.id);
      if (m.error) w.rej(new Error(JSON.stringify(m.error)));
      else w.res(m.result);
      return;
    }
    if (m.id !== undefined && m.method) {
      // Server asks for approval or input: always decline.
      this.p?.stdin.write(
        `${JSON.stringify({ id: m.id, error: { code: -32000, message: "declined" } })}\n`,
      );
      return;
    }
    this.waiters = this.waiters.filter((w) => !w(m));
  }

  private req(method: string, params: unknown): Promise<any> {
    const id = this.id++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.p?.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private async ensure(): Promise<string> {
    if (this.p && this.threadId) return this.threadId;
    this.p = this.start();
    await this.req("initialize", {
      clientInfo: { name: "hawl", title: "hawl", version: "0.0.0" },
      capabilities: null,
    });
    this.p.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const base = {
      cwd: this.o.cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
    };
    if (this.threadId) {
      await this.req("thread/resume", { threadId: this.threadId, ...base });
    } else {
      const r = await this.req("thread/start", { ...base, ephemeral: false });
      this.threadId = r.thread.id;
    }
    return this.threadId as string;
  }

  /** Wake the resident thread. Sends the fixed notice only. False when there is nothing to send. */
  async wake(unread: number): Promise<boolean> {
    const text = formatNotice(unread);
    if (!text || this.busy) return false;
    this.busy = true;
    const ms = this.o.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    try {
      const threadId = await this.ensure();
      const done = new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error("turn timeout")), ms);
        this.waiters.push((m) => {
          if (
            m.method === "turn/completed" &&
            m.params?.threadId === threadId
          ) {
            clearTimeout(t);
            res();
            return true;
          }
          return false;
        });
      });
      done.catch(() => {});
      await this.req("turn/start", {
        threadId,
        input: [{ type: "text", text }],
        effort: this.o.effort ?? "low",
      });
      await done;
      return true;
    } catch (e) {
      this.stop();
      throw e;
    } finally {
      this.busy = false;
    }
  }

  stop() {
    const p = this.p;
    this.p = undefined;
    this.waiters = [];
    try {
      p?.kill();
    } catch {}
  }
}
