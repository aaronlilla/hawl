import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  ensureDir,
  fsyncDir,
  TMP_PREFIX,
  writeFileDurable,
} from "../daemon/fsutil.ts";
import { detectSea } from "../install/self-install.ts";
import { typeIntoConsole, WIN_CONSOLE } from "./handover-console.ts";
import {
  configDir,
  folderKey,
  noteTurn,
  readTurn,
  TURN_EVENTS,
  TURN_WAIT_MS,
} from "./handover-turn.ts";

export { folderKey, noteTurn, readTurn, TURN_EVENTS, TURN_WAIT_MS };

/**
 * Automatic /clear after a stored handover (SPEC H24-H29). The agent runs `hawl handover clear`
 * from its own terminal as its last step; a detached child waits, then runs the owner's
 * configured argv steps. The only text ever typed is the constant `/clear` (or the test marker):
 * no handover, relay or peer text reaches this module. The steps run without a shell. The
 * target is whatever terminal THIS process's environment names, so no other pane is reachable.
 * Config lives in the machine's Hawl state dir, never in the folder, so a repo cannot ship one.
 *
 * Rules (each is checked over every ordering of events by the model test in handover-clear.test.ts):
 * I1 The config carries a `version` that every explicit owner change raises: config --on, --off or
 *    --template when it changes something or cancels a running test, and every test start.
 * I2 A running test records the version it started at. Its marker may store a pass, and turn
 *    auto-clear back on, only while the config is still at that version. Any explicit --on, --off,
 *    template change or a newer test cancels it (recorded as `cancelled`); its late marker changes nothing.
 * I3 An explicit --off always wins: nothing turns auto-clear on again except an explicit --on, and
 *    that --on still needs a fresh passing test.
 * I4 `enabled_before` belongs to the test that recorded it and goes when that test ends or is cancelled.
 * I5 A pass is stored only when a test fully succeeds at its own version; it is bound to that
 *    version and the template hash, so any later explicit change makes it unusable.
 * I6 `clear` reads the config when it runs, and its detached child reads it again right before
 *    each step it types; both refuse when auto-clear is off, untested, or changed since `clear` ran.
 * I7 Every event above is atomic, by construction rather than by timing: the config is a numbered
 *    history, each change is computed from the newest slot N and stored as slot N+1 by a hard link
 *    (which never replaces a file), so exactly one writer gets each slot and a writer that read an
 *    older slot always loses and recomputes from the newer one. Slots are never changed or deleted,
 *    so a lost slot can never be filled again later. There is no lock: a writer paused for any
 *    length of time, at any point, blocks nobody and can only lose. So the stored history is always
 *    one ordering of whole events, which is exactly what the model test checks for every ordering.
 *    shortcut: slots are kept forever (well under 1 KB per change or test); compact them under the
 *    daemon if a folder ever reaches thousands.
 */

export const CLEAR_TEXT = "/clear";
/** Plain text, no leading slash: Claude Code submits it as an ordinary prompt, so UserPromptSubmit always sees it. */
export const MARKER = /^hawl-handover-test-([0-9a-f]{16})$/;
/** Terminal variables a template may name as `${NAME}`. Read from the process that runs `clear`. */
export const ENV_ALLOW = [
  "TMUX",
  "TMUX_PANE",
  "WEZTERM_PANE",
  "KITTY_WINDOW_ID",
  "KITTY_LISTEN_ON",
  "ITERM_SESSION_ID",
  "TERM_PROGRAM",
  "WT_SESSION",
] as const;
/** Values a terminal sets for these (pane ids, socket paths, GUIDs). Quotes, spaces and controls are refused. */
const SAFE_ENV = /^[A-Za-z0-9_.:/@,=+%-]{1,256}$/;
const PH = /\$\{([^{}]*)\}|\{([^{}]*)\}/g;
export const DELAY_DEFAULT = 1500;
const TEST_WINDOW_MS = 15_000;

