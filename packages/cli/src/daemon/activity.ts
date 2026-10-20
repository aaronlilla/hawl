import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename } from "node:path";

/**
 * Live activity collector (spec 16 §3.9). Everything local reports to the daemon:
 * hook lines over the socket, host OpenTelemetry on a loopback receiver, and the child-process
 * tree of known agent PIDs every 2 s. The forwarder batches them to the relay at most every 250 ms.
 * Lines carry ids, tool name and a short target. Never prompts, bodies, arguments or env.
 */

export const ACTIVITY_KINDS = [
  "session_start",
  "session_stop",
  "subagent_start",
  "subagent_stop",
  "tool_before",
  "tool_after",
  "model_call",
  "process_start",
  "process_exit",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityLine {
  kind: ActivityKind;
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

const STR_FIELDS: [keyof ActivityLine, number][] = [
  ["host", 32],
  ["session_id", 128],
  ["agent_id", 128],
  ["agent_type", 64],
  ["tool", 64],
  ["target", 120],
  ["model", 96],
  ["name", 128],
];

/** Whitelist and clamp. Anything not listed here is dropped, so content cannot leak through. */
export function sanitizeLine(
  raw: unknown,
  source: ActivityLine["source"],
  now = new Date(),
): ActivityLine | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!ACTIVITY_KINDS.includes(r.kind as ActivityKind)) return null;
  const line: ActivityLine = {
    kind: r.kind as ActivityKind,
    source,
    ts: now.toISOString(),
  };
  for (const [k, max] of STR_FIELDS) {
    const v = r[k];
    if (typeof v === "string" && v) {
      (line as unknown as Record<string, unknown>)[k] = v
        .replace(/[\u0000-\u001f]/g, " ")
        .slice(0, max);
    }
  }
  for (const k of ["pid", "parent_pid"] as const) {
    const v = r[k];
    if (Number.isInteger(v) && (v as number) > 0) line[k] = v as number;
  }
  if (r.exit_code === null || Number.isInteger(r.exit_code)) {
    line.exit_code = r.exit_code as number | null;
  }
  return line;
}

// ---- 250 ms batch forwarder ----

export interface ForwarderOptions {
  /** Returns true when the batch was handed to the relay connection. */
  sink: (batch: ActivityLine[]) => boolean;
  intervalMs?: number;
  maxBuffer?: number;
}

export class ActivityForwarder {
  private buf: ActivityLine[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly o: ForwarderOptions;

  constructor(o: ForwarderOptions) {
    this.o = o;
  }

  push(line: ActivityLine): void {
    this.buf.push(line);
    const max = this.o.maxBuffer ?? 1000;
    if (this.buf.length > max) this.buf.splice(0, this.buf.length - max);
    this.arm();
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.o.intervalMs ?? 250);
    this.timer.unref();
  }

  /** Send everything buffered as one batch. Kept for the next tick if the relay is not reachable. */
  flush(): void {
    if (this.buf.length === 0) return;
    const batch = this.buf;
    let sent = false;
    try {
      sent = this.o.sink(batch);
    } catch {
      sent = false;
    }
    if (sent) this.buf = [];
    else this.arm();
  }

  get pending(): number {
    return this.buf.length;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

// ---- loopback OTLP receiver ----

type OtlpValue = {
  stringValue?: string;
  intValue?: string | number;
};
type OtlpAttr = { key?: string; value?: OtlpValue };

function attrMap(attrs: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(attrs)) return out;
  for (const a of attrs as OtlpAttr[]) {
    const v = a?.value;
    if (!a?.key || !v) continue;
    if (typeof v.stringValue === "string") out[a.key] = v.stringValue;
    else if (v.intValue !== undefined) out[a.key] = String(v.intValue);
  }
  return out;
}

const first = (m: Record<string, string>, keys: string[]) =>
  keys.map((k) => m[k]).find((v) => v !== undefined);

/**
 * Reads only ids, tool name and model name out of OTLP/JSON logs and spans.
 * Prompt text, tool arguments and bodies are never read. [U: attribute names follow the
 * Claude Code monitoring docs and the GenAI semantic conventions; verify per host in CLI-3.]
 */
export function linesFromOtlp(
  kind: "logs" | "traces",
  body: unknown,
  now = new Date(),
): ActivityLine[] {
  const out: ActivityLine[] = [];
  const b = body as {
    resourceLogs?: {
      resource?: { attributes?: unknown };
      scopeLogs?: { logRecords?: { attributes?: unknown }[] }[];
    }[];
    resourceSpans?: {
      resource?: { attributes?: unknown };
      scopeSpans?: { spans?: { attributes?: unknown }[] }[];
    }[];
  };
  const items: {
    res: Record<string, string>;
    attrs: Record<string, string>;
  }[] = [];
  if (kind === "logs") {
    for (const rl of b?.resourceLogs ?? []) {
      const res = attrMap(rl.resource?.attributes);
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          items.push({ res, attrs: attrMap(lr.attributes) });
        }
      }
    }
  } else {
    for (const rs of b?.resourceSpans ?? []) {
      const res = attrMap(rs.resource?.attributes);
      for (const ss of rs.scopeSpans ?? []) {
        for (const sp of ss.spans ?? []) {
          items.push({ res, attrs: attrMap(sp.attributes) });
        }
      }
    }
  }
  for (const { res, attrs } of items) {
    const session_id = first(attrs, [
      "session.id",
      "session_id",
      "conversation.id",
    ]);
    const host = first(res, ["service.name"]);
    const tool = first(attrs, ["tool_name", "tool.name", "gen_ai.tool.name"]);
    const model = first(attrs, ["model", "gen_ai.request.model"]);
    if (tool) {
      out.push({
        kind: "tool_after",
        source: "otlp",
        ts: now.toISOString(),
        host,
        session_id,
        tool,
      });
    } else if (model) {
      out.push({
        kind: "model_call",
        source: "otlp",
        ts: now.toISOString(),
        host,
        session_id,
        model,
      });
    }
  }
  return out
    .map((l) => sanitizeLine(l, "otlp", now))
    .filter((l): l is ActivityLine => l !== null);
}

