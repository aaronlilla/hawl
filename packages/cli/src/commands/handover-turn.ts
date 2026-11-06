import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/*
 * The per-folder key and Claude Code's turn record for `hawl handover clear`, kept apart from
 * handover-clear.ts so the hook that runs on every Stop, prompt and tool call loads only this.
 */

/** One folder's config history: numbered slots `000000000001.json`, `000000000002.json`, ... (I7). */
export const configDir = (stateDir: string, root: string) =>
  join(
    stateDir,
    "handover-clear",
    createHash("sha256").update(folderKey(root)).digest("hex").slice(0, 32),
  );

/**
 * One key per folder however its path is spelled, so an --off from any spelling reaches the config
 * every other spelling reads: the real path (8.3 short names, junctions, symlinks and `\\?\`
 * resolved), no trailing separator, and case folded on Windows and macOS, whose file systems
 * usually ignore case.
 */
export function folderKey(root: string): string {
  let p = resolve(root);
  for (const real of [realpathSync.native, realpathSync])
    try {
      p = real(p);
      break;
    } catch {
      // not resolvable this way: try the next, else keep the resolved path
    }
  p = p.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  p = p.replace(/(?<=.)[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? p.toLowerCase()
    : p;
}
/**
 * H25: one Claude Code session's turns in this folder, as its hooks report them. Keyed by the hook
 * payload's session_id, which the Bash tool also exports as CLAUDE_CODE_SESSION_ID, so another
 * session never counts. `turn` counts turn starts (every UserPromptSubmit and PreToolUse, and a Stop
 * that Hawl's own Stop hook turns into a continue, `StopBlocked`); a Stop sets `stopped = turn`.
 * The clear step arms on the `turn` it sees, types only once `stopped` equals it (with the Stop newer
 * than the `clear` or `test` process), and gives up as soon as `turn` moves on, so the keys never
 * land in a running turn or in a dialog that turn opened (a permission prompt would take the Enter).
 */
export const TURN_EVENTS = new Set(["Stop", "UserPromptSubmit", "PreToolUse"]);
/** How long the clear step waits for the turn to end before it gives up and types nothing. */
export const TURN_WAIT_MS = 120_000;
// Append-only, one line per event, so overlapping hooks never erase each other (judge j3): a start
// is `s`, a Stop is `e <starts it saw> <ms>`. A start appended while a Stop was reading leaves the
// count above that Stop's, so the clear step sees a newer turn. Grows ~2 bytes per tool call.
const turnFile = (stateDir: string, root: string, session: string) =>
  join(
    configDir(stateDir, root),
    `turn-${createHash("sha256").update(session).digest("hex").slice(0, 32)}.log`,
  );

export function noteTurn(
  stateDir: string,
  root: string,
  session: string,
  event: string,
  now = Date.now(),
  /** A Stop: the start count read when it fired, before the hook's slow work (judge j7). */
  seen?: number,
): void {
  const file = turnFile(stateDir, root, session);
  const line =
    event === "Stop"
      ? `e ${seen ?? readTurn(stateDir, root, session)?.turn ?? 0} ${now}\n`
      : "s\n";
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, "a", 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface Turn {
  turn: number;
  stopped: number;
  stop_at: number;
}

export function readTurn(
  stateDir: string,
  root: string,
  session: string,
): Turn | undefined {
  let raw: string;
  try {
    raw = readFileSync(turnFile(stateDir, root, session), "utf8");
  } catch {
    return undefined;
  }
  const t: Turn = { turn: 0, stopped: -1, stop_at: 0 };
  for (const l of raw.split("\n")) {
    if (l === "s") t.turn++;
    const m = /^e (\d+) (\d+)$/.exec(l);
    // The Stop of the latest turn wins; a torn or unknown line counts for nothing.
    if (m && Number(m[1]) >= t.stopped) {
      t.stopped = Number(m[1]);
      t.stop_at = Number(m[2]);
    }
  }
  return t;
}
