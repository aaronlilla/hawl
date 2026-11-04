import {
  appendFileSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type Logger, pino } from "pino";

const SECRET_KEYS = [
  "token",
  "key",
  "api_key",
  "secret",
  "authorization",
  "cookie",
  "password",
  "passphrase",
  "private_key",
  "signing_key",
];

/** Same idea as the relay's REDACT_PATHS: ids and timings only, never secrets. Pino wildcards go one level at a time, so three levels are listed. */
export const REDACT_PATHS = SECRET_KEYS.flatMap((k) => [
  k,
  `*.${k}`,
  `*.*.${k}`,
]);

const KEY =
  "\\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passphrase|authorization|user[_-]?code)";
/** `key`, an optional closing quote (`\"` when the line is JSON), then `=` or `:`. */
const KEY_SEP = `${KEY}\\\\?["']?\\s*[=:]\\s*`;
const QUOTED_PAIR = new RegExp(
  `(${KEY_SEP})(\\\\?["'])(?!\\[redacted)((?:(?!\\\\?["']).)+)`,
  "gi",
);
const PLAIN_PAIR = new RegExp(
  `(${KEY_SEP})(?!\\\\?["'])(?!\\[redacted)[^\\s"'\\\\,;&}]{4,}`,
  "gi",
);

/**
 * Secrets that sit inside a plain message string, where the keyed REDACT_PATHS cannot see them:
 * bearer values, JWTs (agent and user tokens), `token=...` pairs (quoted values whole, spaces
 * included), `token <value>`, invite links, and long hex or base64 strings. Ids such as
 * `res_<uuid>` and the trace id stay readable. Run over each finished log line and over the support bundle.
 */
export function scrubText(s: string): string {
  return (
    s
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
      .replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, "[redacted-jwt]")
      .replace(QUOTED_PAIR, "$1$2[redacted]")
      .replace(PLAIN_PAIR, "$1[redacted]")
      // `token abc123...` with no separator: needs a digit so "token refresh failed" stays readable
      .replace(
        /\b(token|secret|password|passphrase|api[_-]?key)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,}/gi,
        "$1 [redacted]",
      )
      // /i/<43 char token or uuid>, /v1/invites/<token>, and the same URL-encoded inside ?next=
      .replace(
        /((?:\/|%2F)(?:i|invites?|join)(?:\/|%2F))[A-Za-z0-9_-]{16,}/gi,
        "$1[redacted-invite]",
      )
      .replace(/\bhawl_[A-Za-z0-9_-]{20,}/g, "[redacted-token]")
      // 32+ hex that is not a trace id (trace_id is 32 hex and the logs need it)
      .replace(
        /(?<![0-9A-Za-z])(?<!(?:trace[_-]?id|sentry-trace)\\?["']?\s*[:=]\s*\\?["']?)[0-9a-f]{32,}(?![0-9A-Za-z])/g,
        "[redacted-hex]",
      )
      // 32+ base64/base64url with capitals, lowercase and a digit; ids are lowercase uuids, so they stay
      .replace(
        /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g,
        (m) =>
          /[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m)
            ? "[redacted-secret]"
            : m,
      )
  );
}

export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_FILES = 3;

/** Append-only log file that rolls `f` to `f.1` to `f.2` when it would pass `maxBytes`. */
export class RotatingFile {
  private size = 0;
  private readonly file: string;
  private readonly maxBytes: number;
  /** Files kept; verbose mode raises it so the 50 MB cap holds (see applyDebug). */
  files: number;
  constructor(file: string, maxBytes = LOG_MAX_BYTES, files = LOG_FILES) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.files = files;
    mkdirSync(dirname(file), { recursive: true });
    try {
      this.size = statSync(file).size;
    } catch {
      // first run: no file yet
    }
  }

  write(line: string): void {
    try {
      const n = Buffer.byteLength(line);
      if (this.size > 0 && this.size + n > this.maxBytes) this.rotate();
      appendFileSync(this.file, line);
      this.size += n;
    } catch {
      // Logging must never take the helper down (disk full, file locked).
    }
  }

  private rotate(): void {
    rmSync(`${this.file}.${this.files - 1}`, { force: true });
    for (let i = this.files - 2; i >= 1; i--)
      this.move(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    this.move(this.file, `${this.file}.1`);
    this.size = 0;
  }

  private move(from: string, to: string): void {
    try {
      renameSync(from, to);
    } catch {
      // missing or locked (Windows): skip, the next write retries the roll
    }
  }
}

export function daemonLogPath(stateDir: string): string {
  return join(stateDir, "logs", "daemon.log");
}

export type DaemonLogger = Logger;

const files = new WeakMap<object, RotatingFile>();