export type Template = string[][];
type Mode = "hook" | "marker-file";
export interface ClearConfig {
  root: string;
  enabled: boolean;
  template?: Template;
  /** I1: raised by every explicit owner change and every test start. Missing means 0. */
  version?: number;
  /** The last test that passed, bound to the template and the version it ran at. */
  pass?: {
    hash: string;
    env: string[];
    at: string;
    mode: Mode;
    version?: number;
  };
  /** A test that is running; past its deadline it counts as failed. */
  pending?: {
    nonce: string;
    hash: string;
    env: string[];
    mode: Mode;
    deadline: number;
    /** I2: the config version this test started at. */
    version?: number;
    /** I4: auto-clear was on when this test began; only this test's full pass turns it back on. */
    enabled_before?: boolean;
  };
  last_test?: string;
}

const refuse = (why: string) => new Error(`clear command refused: ${why}`);

/** Validate a template: 1-4 steps, each an argv array; only `{text}` and allowlisted `${NAME}`. */
export function parseTemplate(raw: unknown): Template {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4)
    throw refuse(
      'give 1 to 4 steps, each a list of strings (program, then its arguments), e.g. [["tmux","send-keys","-t","${TMUX_PANE}","{text}","Enter"]]',
    );
  let texts = 0;
  for (const step of raw) {
    // The built-in Windows console step: exactly ["hawl:windows-console","{text}"] (handover-console.ts).
    if (Array.isArray(step) && step[0] === WIN_CONSOLE) {
      if (step.length !== 2 || step[1] !== "{text}")
        throw refuse(
          `the ${WIN_CONSOLE} step is exactly ["${WIN_CONSOLE}","{text}"]`,
        );
      texts++;
      continue;
    }
    if (
      !Array.isArray(step) ||
      step.length < 1 ||
      step.length > 32 ||
      !step.every((a) => typeof a === "string")
    )
      throw refuse(
        "each step is a list of 1 to 32 strings (program, then its arguments); shell command lines are not supported",
      );
    step.forEach((arg: string, i) => {
      if (!arg || arg.length > 1000 || arg.includes("\0"))
        throw refuse("each argument is 1 to 1000 characters, with no NUL");
      if (i === 0 && /[{}$]/.test(arg))
        throw refuse(
          `the program "${arg}" must be a plain name or path, without placeholders`,
        );
      const rest = arg.replace(PH, (_m, env?: string, ph?: string) => {
        if (env !== undefined) {
          if (!(ENV_ALLOW as readonly string[]).includes(env))
            throw refuse(
              `\${${env}} is not an allowed terminal variable (allowed: ${ENV_ALLOW.join(", ")})`,
            );
          return "";
        }
        if (ph !== "text")
          throw refuse(
            `{${ph}} is not allowed: the only placeholders are {text} and \${NAME}`,
          );
        texts++;
        return "";
      });
      if (/[{}]/.test(rest) || /\$[A-Za-z_({]/.test(rest))
        throw refuse(
          `"${arg}" has a stray {, } or $: write terminal variables as \${NAME}`,
        );
    });
  }
  if (!texts) throw refuse("no {text} placeholder, so nothing would be typed");
  return raw as Template;
}

export function envNames(t: Template): string[] {
  const names = new Set<string>();
  for (const a of t.flat())
    for (const m of a.matchAll(PH)) if (m[1] !== undefined) names.add(m[1]);
  return [...names].sort();
}

export const templateHash = (t: Template) =>
  createHash("sha256").update(JSON.stringify(t)).digest("hex");

/** Why the env cannot fill this template, or undefined when it can. */
export function envProblem(
  t: Template,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const names = envNames(t);
  const missing = names.filter((n) => env[n] === undefined || env[n] === "");
  if (missing.length)
    return `the clear command needs ${missing.join(", ")}, which this process does not have: run it from the agent's own terminal`;
  const bad = names.filter((n) => !SAFE_ENV.test(env[n] as string));
  if (bad.length)
    return `${bad.join(", ")} holds characters Hawl does not pass on (quotes, spaces or control characters)`;
}

/** The argv steps to run. `text` is only ever `/clear` or a test marker; one pass, nothing re-expanded. */
export function render(
  t: Template,
  text: string,
  env: NodeJS.ProcessEnv,
): string[][] {
  if (text !== CLEAR_TEXT && !MARKER.test(text))
    throw new Error("only /clear or the test marker can be typed");
  const problem = envProblem(t, env);
  if (problem) throw new Error(problem);
  return t.map((step) =>
    step.map((a) =>
      a.replace(PH, (_m, e?: string) =>
        e !== undefined ? (env[e] as string) : text,
      ),
    ),
  );
}

export function parseDelay(raw: string | undefined): number {
  if (raw === undefined) return DELAY_DEFAULT;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 500 || n > 10_000)
    throw new Error("--delay-ms must be a whole number from 500 to 10000");
  return n;
}

