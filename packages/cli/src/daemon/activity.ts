import { type ChildProcess, execFile, spawn } from "node:child_process";
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

/**
 * The status line a session shows on the relay while Claude Code waits at a permission question. The relay carries it as the
 * session's `working_on`; the Workstation reads these exact words (WAITING_LINE in its ws-tasks.ts).
 */
export const WAITING_LINE = "Waiting for its owner's OK";

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
  /** The agent's own one-line reason (Bash/Monitor `description`), never the command. */
  reason?: string;
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
  ["reason", 120],
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

/** `Python.EXE` becomes `python`: how a hook's program name and a process name are compared. */
export const programStem = (name: string): string =>
  name.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");

/**
 * Links a Bash/Monitor reason to the processes it started. The hook cannot know the PID, and the
 * agent's other children (hook shells, MCP servers, job wrappers) start at the same moment, so the
 * hook also sends the program names in the command. The daemon keeps each reason with those names
 * per session (10 s). Of the processes one poll finds, the deepest one carrying a program of the
 * call takes the reason, once; every process below it inherits it. Limit: a command whose
 * programs are not the processes that run is not linked.
 *
 * Monitor: msys bash forks `sleep`, `tail` and the like from a parent that is already gone, so
 * those never show in the child tree. A Monitor note (`wrapper`) that no program claims takes its
 * shell wrapper instead: the top-level bash/sh seen after the note that is still alive 3 s
 * later (hook shells are gone by then). The wrapper lives as long as the Monitor does.
 */
export class ReasonLinker {
  private pending = new Map<
    string,
    { reason: string; programs: Set<string>; at: number; wrapper: boolean }[]
  >();
  private byPid = new Map<number, string>();
  private shells = new Map<number, { line: ActivityLine; at: number }>();
  /** Claimed wrappers. Their children do not inherit: the wrapper stays the row (the relay shows leaves). */
  private wrappers = new Set<number>();

  note(
    session: string,
    reason: string,
    programs: readonly string[],
    nowMs: number,
    wrapper = false,
  ): void {
    this.pending.set(session, [
      ...(this.pending.get(session) ?? []).filter(
        (x) => nowMs - x.at <= 10_000,
      ),
      {
        reason,
        programs: new Set(programs.map(programStem)),
        at: nowMs,
        wrapper,
      },
    ]);
  }

  /** `process_start` lines found by one poll, same order, `reason` set on the linked ones. */
  annotateBatch(lines: ActivityLine[], nowMs: number): ActivityLine[] {
    const byPid = new Map(lines.map((l) => [l.pid, l]));
    const depth = (l: ActivityLine): number => {
      let d = 0;
      for (let p = l; p.parent_pid && byPid.has(p.parent_pid) && d < 20; d++)
        p = byPid.get(p.parent_pid) as ActivityLine;
      return d;
    };
    const own = new Map<number, string>();
    for (const [s, notes] of this.pending) {
      const fresh = notes.filter((x) => nowMs - x.at <= 10_000);
      for (const n of [...fresh]) {
        const best = lines
          .filter(
            (l) =>
              l.session_id === s &&
              l.pid &&
              l.name &&
              !own.has(l.pid) &&
              !(l.parent_pid && this.byPid.has(l.parent_pid)) &&
              n.programs.has(programStem(l.name)),
          )
          .sort((x, y) => depth(y) - depth(x))[0];
        if (!best?.pid) continue;
        own.set(best.pid, n.reason);
        fresh.splice(fresh.indexOf(n), 1);
      }
      this.pending.set(s, fresh);
    }
    for (const l of lines) {
      if (
        l.pid &&
        l.session_id &&
        !own.has(l.pid) &&
        l.name &&
        /^(ba)?sh(\.exe)?$/i.test(l.name) &&
        !(
          l.parent_pid &&
          (byPid.has(l.parent_pid) || this.shells.has(l.parent_pid))
        ) &&
        (this.pending.get(l.session_id) ?? []).some((n) => n.wrapper)
      )
        this.shells.set(l.pid, { line: l, at: nowMs });
    }
    const reasonOf = (l: ActivityLine, d = 0): string | undefined =>
      (l.pid ? own.get(l.pid) : undefined) ??
      (l.parent_pid ? this.byPid.get(l.parent_pid) : undefined) ??
      (d < 20 && l.parent_pid && byPid.has(l.parent_pid)
        ? reasonOf(byPid.get(l.parent_pid) as ActivityLine, d + 1)
        : undefined);
    return lines.map((l) => {
      const reason = reasonOf(l);
      if (!reason) return l;
      if (l.pid) this.byPid.set(l.pid, reason);
      return { ...l, reason };
    });
  }