const MAX_BODY = 4 << 20;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export async function startOtlpReceiver(
  onLines: (lines: ActivityLine[]) => void,
  port = 0,
): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const reply = (code: number, msg = "{}") => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(msg);
    };
    // Loopback only, and a loopback Host header, so a web page cannot reach it by DNS rebinding.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (
      !LOOPBACK.has(req.socket.remoteAddress ?? "") ||
      !["127.0.0.1", "localhost", "[::1]"].includes(host)
    ) {
      return reply(403, '{"error":"loopback only"}');
    }
    const path = (req.url ?? "").split("?")[0];
    const kind =
      path === "/v1/logs" ? "logs" : path === "/v1/traces" ? "traces" : null;
    if (req.method !== "POST" || (!kind && path !== "/v1/metrics")) {
      return reply(404, '{"error":"not found"}');
    }
    if (
      !String(req.headers["content-type"] ?? "").startsWith("application/json")
    ) {
      return reply(415, '{"error":"send OTLP/JSON"}');
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reply(413, '{"error":"too large"}');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY) return;
      if (kind) {
        try {
          const lines = linesFromOtlp(
            kind,
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          );
          if (lines.length) onLines(lines);
        } catch {
          return reply(400, '{"error":"bad json"}');
        }
      }
      reply(200);
    });
  });
  const listen = (p: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(p, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await listen(port);
  } catch (e) {
    if (port === 0 || (e as NodeJS.ErrnoException).code !== "EADDRINUSE") {
      throw e;
    }
    await listen(0);
  }
  server.unref();
  return {
    server,
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---- 2 s process-tree poller ----

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
}

/** Name, PID, parent only. No arguments, no env. */
export function listProcesses(): Promise<ProcInfo[]> {
  if (process.platform === "linux") {
    return Promise.resolve(
      readdirSync("/proc")
        .filter((d) => /^\d+$/.test(d))
        .flatMap((d) => {
          try {
            const stat = readFileSync(`/proc/${d}/stat`, "utf8");
            const m = /^(\d+) \((.*)\) \S (\d+)/.exec(stat);
            return m
              ? [
                  {
                    pid: Number(m[1]),
                    ppid: Number(m[3]),
                    name: m[2] as string,
                  },
                ]
              : [];
          } catch {
            return [];
          }
        }),
    );
  }
  const [cmd, args] =
    process.platform === "win32"
      ? [
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }',
          ],
        ]
      : ["ps", ["-A", "-o", "pid=,ppid=,comm="]];
  return new Promise((resolve) => {
    execFile(
      cmd as string,
      args as string[],
      { timeout: 5000, windowsHide: true, maxBuffer: 8 << 20 },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          stdout.split(/\r?\n/).flatMap((l) => {
            const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(l);
            return m
              ? [
                  {
                    pid: Number(m[1]),
                    ppid: Number(m[2]),
                    name: basename(m[3] as string),
                  },
                ]
              : [];
          }),
        );
      },
    );
  });
}

export interface PollerOptions {
  emit: (line: ActivityLine) => void;
  list?: () => Promise<ProcInfo[]>;
  intervalMs?: number;
  now?: () => Date;
}

export class ProcessPoller {
  private roots = new Map<number, string | undefined>();
  private seen = new Map<number, { info: ProcInfo; session?: string }>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly o: PollerOptions;

  constructor(o: PollerOptions) {
    this.o = o;
  }

  /** Watch the child tree of an agent process. Starts the 2 s timer on the first PID. */
  track(pid: number, session?: string): void {
    this.roots.set(pid, session);
    if (!this.timer) {
      this.timer = setInterval(
        () => void this.poll(),
        this.o.intervalMs ?? 2000,
      );
      this.timer.unref();
    }
  }

  untrackSession(session: string): void {
    for (const [pid, s] of this.roots)
      if (s === session) this.roots.delete(pid);
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const all = await (this.o.list ?? listProcesses)();
      const alive = new Set(all.map((p) => p.pid));
      const kids = new Map<number, ProcInfo[]>();
      for (const p of all) {
        kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
      }
      const now = (this.o.now ?? (() => new Date()))();
      const current = new Map<number, { info: ProcInfo; session?: string }>();
      for (const [root, session] of this.roots) {
        if (!alive.has(root)) {
          this.roots.delete(root);
          continue;
        }
        const stack = [...(kids.get(root) ?? [])];
        while (stack.length) {
          const p = stack.pop() as ProcInfo;
          if (current.has(p.pid)) continue;
          current.set(p.pid, { info: p, session });
          stack.push(...(kids.get(p.pid) ?? []));
        }
      }
      for (const [pid, v] of current) {
        if (this.seen.has(pid)) continue;
        this.o.emit({
          kind: "process_start",
          source: "proc",
          ts: now.toISOString(),
          session_id: v.session,
          pid,
          parent_pid: v.info.ppid,
          name: v.info.name,
        });
      }
      for (const [pid, v] of this.seen) {
        if (current.has(pid)) continue;
        this.o.emit({
          kind: "process_exit",
          source: "proc",
          ts: now.toISOString(),
          session_id: v.session,
          pid,
          parent_pid: v.info.ppid,
          name: v.info.name,
          exit_code: null, // a snapshot poll cannot see the exit code
        });
      }
      this.seen = current;
      if (this.roots.size === 0 && this.seen.size === 0) this.stop();
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