const SLOT = /^(\d{12})\.json$/;
const slotName = (n: number) => `${String(n).padStart(12, "0")}.json`;

/** The newest slot and its text; seq 0 when nothing is stored yet. */
function readLatest(dir: string): { seq: number; raw?: string } {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { seq: 0 };
  }
  let seq = 0;
  for (const n of names) {
    const m = SLOT.exec(n);
    if (m) seq = Math.max(seq, Number(m[1]));
  }
  if (!seq) return { seq };
  // A slot is never changed or removed once made; a read that keeps failing counts as off.
  for (let i = 0; i < 5; i++)
    try {
      return { seq, raw: readFileSync(join(dir, slotName(seq)), "utf8") };
    } catch {
      nap(2);
    }
  return { seq };
}

/**
 * Store `data` as slot `seq`, all or nothing: the finished file is hard-linked into place, and a
 * link never replaces a file, so of all writers that read slot seq-1 exactly one gets slot seq.
 * False when another writer took it first.
 */
function commitSlot(dir: string, seq: number, data: string): boolean {
  ensureDir(dir);
  const tmp = join(dir, `${TMP_PREFIX}${randomBytes(6).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, join(dir, slotName(seq)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
  fsyncDir(dir);
  return true;
}

/** Writes a config as is, with no check. Tests use it to set up a state; the CLI writes only through updateConfig. */
export function saveConfig(stateDir: string, cfg: ClearConfig): void {
  const dir = configDir(stateDir, cfg.root);
  while (!commitSlot(dir, readLatest(dir).seq + 1, JSON.stringify(cfg)));
}

const ver = (cfg: ClearConfig) => cfg.version ?? 0;

/**
 * Tests only: `gap` runs right after updateConfig reads the newest slot, `commit` right before it
 * links the next one, so a test can pause a writer at either point for as long as it likes.
 */
export const testHooks: { gap?: () => void; commit?: () => void } = {};

function parseConfig(raw: string | undefined, root: string): ClearConfig {
  try {
    const o = JSON.parse(raw ?? "");
    const cfg: ClearConfig = { ...o, root, enabled: o.enabled === true };
    if (cfg.template !== undefined) parseTemplate(cfg.template);
    return cfg;
  } catch {
    return { root, enabled: false };
  }
}

const nap = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const TRIES = 50;

/**
 * The only way the CLI changes a folder's auto-clear config (I7). Read the newest slot N, apply a
 * past-deadline test's failure, run `mutate` (undefined = no change), and store the result as slot
 * N+1. If another writer took N+1 first, read again and re-run `mutate` on the newer config, so a
 * stale writer's change is recomputed or becomes a no-op. There is no lock, so a writer paused for
 * any length of time blocks nobody and, when it wakes, can only lose the slot. After TRIES lost
 * rounds it fails closed: auto-clear is turned off (also as a next slot) and the error says why.
 */
export function updateConfig(
  stateDir: string,
  root: string,
  mutate: (cfg: ClearConfig) => ClearConfig | undefined,
  now = Date.now(),
): { before: ClearConfig; after: ClearConfig; changed: boolean } {
  const dir = configDir(stateDir, root);
  for (let i = 0; i < TRIES; i++) {
    const { seq, raw } = readLatest(dir);
    testHooks.gap?.();
    const read = parseConfig(raw, root);
    const before = expire(read, now);
    const next = mutate(before);
    const after = next ?? before;
    if (after === read) return { before, after, changed: false };
    testHooks.commit?.();
    if (commitSlot(dir, seq + 1, JSON.stringify(after)))
      return { before, after, changed: next !== undefined };
    nap(Math.floor(Math.random() * 4 * (i + 1)));
  }
  // Fail closed: whatever was asked, auto-clear ends up off with no pass, at a new version.
  const why = "other changes kept landing first";
  for (let i = 0; i < TRIES; i++) {
    const { seq, raw } = readLatest(dir);
    const cur = parseConfig(raw, root);
    const off = {
      ...failed(cur, `the settings could not be saved (${why})`),
      version: ver(cur) + 1,
    };
    if (commitSlot(dir, seq + 1, JSON.stringify(off))) break;
  }
  throw new Error(
    `the auto-clear settings could not be saved (${why}). Auto-clear is off`,
  );
}

/** Every stored config of this folder, oldest first, with its slot number (tests check the history). */
export function configHistory(
  stateDir: string,
  root: string,
): { seq: number; cfg: ClearConfig }[] {
  const dir = configDir(stateDir, root);
  return readdirSync(dir)
    .map((n) => Number(SLOT.exec(n)?.[1] ?? 0))
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
    .map((seq) => ({
      seq,
      cfg: parseConfig(readFileSync(join(dir, slotName(seq)), "utf8"), root),
    }));
}

/** This folder's config (default: off, no command). A test past its deadline is recorded as failed. */
export const loadConfig = (
  stateDir: string,
  root: string,
  now = Date.now(),
): ClearConfig => updateConfig(stateDir, root, () => undefined, now).after;

/** A running test past its deadline has failed. */
export const expire = (cfg: ClearConfig, now: number): ClearConfig =>
  cfg.pending && !(now <= cfg.pending.deadline)
    ? failed(cfg, "the test marker did not arrive in time")
    : cfg;

/** A failed or interrupted test: no pass, no pending test, auto-clear off. */
export function failed(cfg: ClearConfig, why: string): ClearConfig {
  return {
    root: cfg.root,
    enabled: false,
    ...(cfg.template && { template: cfg.template }),
    version: ver(cfg),
    last_test: `failed: ${why}`,
  };
}

/** `config --on/--off/--template`: the config to save, or undefined when nothing changes. */
export function configure(
  cfg: ClearConfig,
  c: { on?: boolean; off?: boolean; template?: Template },
): ClearConfig | undefined {
  const next: ClearConfig = { ...cfg };
  if (c.template !== undefined) next.template = c.template;
  if (c.on) next.enabled = true;
  if (c.off) next.enabled = false;
  const changed =
    next.enabled !== cfg.enabled ||
    JSON.stringify(next.template) !== JSON.stringify(cfg.template);
  // I2: an explicit switch or template cancels a running test, even when it changes nothing else.
  if (!changed && !cfg.pending) return;
  // Any change to the command or the switch needs a fresh test.
  delete next.pass;
  delete next.pending;
  next.last_test = cfg.pending
    ? "cancelled: the auto-clear settings changed during the test"
    : undefined;
  next.version = ver(cfg) + 1;
  return next;
}

/** A test starts: the old pass goes and auto-clear is off until this test fully passes. */
export function beginTest(
  cfg: ClearConfig,
  mode: Mode,
  nonce: string,
  deadline: number,
): ClearConfig {
  const t = cfg.template;
  const version = ver(cfg) + 1;
  return {
    root: cfg.root,
    enabled: false,
    ...(t && { template: t }),
    version,
    pending: {
      nonce,
      hash: t ? templateHash(t) : "",
      env: t ? envNames(t) : [],
      mode,
      deadline,
      version,
      // I4: during a running test auto-clear is already off, so a second test never inherits the first one's.
      enabled_before: cfg.enabled,
    },
  };
}

/**
 * The marker of test `nonce` arrived: the config to save, or undefined when it is not the running
 * test's marker (cancelled, replaced, expired or another mode), which changes nothing.
 */
export function finishTest(
  cfg: ClearConfig,
  nonce: string,
  mode: Mode,
  now: Date,
): ClearConfig | undefined {
  const p = cfg.pending;
  if (!p || p.nonce !== nonce || p.mode !== mode || p.version !== ver(cfg))
    return;
  if (!cfg.template || templateHash(cfg.template) !== p.hash)
    return failed(cfg, "the clear command changed during the test");
  const t = cfg.template;
  return {
    root: cfg.root,
    enabled: p.enabled_before === true,
    template: t,
    version: ver(cfg),
    pass: {
      hash: templateHash(t),
      env: envNames(t),
      at: now.toISOString(),
      mode,
      version: ver(cfg),
    },
    last_test: "passed",
  };
}

/** True when a test passed for the template configured now, with no explicit change since (I5). */
export const tested = (cfg: ClearConfig) =>
  !!cfg.template &&
  cfg.pass?.hash === templateHash(cfg.template) &&
  (cfg.pass.version ?? 0) === ver(cfg);

/** Why `clear` must not type, or undefined when it may. */
export function clearRefusal(cfg: ClearConfig): string | undefined {
  if (!cfg.enabled)
    return "auto-clear is off for this folder (hawl handover config --on). Type /clear yourself";
  if (!cfg.template)
    return "no clear command is configured (hawl handover setup). Type /clear yourself";
  if (!tested(cfg))
    return "the clear command has not passed hawl handover test since it last changed. Type /clear yourself";
}

/** Why the clear child, right before typing, must not type: `version` is the config version `clear` saw. */
export function typeRefusal(
  cfg: ClearConfig,
  version: number,
): string | undefined {
  return (
    clearRefusal(cfg) ??
    (ver(cfg) !== version
      ? "the auto-clear settings changed after clear ran"
      : undefined)
  );
}

const ackDir = (stateDir: string) => join(stateDir, "handover-acks");
export const clearedFile = (stateDir: string, rid: string) =>
  join(ackDir(stateDir), `${rid}.cleared`);

/** Claim revision R for one clear. False when it was already claimed (cleared or clearing). */
export function claimRevision(
  stateDir: string,
  rid: string,
  revision: number,
): boolean {
  mkdirSync(ackDir(stateDir), { recursive: true, mode: 0o700 });
  try {
    closeSync(
      openSync(join(ackDir(stateDir), `${rid}.clear-${revision}`), "wx", 0o600),
    );
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

export function lastCleared(stateDir: string, rid: string): string | null {
  try {
    return readFileSync(clearedFile(stateDir, rid), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** What the detached child gets: fully rendered argv steps, the wait, and where to say it finished. */
export interface TyperPayload {
  steps: string[][];
  delay_ms: number;
  /** H25: type only once `session`'s turn `armed` in `root` stopped after `since`; wait at most `wait_ms`. */
  turn?: {
    state_dir: string;
    root: string;
    session: string;
    armed: number;
    since: number;
    wait_ms: number;
  };
  done?: { file: string; revision: number };
  /** I6: re-read this folder's config right before typing /clear; `version` is the one `clear` saw. */
  guard?: { state_dir: string; root: string; version: number };
}

export function parsePayload(raw: string | undefined): TyperPayload {
  const p = JSON.parse(raw ?? "") as TyperPayload;
  if (
    !Array.isArray(p.steps) ||
    !p.steps.every(
      (s) =>
        Array.isArray(s) &&
        s.length > 0 &&
        s.every((a) => typeof a === "string"),
    ) ||
    !Number.isInteger(p.delay_ms) ||
    p.delay_ms < 500 ||
    p.delay_ms > 10_000 ||
    (p.guard !== undefined &&
      (typeof p.guard.state_dir !== "string" ||
        typeof p.guard.root !== "string" ||
        !Number.isInteger(p.guard.version))) ||
    (p.turn !== undefined &&
      (typeof p.turn.state_dir !== "string" ||
        typeof p.turn.root !== "string" ||
        typeof p.turn.session !== "string" ||
        !p.turn.session ||
        !Number.isInteger(p.turn.armed) ||
        !Number.isFinite(p.turn.since) ||
        !Number.isInteger(p.turn.wait_ms) ||
        p.turn.wait_ms < 0 ||
        p.turn.wait_ms > TURN_WAIT_MS))
  )
    throw new Error("bad clear payload");
  return p;
}

/**
 * The detached child: wait for Claude Code's turn to end (H25), wait the delay, check the config
 * again, run each step (no shell), then write one line `cleared R`.
 */
export async function runTyper(p: TyperPayload): Promise<void> {
  const skip = (why: string) => {
    process.stdout.write(`skipped: ${why}\n`);
    if (p.done)
      writeFileDurable(p.done.file, `skipped ${p.done.revision}: ${why}\n`);
  };
  const t = p.turn;
  const NEW_TURN =
    "a new turn started after the clear was armed: nothing typed";
  if (t) {
    const end = Date.now() + t.wait_ms;
    for (;;) {
      const cur = readTurn(t.state_dir, t.root, t.session);
      if ((cur?.turn ?? 0) !== t.armed) return skip(NEW_TURN);
      if (cur?.stopped === t.armed && cur.stop_at > t.since) break;
      if (Date.now() >= end)
        return skip(
          `Claude Code's turn did not end within ${t.wait_ms / 1000} s: nothing typed`,
        );
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await new Promise((r) => setTimeout(r, p.delay_ms));
  const g = p.guard;
  const dir = g && configDir(g.state_dir, g.root);
  // I6: read, decide, then look again: any slot stored while deciding refuses. Run right before
  // every step, and in a console step after its screen check and again between the text and the
  // Enter. H25: the turn is the LAST read, after the config, so a turn started while the config was
  // read cancels (judge j9). The one window left open is the few ms between that last read and the
  // keystroke reaching the agent (one spawn or one WriteConsoleInputW): no check can close it.
  const refusal = () => {
    if (g && dir) {
      const seen = readLatest(dir).seq;
      const why = typeRefusal(loadConfig(g.state_dir, g.root), g.version);
      if (why) return why;
      if (readLatest(dir).seq !== seen)
        return "the auto-clear settings changed while clear was checking them";
    }
    if (t) {
      const cur = readTurn(t.state_dir, t.root, t.session);
      if (cur?.turn !== t.armed || cur.stopped !== t.armed) return NEW_TURN;
    }
  };
  let line = p.done ? `cleared ${p.done.revision}` : "";
  for (const [i, step] of p.steps.entries()) {
    const [cmd, ...args] = step;
    // Before every step, not just the first: an --off during step 1 stops the Enter in step 2.
    const why = refusal();
    if (why) return skip(why);
    if (cmd === WIN_CONSOLE) {
      const r = await typeIntoConsole(step, refusal);
      if (typeof r === "string") return skip(r);
      if (r === 0) continue;
      line = `failed ${p.done?.revision ?? ""} step ${i + 1}`;
      break;
    }
    const r = spawnSync(cmd as string, args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      timeout: 10_000,
    });
    if (r.error || r.status !== 0) {
      line = `failed ${p.done?.revision ?? ""} step ${i + 1}`;
      break;
    }
  }
  if (p.done) writeFileDurable(p.done.file, `${line}\n`);
}