  /**
   * After a poll: Monitor notes no program claimed take the oldest shell wrapper that has stayed
   * alive for 3 s. Returns its `process_start` again, now with the reason.
   */
  confirm(alive: ReadonlySet<number>, nowMs: number): ActivityLine[] {
    const out: ActivityLine[] = [];
    for (const [pid, s] of this.shells)
      if (!alive.has(pid) || nowMs - s.at > 15_000) this.shells.delete(pid);
    for (const [session, notes] of this.pending) {
      for (const n of notes.filter((x) => x.wrapper)) {
        const w = [...this.shells.values()]
          .filter(
            (s) =>
              s.line.session_id === session &&
              nowMs - s.at >= 3000 &&
              s.at >= n.at - 3000 &&
              !this.wrappers.has(s.line.pid as number),
          )
          .sort((a, b) => a.at - b.at)[0];
        if (!w?.line.pid) continue;
        this.wrappers.add(w.line.pid);
        this.shells.delete(w.line.pid);
        this.pending.set(
          session,
          (this.pending.get(session) ?? []).filter((x) => x !== n),
        );
        out.push({ ...w.line, reason: n.reason });
      }
    }
    return out;
  }

  exit(pid: number | undefined): void {
    if (pid) {
      this.byPid.delete(pid);
      this.shells.delete(pid);
      this.wrappers.delete(pid);
    }
  }
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
        resolve(parseProcLines(stdout));
      },
    );
  });
}

function parseProcLines(stdout: string): ProcInfo[] {
  return stdout.split(/\r?\n/).flatMap((l) => {
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
  });
}

// Toolhelp snapshot: pid, ppid, exe name in ~15 ms. Get-CimInstance Win32_Process costs ~1 s and heavy WmiPrvSE CPU per call.
const WIN_LISTER_SCRIPT = `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Text;
public static class P{
[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct E{public uint dwSize,cntUsage,th32ProcessID;public IntPtr th32DefaultHeapID;public uint th32ModuleID,cntThreads,th32ParentProcessID;public int pcPriClassBase;public uint dwFlags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string szExeFile;}
[DllImport("kernel32.dll")]static extern IntPtr CreateToolhelp32Snapshot(uint f,uint p);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32FirstW(IntPtr h,ref E e);
[DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32NextW(IntPtr h,ref E e);
[DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
public static string L(){var sb=new StringBuilder();var h=CreateToolhelp32Snapshot(2,0);var e=new E();e.dwSize=(uint)Marshal.SizeOf(typeof(E));
if(Process32FirstW(h,ref e)){do{sb.Append(e.th32ProcessID).Append(' ').Append(e.th32ParentProcessID).Append(' ').Append(e.szExeFile).Append('\\n');}while(Process32NextW(h,ref e));}
CloseHandle(h);return sb.ToString();}}
'@
[Console]::Out.WriteLine('--');[Console]::Out.Flush()
while($null -ne [Console]::In.ReadLine()){[Console]::Out.Write([P]::L());[Console]::Out.WriteLine('--');[Console]::Out.Flush()}
`;

/**
 * One long-lived PowerShell that answers each request line on stdin with the process list and a
 * "--" line. After a crash or timeout the next call starts a fresh one. Windows only.
 */
export class WinProcLister {
  private child: ChildProcess | null = null;
  private buf = "";
  private wake: (() => void) | null = null;
  private ready: Promise<boolean> | null = null;

