import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { readAck } from "../daemon/handover.ts";
import { defaultStateDir } from "../daemon/main.ts";
import { readToken, request, socketPath } from "../daemon/socket.ts";
import { findJoinedRoot, resolveRoute } from "../resolve.ts";
import {
  beginTest,
  CLEAR_TEXT,
  type ClearConfig,
  claimRevision,
  clearedFile,
  clearRefusal,
  configure,
  DELAY_DEFAULT,
  envProblem,
  failed,
  finishTest,
  lastCleared,
  launchTyper,
  loadConfig,
  newNonce,
  parseDelay,
  parsePayload,
  parseTemplate,
  readTurn,
  render,
  runTyper,
  type Template,
  TURN_WAIT_MS,
  type TyperPayload,
  testDeadline,
  tested,
  updateConfig,
} from "./handover-clear.ts";
import { stdStyle } from "./team-cmds.ts";

/**
 * H25: the clear step waits for the Stop of this session's current turn in this folder, newer than
 * this process's start (not "now": a turn may end while a backgrounded `test` is still starting up).
 */
const turnAfter = (
  stateDir: string,
  root: string,
  session: string,
  armed: number,
) => ({
  state_dir: stateDir,
  root,
  session,
  armed,
  since: Math.floor(performance.timeOrigin),
  wait_ms: TURN_WAIT_MS,
});
const NO_SESSION =
  "CLAUDE_CODE_SESSION_ID is not set in this process, so Hawl cannot tell when this Claude Code session's turn ends: run it from Claude Code's own Bash tool. Nothing typed";

import { bindConsole } from "./handover-console.ts";
import { SETUP_PROMPT } from "./handover-setup.ts";

/**
 * `hawl handover write|status` (SPEC H20) and the opt-in automatic /clear:
 * `config|clear|test|setup` (SPEC H24-H29, the logic in handover-clear.ts).
 */
export interface HandoverIo {
  cwd: string;
  stateDir: string;
  print: (line: string) => void;
  /** One op to the helper. */
  call: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  readStdin?: () => Promise<string>;
  /** The environment of the process running the command (the agent's own terminal). */
  env?: NodeJS.ProcessEnv;
  /** Start the detached clear step. Default: one detached child of this CLI. */
  launch?: (p: TyperPayload) => void;
}

const USAGE =
  "usage: hawl handover write|status|config|test|clear|setup (hawl handover --help)";
const SUB_OPTIONS: Record<string, string[]> = {
  write: ["file", "text"],
  status: [],
  config: ["on", "off", "template", "template-file"],
  test: ["marker-file", "delay-ms"],
  clear: ["delay-ms", "command"],
  setup: [],
};

// The detached clear step (launchTyper sets HAWL_TYPER_LOG): its output already goes there; add how it ended.
if (process.env.HAWL_TYPER_LOG) {
  const log = process.env.HAWL_TYPER_LOG;
  process.on("exit", (code) => {
    try {
      appendFileSync(log, `${new Date().toISOString()} exited ${code}\n`);
    } catch {
      // nothing to report to
    }
  });
}