/** How to start the child: this same CLI (`node <main.js>` or the single-file binary), never a shell. */
export function typerLaunch(
  p: TyperPayload,
  o: { sea?: boolean; script?: string; execPath?: string } = {},
): { command: string; args: string[] } {
  const tail = ["handover", "_type", JSON.stringify(p)];
  const execPath = o.execPath ?? process.execPath;
  if (o.sea ?? detectSea()) return { command: execPath, args: tail };
  const script = "script" in o ? o.script : process.argv[1];
  if (script && /\.(?:[cm]?js|ts)$/.test(script))
    return { command: execPath, args: [...process.execArgv, script, ...tail] };
  throw new Error("cannot start the clear step from this install of hawl");
}

/** Where the detached child's output and exit go (one log per machine, restarted past 64 KB). */
export const typerLog = (stateDir: string) =>
  join(stateDir, "handover-typer.log");

/**
 * Start ONE detached child and return at once, so the agent's turn can end. Its stdout and stderr
 * go to typerLog, plus a start line (the command without the payload) and, from handover.ts, its
 * exit code, so a run that typed nothing says why.
 */
export function launchTyper(
  p: TyperPayload,
  stateDir?: string,
  o: Parameters<typeof typerLaunch>[1] = {},
): void {
  const l = typerLaunch(p, o);
  let fd: number | "ignore" = "ignore";
  const log = stateDir && typerLog(stateDir);
  if (log)
    try {
      ensureDir(stateDir);
      let big = false;
      try {
        big = statSync(log).size > 64 * 1024;
      } catch {
        // no log yet
      }
      fd = openSync(log, big ? "w" : "a", 0o600);
      writeSync(
        fd,
        `${new Date().toISOString()} started ${[l.command, ...l.args.slice(0, -1)].join(" ")}\n`,
      );
    } catch {
      fd = "ignore"; // the log is a help, never a reason not to clear
    }
  const child = spawn(l.command, l.args, {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    shell: false,
    env: log ? { ...process.env, HAWL_TYPER_LOG: log } : process.env,
  });
  child.on("error", () => {});
  child.unref();
  if (typeof fd === "number") closeSync(fd);
}