  private start(): Promise<boolean> {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WIN_LISTER_SCRIPT, "utf16le").toString("base64"),
      ],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    this.child = child;
    this.buf = "";
    child.unref();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (t: string) => {
      this.buf += t;
      this.wake?.();
    });
    child.stdin?.on("error", () => {});
    const gone = () => {
      if (this.child === child) this.child = null;
      this.wake?.();
    };
    child.on("exit", gone);
    child.on("error", gone);
    // The first "--" means Add-Type finished. Compiling can be slow under load: 20 s, not 5.
    return this.reply(20_000).then((r) => r !== null);
  }

  /** Text before the next "--" line, or null on timeout or exit (a timed-out child is killed). */
  private reply(ms: number): Promise<string | null> {
    const child = this.child;
    return new Promise((resolve) => {
      const finish = (v: string | null) => {
        clearTimeout(timer);
        this.wake = null;
        resolve(v);
      };
      const check = () => {
        const m = /(^|\n)--\r?\n/.exec(this.buf);
        if (m) {
          const text = this.buf.slice(0, m.index + m[1]!.length);
          this.buf = this.buf.slice(m.index + m[0].length);
          return finish(text);
        }
        if (this.child !== child) finish(null);
      };
      const timer = setTimeout(() => {
        finish(null);
        this.close();
      }, ms);
      this.wake = check;
      check();
    });
  }

  async list(): Promise<ProcInfo[]> {
    if (!this.child) this.ready = this.start();
    if (!(await this.ready)) return [];
    this.child?.stdin?.write("\n");
    const text = await this.reply(5000);
    return text === null ? [] : parseProcLines(text);
  }

  close(): void {
    const c = this.child;
    this.child = null;
    this.ready = null;
    c?.kill();
  }
}

const HOST_PROCESS: Record<string, RegExp> = {
  claude_code: /^claude(\.exe)?$/i,
  codex: /^codex(\.exe)?$/i,
};

/**
 * The hook's parent is a short-lived shell (sh, bash, cmd), so polling its children sees nothing.
 * Walk up to the first ancestor named like the host (claude, codex); keep `pid` when none matches.
 */
export function findAgentRoot(
  all: readonly ProcInfo[],
  pid: number,
  host: string | undefined,
): number {
  const re = host ? HOST_PROCESS[host] : undefined;
  let p = pid;
  for (let i = 0; re && i < 10; i++) {
    const x = all.find((q) => q.pid === p);
    if (!x) break;
    if (re.test(x.name)) return x.pid;
    p = x.ppid;
  }
  return pid;
}

export interface PollerOptions {
  emit: (line: ActivityLine) => void;
  /** Sees every `process_start` of one poll together, before they are emitted. */
  annotate?: (starts: ActivityLine[]) => ActivityLine[];
  /** Sees the live PIDs after each poll; may return more lines to emit. */
  confirm?: (alive: ReadonlySet<number>) => ActivityLine[];
  list?: () => Promise<ProcInfo[]>;
  intervalMs?: number;
  now?: () => Date;
}

export class ProcessPoller {
  private roots = new Map<number, string | undefined>();
  private seen = new Map<number, { info: ProcInfo; session?: string }>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private winLister: WinProcLister | null = null;
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
    // Nothing tracked and nothing left to report as exited: no listing, no timer, no child.
    if (this.roots.size === 0 && this.seen.size === 0) return this.stop();
    this.busy = true;
    try {
      const all = await this.list();
      // A failed listing (timeout under load) is empty: skip the tick, or every tracked agent is dropped.
      if (all.length === 0) return;
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
      const starts: ActivityLine[] = [];
      for (const [pid, v] of current) {
        if (this.seen.has(pid)) continue;
        starts.push({
          kind: "process_start",
          source: "proc",
          ts: now.toISOString(),
          session_id: v.session,
          pid,
          parent_pid: v.info.ppid,
          name: v.info.name,
        });
      }
      for (const l of this.o.annotate ? this.o.annotate(starts) : starts)
        this.o.emit(l);
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
      for (const l of this.o.confirm?.(alive) ?? []) this.o.emit(l);
      this.seen = current;
      if (this.roots.size === 0 && this.seen.size === 0) this.stop();
    } finally {
      this.busy = false;
    }
  }

  private list(): Promise<ProcInfo[]> {
    if (this.o.list) return this.o.list();
    if (process.platform !== "win32") return listProcesses();
    this.winLister ??= new WinProcLister();
    return this.winLister.list();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.winLister?.close();
    this.winLister = null;
  }
}