/** Run `hawl handover <sub>`. Returns the exit code; throws a plain message on a usage or state error. */
export async function handover(
  argv: string[],
  io: HandoverIo,
): Promise<number> {
  // The detached clear step (started by `clear` or `test`, never typed by a person).
  if (argv[0] === "_type" && argv.length === 2) {
    await runTyper(parsePayload(argv[1]));
    return 0;
  }
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" },
      text: { type: "string" },
      on: { type: "boolean" },
      off: { type: "boolean" },
      template: { type: "string" },
      "template-file": { type: "string" },
      "marker-file": { type: "string" },
      "delay-ms": { type: "string" },
      command: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
    tokens: true,
  });
  const [sub, ...words] = positionals;
  // A lone `-` means stdin, unless it came after `--` (then it is the text "-").
  const dashIsStdin =
    words.length === 1 &&
    words[0] === "-" &&
    !tokens.some((t) => t.kind === "option-terminator");
  const allowed = SUB_OPTIONS[sub ?? ""];
  if (!allowed || Object.keys(values).some((k) => !allowed.includes(k)))
    throw new Error(USAGE);
  if (sub !== "write" && words.length) throw new Error(USAGE);
  const say = io.print;
  if (sub === "setup") {
    say(SETUP_PROMPT);
    return 0;
  }
  const root = findJoinedRoot(io.cwd);
  if (!root)
    throw new Error("this folder is not joined to a Hawl site (run hawl join)");
  const folderRid = resolveRoute(io.cwd, { host: "claude_code" })?.resident_id;
  if (!folderRid)
    throw new Error("this folder has no Hawl agent (run hawl join)");
  const env = io.env ?? process.env;
  // H25: the turn this command runs in, read before anything slow (judge j7): a turn that ends and
  // a new one that starts during the lookups below must cancel the clear, not re-arm it on the new one.
  const armed = env.CLAUDE_CODE_SESSION_ID
    ? (readTurn(io.stateDir, root, env.CLAUDE_CODE_SESSION_ID)?.turn ?? 0)
    : 0;
  // Inside a terminal its own agent stores, reads and clears the handover (the one its next
  // session start shows); else the folder's worker. config and test never use it, and stay
  // synchronous up to their first write so an --off lands in one step (I2, I7).
  const term =
    env.CLAUDE_CODE_SESSION_ID && sub !== "config" && sub !== "test"
      ? ((await io
          .call("terminal_for", {
            resident_id: folderRid,
            host_session_id: env.CLAUDE_CODE_SESSION_ID,
            claude_pid: Number(env.CLAUDE_PID) || undefined,
          })
          .catch(() => null)) as { resident_id?: string } | null)
      : null;
  const rid = term?.resident_id ?? folderRid;
  const launch =
    io.launch ?? ((p: TyperPayload) => launchTyper(p, io.stateDir));

  if (sub === "config") {
    if (values.on && values.off)
      throw new Error("usage: --on or --off, not both");
    if (values.template !== undefined && values["template-file"] !== undefined)
      throw new Error("usage: --template or --template-file, not both");
    const raw =
      values.template ??
      (values["template-file"] !== undefined
        ? readFileSync(values["template-file"], "utf8")
        : undefined);
    let template: Template | undefined;
    if (raw !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(
          "clear command refused: the template is not JSON (a list of argv lists)",
        );
      }
      template = parseTemplate(parsed);
    }
    const {
      before,
      after: cfg,
      changed,
    } = updateConfig(io.stateDir, root, (c) =>
      configure(c, { on: values.on, off: values.off, template }),
    );
    say(`Auto-clear for ${root}: ${autoState(cfg)}`);
    if (before.pending && changed)
      say(
        "  The running test was cancelled: it can no longer change anything.",
      );
    say(
      `  clear command: ${cfg.template ? JSON.stringify(cfg.template) : "none"}`,
    );
    if (changed && cfg.template)
      say("  Run hawl handover test to prove it types into this terminal.");
    return 0;
  }

  if (sub === "test") {
    const markerFile = values["marker-file"];
    const mode = markerFile !== undefined ? "marker-file" : "hook";
    let delay = DELAY_DEFAULT;
    let delayError: unknown;
    try {
      delay = parseDelay(values["delay-ms"]);
    } catch (e) {
      delayError = e;
    }
    const nonce = newNonce();
    const marker = `hawl-handover-test-${nonce}`;
    // Revoke first, in one write: any error or interruption from here on leaves auto-clear off with no pass.
    const t = updateConfig(io.stateDir, root, (c) =>
      beginTest(c, mode, nonce, testDeadline(delay)),
    ).before.template;
    try {
      if (delayError) throw delayError;
      if (!t)
        throw new Error(
          "no clear command is configured (hawl handover config --template ...)",
        );
      if (mode === "hook" && env.CLAUDECODE !== "1")
        throw new Error(NOT_CLAUDE);
      const session = env.CLAUDE_CODE_SESSION_ID;
      if (!session) throw new Error(NO_SESSION);
      const steps = bindConsole(render(t, marker, env));
      if (markerFile !== undefined) freshMarkerFile(markerFile);
      launch({
        steps,
        delay_ms: delay,
        turn: turnAfter(io.stateDir, root, session, armed),
      });
    } catch (e) {
      const why = (e as Error).message;
      // Only this test fails; if a newer change already cancelled it, that change stands.
      updateConfig(io.stateDir, root, (c) =>
        c.pending?.nonce === nonce ? failed(c, why) : undefined,
      );
      throw new Error(`test failed: ${why}. Auto-clear is off.`);
    }
    if (mode === "hook") {
      say(
        `Test armed. End your turn now: ${delay / 1000} s after this turn ends, the plain-text marker ${marker} is typed into this terminal as your next prompt, an ordinary prompt. Hawl's hook checks it and tells you PASSED or FAILED; that turn, just reply ok (or nothing) and carry on. Nothing is cleared.`,
      );
      return 0;
    }
    for (;;) {
      // Past the deadline loadConfig records this test as failed; a config change or a newer test cancels it.
      const cur = loadConfig(io.stateDir, root);
      if (cur.pending?.nonce !== nonce)
        throw new Error(
          `test ${cur.last_test ?? "cancelled: a newer test started"}. Auto-clear: ${autoState(cur)}`,
        );
      let got = "";
      try {
        got = readFileSync(markerFile as string, "utf8");
      } catch {
        // not there yet
      }
      // finishTest runs inside the compare-and-swap, so a test cancelled meanwhile changes nothing (I2);
      // the next round then reports why.
      const r =
        got.includes(marker) &&
        updateConfig(io.stateDir, root, (c) =>
          finishTest(c, nonce, "marker-file", new Date()),
        );
      if (r && r.changed) {
        const out = r.after;
        if (!out.pass)
          throw new Error(`test ${out.last_test}. Auto-clear is off.`);
        say(
          `PASSED: the clear command wrote ${marker} to ${markerFile}. Auto-clear is ${out.enabled ? "on" : "off (hawl handover config --on, then test again)"}.`,
        );
        return 0;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  if (sub === "clear") {
    const delay = parseDelay(values["delay-ms"]);
    const command = values.command ?? CLEAR_TEXT;
    if (command !== CLEAR_TEXT)
      throw new Error("--command must be /clear: Hawl only ever types /clear");
    // Every precondition is checked before anything is claimed or started; each refusal types nothing.
    if (env.CLAUDECODE !== "1") throw new Error(NOT_CLAUDE);
    const session = env.CLAUDE_CODE_SESSION_ID;
    if (!session) throw new Error(NO_SESSION);
    const cfg = loadConfig(io.stateDir, root);
    const refusal = clearRefusal(cfg);
    if (refusal) throw new Error(refusal);
    const t = cfg.template as Template;
    const ack = readAck(io.stateDir, rid);
    if (!ack)
      throw new Error(
        "no stored handover on this machine: run hawl handover write first",
      );
    const problem = envProblem(t, env);
    if (problem) throw new Error(problem);
    const steps = bindConsole(render(t, command, env));
    if (!claimRevision(io.stateDir, rid, ack.revision))
      throw new Error(
        `handover revision ${ack.revision} was already cleared: nothing typed. Write a new handover first`,
      );
    launch({
      steps,
      delay_ms: delay,
      turn: turnAfter(io.stateDir, root, session, armed),
      done: { file: clearedFile(io.stateDir, rid), revision: ack.revision },
      guard: { state_dir: io.stateDir, root, version: cfg.version ?? 0 },
    });
    say(
      `Clearing ${delay / 1000} s after this turn ends (handover revision ${ack.revision}). End your turn now.`,
    );
    return 0;
  }

  if (sub === "write") {
    const fromWords = words.length > 0 && !dashIsStdin;
    const sources =
      Number(fromWords) +
      Number(values.file !== undefined) +
      Number(values.text !== undefined);
    if (sources > 1)
      throw new Error(
        "usage: give the text one way: words, --text, --file or - (not both)",
      );
    // The words exactly as the OS handed them over, joined by one space. Never parsed or run.
    const text = fromWords
      ? words.join(" ")
      : values.text !== undefined
        ? values.text
        : values.file !== undefined
          ? readFileSync(values.file, "utf8")
          : ((await io.readStdin?.()) ?? "");
    if (!text.trim())
      throw new Error(
        "usage: hawl handover write <words> | --text <text> | --file <path> | - (text on stdin)",
      );
    const r = (await io.call("tool", {
      resident_id: rid,
      name: "handover_put",
      args: { text },
    })) as {
      state?: string;
      handover_id?: unknown;
      revision?: unknown;
      scan?: { verdict?: string; reasons?: string[] };
    } | null;
    if (
      r?.state !== "stored" ||
      typeof r.handover_id !== "string" ||
      !Number.isInteger(r.revision)
    )
      throw new Error("the relay did not confirm that it stored the handover");
    const st = stdStyle();
    say(
      `${st.ok} Saved where ${basename(root)} got to ${st.dim(`(${r.handover_id} revision ${r.revision})`)}`,
    );
    say(`${st.ok} Wrote the next steps for the new session`);
    if (r.scan?.verdict === "flagged")
      say(
        `security scan: flagged (${(r.scan.reasons ?? []).join(", ")}). Your next session sees the flag too.`,
      );
    say(
      "Starting a fresh session: type /clear or open a new session in this folder. It starts by reading these notes.",
    );
    return 0;
  }

  say(`Handover for ${root}`);
  let relay: string;
  try {
    // peek: the relay answers the state without the text and without marking it picked up.
    const r = (await io.call("tool", {
      resident_id: rid,
      name: "handover_get",
      args: { peek: true },
    })) as { state?: string; handover_id?: string; revision?: number } | null;
    relay =
      r?.state === "stored"
        ? `waiting (${r.handover_id} revision ${r.revision})`
        : r?.state === "consumed"
          ? `picked up (${r.handover_id} revision ${r.revision})`
          : "nothing stored";
  } catch (e) {
    relay = `unknown (${(e as Error).message})`;
  }
  say(`  relay: ${relay}`);
  const ack = readAck(io.stateDir, rid);
  say(
    `  last stored here: ${ack ? `${ack.handover_id} revision ${ack.revision} at ${ack.stored_at} (the relay confirmed it)` : "nothing"}`,
  );
  const cfg = loadConfig(io.stateDir, root);
  const cleared = lastCleared(io.stateDir, rid);
  say(`  auto-clear: ${autoState(cfg)}${cleared ? `; last: ${cleared}` : ""}`);
  return 0;
}

const NOT_CLAUDE =
  "auto-clear works only from a Claude Code session (CLAUDECODE=1 is not set). Codex blocks /clear while a task runs: type it yourself there";

/** Replace the marker file with an empty one, so a bad path fails now with one plain reason. */
function freshMarkerFile(path: string): void {
  try {
    rmSync(path, { force: true });
    closeSync(openSync(path, "wx", 0o600));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    const why =
      code === "EISDIR" || code === "ERR_FS_EISDIR"
        ? "is a folder"
        : code === "ENOENT"
          ? "cannot be made: its folder does not exist"
          : code === "EACCES" || code === "EPERM"
            ? "cannot be replaced: permission denied"
            : `cannot be used (${(e as Error).message})`;
    throw new Error(`--marker-file ${path} ${why}`);
  }
}

function autoState(cfg: ClearConfig): string {
  if (cfg.pending) return `test running (${cfg.pending.mode})`;
  const test = tested(cfg)
    ? `tested ${cfg.pass?.at} (${cfg.pass?.mode})`
    : `not tested${cfg.last_test ? `, last test ${cfg.last_test}` : ""}`;
  if (!cfg.template) return `${cfg.enabled ? "on" : "off"}, no clear command`;
  return `${cfg.enabled ? "on" : "off"}, ${test}`;
}

/** The real helper link: the local socket with the daemon token. */
export function realIo(cwd = process.cwd()): HandoverIo {
  const stateDir = defaultStateDir();
  return {
    cwd,
    stateDir,
    print: (l) => process.stdout.write(`${l}\n`),
    call: async (op, args) => {
      const token = readToken(stateDir);
      if (!token)
        throw new Error("the Hawl helper is not running (hawl daemon start)");
      const r = await request(
        socketPath(stateDir),
        { op, token, ...args },
        10_000,
      );
      if (!r.ok) throw new Error(r.error);
      return r.result;
    },
    readStdin: async () => {
      if (process.stdin.isTTY) return "";
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}