export function createDaemonLogger(stateDir: string): DaemonLogger {
  const file = new RotatingFile(daemonLogPath(stateDir));
  const log = pino(
    {
      base: { svc: "daemon", pid: process.pid },
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    { write: (line: string) => file.write(scrubText(line)) },
  );
  files.set(log, file);
  return log;
}

/** `hawl debug on` writes this; the daemon reads it. Epoch ms the verbose mode ends. */
export const DEBUG_MS = 24 * 3_600_000;
export const VERBOSE_TOTAL_BYTES = 50 * 1024 * 1024;
export const VERBOSE_MAX_AGE_MS = 7 * 86_400_000;
const debugPath = (stateDir: string) => join(stateDir, "debug.json");

/** When verbose logging ends, or null when it is off. An expired file is removed here: that is the auto-off. */
export function debugUntil(stateDir: string, now = Date.now()): number | null {
  let until: unknown;
  try {
    until = (
      JSON.parse(readFileSync(debugPath(stateDir), "utf8")) as {
        until?: unknown;
      }
    ).until;
  } catch {
    return null;
  }
  if (typeof until === "number" && until > now) return until;
  rmSync(debugPath(stateDir), { force: true });
  return null;
}

/** Turn verbose logging on for 24 hours, or off. Returns when it ends. */
export function setDebug(
  stateDir: string,
  on: boolean,
  now = Date.now(),
): number | null {
  if (!on) {
    rmSync(debugPath(stateDir), { force: true });
    return null;
  }
  mkdirSync(stateDir, { recursive: true });
  const until = now + DEBUG_MS;
  writeFileSync(debugPath(stateDir), JSON.stringify({ until }));
  return until;
}

/** Match the logger to the switch: debug level and 10 files (50 MB) while on, info and 3 files off. */
export function applyDebug(
  log: DaemonLogger,
  stateDir: string,
  now = Date.now(),
): boolean {
  const on = debugUntil(stateDir, now) !== null;
  const level = on ? "debug" : "info";
  if (log.level !== level) log.level = level;
  const f = files.get(log);
  if (f)
    f.files = on ? Math.ceil(VERBOSE_TOTAL_BYTES / LOG_MAX_BYTES) : LOG_FILES;
  return on;
}

/** Drop lines older than 7 days from the active file (a quiet machine never rotates it). Lines without a time stay. */
function trimLive(file: string, now: number): void {
  const tmp = `${file}.trim`;
  try {
    // Move the file away first: a line appended from here on lands in a new live file, not in a rewrite that would drop it.
    renameSync(file, tmp);
  } catch {
    return; // no live file yet, or locked: the next sweep tries again
  }
  try {
    const lines = readFileSync(tmp, "utf8").split("\n");
    const since = now - VERBOSE_MAX_AGE_MS;
    const keep = lines.filter((l) => {
      try {
        const t = Date.parse((JSON.parse(l) as { time?: string }).time ?? "");
        return Number.isNaN(t) || t >= since;
      } catch {
        return true;
      }
    });
    if (keep.length < lines.length) writeFileSync(tmp, keep.join("\n"));
  } catch {
    // unreadable: put the old content back below untouched
  }
  try {
    // linkSync fails if a new live file exists already; then the kept lines go after its few new lines (order is the only cost).
    linkSync(tmp, file);
  } catch {
    appendFileSync(file, readFileSync(tmp));
  }
  rmSync(tmp, { force: true });
}

/** Delete log files older than 7 days, then the oldest until the total fits 50 MB. The live file stays, minus its lines older than 7 days. */
export function pruneLogs(stateDir: string, now = Date.now()): string[] {
  const dir = dirname(daemonLogPath(stateDir));
  const live = daemonLogPath(stateDir);
  const gone: string[] = [];
  trimLive(live, now);
  let all: { f: string; size: number; at: number }[] = [];
  try {
    all = readdirSync(dir)
      .filter((n) => /^daemon\.log(\.\d+)?$/.test(n))
      .map((n) => {
        const f = join(dir, n);
        const st = statSync(f);
        return { f, size: st.size, at: st.mtimeMs };
      });
  } catch {
    return gone;
  }
  const drop = (x: { f: string }) => {
    rmSync(x.f, { force: true });
    gone.push(x.f);
  };
  for (const x of all)
    if (x.f !== live && now - x.at > VERBOSE_MAX_AGE_MS) drop(x);
  all = all.filter((x) => !gone.includes(x.f));
  let total = all.reduce((n, x) => n + x.size, 0);
  for (const x of all.sort((a, b) => a.at - b.at)) {
    if (total <= VERBOSE_TOTAL_BYTES) break;
    if (x.f === live) continue;
    drop(x);
    total -= x.size;
  }
  return gone;
}

/**
 * `{ trace }` to put on a ws frame: the request's trace copied as is, so the relay joins it.
 * The helper has no Sentry SDK; it never makes a trace up here, only passes one through.
 */
export function traceFrameField(trace: unknown): {
  trace?: { "sentry-trace": string; baggage?: string };
} {
  if (!traceIdOf(trace)) return {};
  const t = trace as { "sentry-trace": string; baggage?: unknown };
  return typeof t.baggage === "string" && t.baggage.length <= 1024
    ? { trace: { "sentry-trace": t["sentry-trace"], baggage: t.baggage } }
    : { trace: { "sentry-trace": t["sentry-trace"] } };
}

/** The `sentry-trace` header for an HTTP call that continues the request's trace; empty when it has none. */
export function traceHeader(trace: unknown): Record<string, string> {
  const t = traceFrameField(trace).trace;
  return t ? { "sentry-trace": t["sentry-trace"] } : {};
}

/** Trace id from a frame or request `trace` field (`{ "sentry-trace": "<32 hex>-<16 hex>[-<0|1>]" }`). */
export function traceIdOf(trace: unknown): string | undefined {
  const v = (trace as { "sentry-trace"?: unknown } | null | undefined)?.[
    "sentry-trace"
  ];
  if (typeof v !== "string") return undefined;
  return /^([0-9a-f]{32})-[0-9a-f]{16}(?:-[01])?$/.exec(v)?.[1];
}