export function newNonce(): string {
  return createHash("sha256")
    .update(`${Math.random()}${process.hrtime.bigint()}`)
    .digest("hex")
    .slice(0, 16);
}

/** A test may wait up to TURN_WAIT_MS for the turn to end (H25), then the delay, then its window. */
export const testDeadline = (delay: number, now = Date.now()) =>
  now + TURN_WAIT_MS + delay + TEST_WINDOW_MS;

/**
 * UserPromptSubmit in Claude Code: a prompt that is exactly a test marker finishes that folder's
 * running test. Only the marker's shape is matched; no other prompt text is read or kept.
 * Returns the note for the agent, or undefined when the prompt is not a marker.
 */
const AFTER =
  "This prompt was only the test marker, not a task: reply in one short line (the result, or just ok), then carry on.";

export function hookMarker(
  stateDir: string,
  root: string,
  prompt: string,
  now = Date.now(),
): string | undefined {
  const m = MARKER.exec(prompt.trim());
  if (!m) return;
  // finishTest runs inside the compare-and-swap: on a retry it sees the newer config, so a test
  // cancelled by --off, --on, a template change or a newer test meanwhile changes nothing (I2).
  const {
    before,
    after: out,
    changed,
  } = updateConfig(
    stateDir,
    root,
    (c) => finishTest(c, m[1] as string, "hook", new Date(now)),
    now,
  );
  if (!changed)
    return `Hawl handover test: this marker does not belong to a test running in this folder${/^(failed|cancelled)/.test(before.last_test ?? "") ? ` (${before.last_test})` : ""}. Nothing changed. ${AFTER}`;
  if (!out.pass)
    return `Hawl handover test FAILED: the clear command changed during the test. Auto-clear is off. ${AFTER}`;
  return `Hawl handover test PASSED: the marker reached this session, so \`hawl handover clear\` can type /clear here. Auto-clear is ${out.enabled ? "on" : "off (turn it on with hawl handover config --on, then test again)"}. ${AFTER}`;
}
