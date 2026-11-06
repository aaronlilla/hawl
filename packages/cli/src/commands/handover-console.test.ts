import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "../test-tmp.ts";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpState } from "../daemon/testkit.ts";
import { parseTemplate } from "./handover-clear.ts";
import {
  type Ancestor,
  bindConsole,
  CONSOLE_CS,
  findAgentConsole,
  isClaudeCode,
  joinMsysChain,
  msysParent,
  pickAgent,
  typeIntoConsole,
  WIN_CONSOLE,
  WIN_CONSOLE_TEMPLATE,
} from "./handover-console.ts";

const RID = "res_01926f3a-0000-7000-8000-000000000001";
const HOV = "hov_01926f3a-0000-7000-8000-0000000000aa";

test("H24: the windows-console step is exactly [hawl:windows-console, {text}]", () => {
  assert.deepEqual(parseTemplate(WIN_CONSOLE_TEMPLATE), WIN_CONSOLE_TEMPLATE);
  for (const bad of [
    [[WIN_CONSOLE]],
    [[WIN_CONSOLE, "/clear"]],
    [[WIN_CONSOLE, "{text}", "123"]],
    [[WIN_CONSOLE, "{text}x"]],
  ])
    assert.throws(
      () => parseTemplate(bad),
      /hawl:windows-console step is exactly/,
    );
  // Bound once, by clear or test: other steps are left as they are.
  assert.deepEqual(
    bindConsole(
      [
        [WIN_CONSOLE, "/clear"],
        ["tmux", "x"],
      ],
      () => "4242:1",
    ),
    [
      [WIN_CONSOLE, "/clear", "4242:1"],
      ["tmux", "x"],
    ],
  );
  assert.deepEqual(
    bindConsole([["tmux", "x"]], () => {
      throw new Error("not called");
    }),
    [["tmux", "x"]],
  );
});

// Real shape from a Claude Code Bash tool on Windows: node <- sh.exe (the npm shim) <- a fork that
// already exited. The Windows chain stops at sh.exe; Git's `ps -W` still knows its msys parent.
const PS_W = `      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND
   626657  626653  626653      40316  ?         197108 08:12:01 /usr/bin/sh
   626653  626600  626600      51404  ?         197108 08:11:22 /usr/bin/bash
   626600       0       0      24356  ?         197108 08:11:21 C:\\claude.exe
`;
test("H26: a shim's sh.exe with an exited parent is followed through Git's msys table to claude.exe", () => {
  const a = (pid: number, name: string): Ancestor => ({
    pid,
    name,
    start: "7",
    console: true,
  });
  const broken = [a(40316, "sh.exe")];
  assert.throws(
    () => pickAgent(broken),
    /needs Claude Code 2\.x's claude\.exe/,
  );
  assert.equal(msysParent(PS_W, 40316), 51404);
  assert.equal(msysParent(PS_W, 24356), undefined);
  assert.equal(msysParent(PS_W, 99), undefined);
  const find = (pid: number) =>
    pid === 51404 ? [a(51404, "bash.exe"), a(24356, "claude.exe")] : [];
  const chain = joinMsysChain(broken, 1, () => PS_W, find);
  assert.equal(pickAgent(chain), "24356:7");
  // No msys parent, or no claude.exe above it: still refused, never a guess.
  assert.throws(() =>
    pickAgent(joinMsysChain([a(24356, "node.exe")], 1, () => PS_W, find)),
  );
});

/**
 * Only claude.exe is Claude Code: the native install and the npm package (2.x ships bin/claude.exe)
 * both run it. Judge rounds 4 and 5 fooled command-line matching with a PowerShell wrapper and with
 * `node --title|--require <package>/cli.js other.cjs`, so no node process is ever a target.
 */
test("H26: only an ancestor whose image is claude.exe is Claude Code; the nearest one wins", () => {
  const a = (pid: number, name: string, console = true): Ancestor => ({
    pid,
    name,
    start: "7",
    console,
  });
  for (const name of [
    "powershell.exe",
    "node.exe",
    "notclaude.exe",
    "claude.exe.bak",
    "bash.exe",
  ]) {
    assert.equal(isClaudeCode(a(1, name)), false, name);
    assert.throws(
      () => pickAgent([a(1, name)]),
      /needs Claude Code 2\.x's claude\.exe/,
      name,
    );
  }
  for (const name of ["claude.exe", "Claude.EXE"]) {
    assert.equal(isClaudeCode(a(10, name)), true, name);
    assert.equal(pickAgent([a(10, name)]), "10:7", name);
  }
  // The nearest claude.exe wins; anything below it is skipped; no console refuses.
  assert.equal(
    pickAgent([
      a(20, "bash.exe"),
      a(19, "node.exe"),
      a(21, "claude.exe"),
      a(22, "claude.exe"),
    ]),
    "21:7",
  );
  assert.throws(
    () => pickAgent([a(23, "claude.exe", false)]),
    /has no console/,
  );
  assert.throws(() => pickAgent([]), /needs Claude Code 2\.x's claude\.exe/);
});

/**
 * The same through the real process tree, with judge round 5's probes: node running another script
 * under the package, also with the package's cli.js as the value of --title or --require, sits right
 * above the process that looks. Its launcher started it detached and exited, so the chain ends at the
 * impostor and nothing above it (like the Claude Code running this test) is reachable.
 * The process that looks runs on a hidden console of its own (CREATE_NO_WINDOW): no window.
 */
test("H26: live: node under @anthropic-ai/claude-code, even with --title or --require cli.js, is not Claude Code", {
  skip: process.platform !== "win32" && "Windows only",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hawl-impostor-"));
  const pkg = join(dir, "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(pkg, { recursive: true });
  const cli = join(pkg, "cli.js");
  writeFileSync(cli, "");
  const grand = join(dir, "grand.cjs");
  writeFileSync(
    grand,
    `require("fs").writeFileSync(process.argv[2], String(process.pid));\nsetTimeout(() => {}, 20000);\n`,
  );
  writeFileSync(
    join(pkg, "other.cjs"),
    `require("child_process").spawn(process.execPath, [${JSON.stringify(grand)}, process.argv[2]], { stdio: "ignore", windowsHide: true });\nsetTimeout(() => {}, 20000);\n`,
  );
  const launcher = join(dir, "launch.cjs");
  writeFileSync(
    launcher,
    `const [cmd, ...args] = process.argv.slice(2);\nrequire("child_process").spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();\nprocess.exit(0);\n`,
  );
  const other = join(pkg, "other.cjs");
  for (const pre of [[], ["--title", cli], ["--require", cli]]) {
    const pidFile = join(dir, `grand-${pre.length ? pre[0] : "plain"}.pid`);
    await new Promise<void>((done) =>
      spawn(
        process.execPath,
        [launcher, process.execPath, ...pre, other, pidFile],
        { stdio: "ignore", windowsHide: true },
      ).on("close", () => done()),
    );
    const until = Date.now() + 20_000;
    while (!existsSync(pidFile) && Date.now() < until)
      await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      assert.throws(
        () => findAgentConsole(pid),
        /needs Claude Code 2\.x's claude\.exe/,
        pre.join(" ") || "plain",
      );
    } finally {
      process.kill(pid);
    }
  }
});

/**
 * Every console step says in the typer log where it typed and how it ended, in test mode too: a real
 * Claude Code run ended "exited 0" with nothing typed and no reason. A start time that does not match
 * this process refuses before attaching (exit 10), so nothing is typed here.
 */
test("H26: a console step logs its target and outcome (exit 10: the agent process is gone or its pid was reused)", {
  skip: process.platform !== "win32" && "Windows only",
}, async () => {
  const lines: string[] = [];
  const r = await typeIntoConsole(
    [WIN_CONSOLE, "hawl-x", `${process.pid}:1`],
    undefined,
    (l) => lines.push(l),
  );
  assert.equal(r, 10);
  assert.deepEqual(lines, [
    `${WIN_CONSOLE} into ${process.pid}:1: exit 10 (the agent process is gone or its pid was reused)\n`,
  ]);
});

/**
 * H25: a dialog open in the agent's terminal would take the Enter (our real Claude Code run: the
 * Enter answered the folder-trust question with "No, exit"). The step reads the bottom of the
 * screen first and types nothing while it shows a selection dialog. A real hidden console: the fake
 * agent draws the dialog on its own console and logs what it reads; once the dialog scrolls away,
 * the same step types.
 */
/** Judge j5: a failed or short row read is an unreadable screen, never an empty one. */
test("H25: the screen counts as read only when every visible row reads in full", {
  skip: process.platform !== "win32" && "Windows only",
}, () => {
  const fake = `
public static class FakeRows {
  public static string Run(string mode) {
    string s = HawlConsole.ScreenOf(3, 4, delegate(int y, System.Text.StringBuilder b, out uint r) {
      b.Append("abcd");
      r = (mode == "short" && y == 1) ? 2u : 4u;
      return !(mode == "fail" && y == 1);
    });
    return s == null ? "unreadable" : s.Replace(System.Environment.NewLine, "|");
  }
}`;
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${CONSOLE_CS}\n${fake}\n'@\n[Console]::Out.Write(([FakeRows]::Run('ok')) + ';' + ([FakeRows]::Run('fail')) + ';' + ([FakeRows]::Run('short')))`;
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", windowsHide: true, timeout: 60_000 },
  );
  assert.equal(r.stdout, "abcd|abcd|abcd|;unreadable;unreadable", r.stderr);
});

test("H25: the console step types nothing while the screen shows a dialog, and types once it is gone", {
  skip: process.platform !== "win32" && "Windows only",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hawl-dialog-"));
  const got = join(dir, "got.log");
  const flag = join(dir, "gone.flag");
  const agent = join(dir, "agent.mjs");
  writeFileSync(
    agent,
    `import { appendFileSync, existsSync, openSync, writeSync } from "node:fs";
import tty from "node:tty";
const [got, flag] = process.argv.slice(2);
const out = openSync("\\\\\\\\.\\\\CONOUT$", "w");
writeSync(out, " Do you want to make this edit?\\r\\n ❯ 1. Yes\\r\\n   2. No\\r\\n Enter to confirm \\u00b7 Esc to cancel\\r\\n");
const input = new tty.ReadStream(openSync("\\\\\\\\.\\\\CONIN$", "r+"));
input.setRawMode(true);
input.on("data", (d) => appendFileSync(got, d.toString("utf8")));
const t = setInterval(() => {
  if (!existsSync(flag)) return;
  clearInterval(t);
  writeSync(out, "\\r\\n".repeat(200) + " ready\\r\\n");
}, 100);
setTimeout(() => process.exit(0), 60000);
`,
  );
  const p = spawn(process.execPath, [agent, got, flag], {
    stdio: "ignore",
    // A console of its own with no window: nothing shows on screen.
    windowsHide: true,
  });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const ticks = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${p.pid}").CreationDate.ToUniversalTime().Ticks`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout.trim();
    const step = [WIN_CONSOLE, "hawl-x", `${p.pid}:${ticks}`];
    const lines: string[] = [];
    assert.equal(
      await typeIntoConsole(step, undefined, (l) => lines.push(l)),
      11,
    );
    assert.match(lines[0] ?? "", /exit 11 \(a selection dialog is open/);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(existsSync(got) ? readFileSync(got, "utf8") : "", "");
    writeFileSync(flag, "");
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await typeIntoConsole(step, undefined, () => {}), 0);
    const until = Date.now() + 5000;
    while (!existsSync(got) && Date.now() < until)
      await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(readFileSync(got, "utf8"), "hawl-x\r");
  } finally {
    p.kill();
  }
});

/** Judge j10: a dialog that opens after the text went in gets no Enter: the screen is read again first. */
test("H25: a dialog that appears after the text is typed gets no Enter; the text is erased", {
  skip: process.platform !== "win32" && "Windows only",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hawl-late-"));
  const got = join(dir, "got.log");
  const drawn = join(dir, "drawn.flag");
  const agent = join(dir, "agent.mjs");
  writeFileSync(
    agent,
    `import { appendFileSync, openSync, writeFileSync, writeSync } from "node:fs";
import tty from "node:tty";
const [got, drawn] = process.argv.slice(2);
const out = openSync("\\\\\\\\.\\\\CONOUT$", "w");
const input = new tty.ReadStream(openSync("\\\\\\\\.\\\\CONIN$", "r+"));
input.setRawMode(true);
let shown = false;
input.on("data", (d) => {
  appendFileSync(got, d.toString("utf8"));
  if (shown) return;
  shown = true;
  writeSync(out, " Do you want to make this edit?\\r\\n \u276f 1. Yes\\r\\n   2. No\\r\\n Enter to confirm \\u00b7 Esc to cancel\\r\\n");
  writeFileSync(drawn, "");
});
setTimeout(() => process.exit(0), 60000);
`,
  );
  const p = spawn(process.execPath, [agent, got, drawn], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const ticks = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${p.pid}").CreationDate.ToUniversalTime().Ticks`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout.trim();
    let checks = 0;
    const lines: string[] = [];
    const r = await typeIntoConsole(
      [WIN_CONSOLE, "hawl-x", `${p.pid}:${ticks}`],
      () => {
        // Before the Enter: hold until the agent has drawn its dialog.
        if (++checks === 3) {
          const until = Date.now() + 5000;
          while (!existsSync(drawn) && Date.now() < until) {}
        }
        return undefined;
      },
      (l) => lines.push(l),
    );
    assert.equal(r, 11, lines.join(""));
    await new Promise((res) => setTimeout(res, 500));
    const keys = readFileSync(got, "utf8");
    assert.match(keys, /^hawl-x[\b\x7f]{6}$/, JSON.stringify(keys));
    assert.match(
      lines.join(""),
      /exit 11 \(a selection dialog is open.*erased 6 of 6/,
    );
  } finally {
    p.kill();
  }
});

/** A turn that starts while the text goes in: the text is erased again and the Enter never sent. */
test("H25: a refusal between the text and the Enter erases the typed text and sends no Enter", {
  skip: process.platform !== "win32" && "Windows only",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hawl-erase-"));
  const got = join(dir, "got.log");
  const agent = join(dir, "agent.mjs");
  writeFileSync(
    agent,
    `import { appendFileSync, openSync } from "node:fs";
import tty from "node:tty";
const input = new tty.ReadStream(openSync("\\\\\\\\.\\\\CONIN$", "r+"));
input.setRawMode(true);
input.on("data", (d) => appendFileSync(process.argv[2], d.toString("utf8")));
setTimeout(() => process.exit(0), 60000);
`,
  );
  const p = spawn(process.execPath, [agent, got], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const ticks = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${p.pid}").CreationDate.ToUniversalTime().Ticks`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout.trim();
    const NEW_TURN =
      "a new turn started after the clear was armed: nothing typed";
    let checks = 0;
    const lines: string[] = [];
    const r = await typeIntoConsole(
      [WIN_CONSOLE, "hawl-x", `${p.pid}:${ticks}`],
      () => (++checks === 3 ? NEW_TURN : undefined),
      (l) => lines.push(l),
    );
    assert.equal(r, NEW_TURN);
    assert.equal(
      checks,
      3,
      "checked at ready, after the screen, before the Enter",
    );
    const until = Date.now() + 5000;
    while (!existsSync(got) && Date.now() < until)
      await new Promise((res) => setTimeout(res, 50));
    await new Promise((res) => setTimeout(res, 500));
    const keys = readFileSync(got, "utf8");
    assert.match(keys, /^hawl-x[\b\x7f]{6}$/, JSON.stringify(keys));
    assert.match(lines.join(""), /erased the 6 typed characters/);
  } finally {
    p.kill();
  }
});

/**
 * A real Windows console, hidden (CREATE_NO_WINDOW: no window at all). The fake agent is node under
 * the image name claude.exe (a hard link, or a copy across drives), reads raw key input from its own
 * console like a prompt box and logs each submitted line. Like Claude Code's Bash tool it runs the
 * real CLI as children: once on a console of their own, once sharing the agent's console.
 */
test("Windows console end to end: test passes and clear types exactly /clear once into the agent's own console", {
  skip: process.platform !== "win32" && "Windows only",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hawl-wincon-"));
  const cwd = join(dir, "folder");
  mkdirSync(join(cwd, ".hawl"), { recursive: true });
  writeFileSync(
    join(cwd, ".hawl", "hawl.json"),
    JSON.stringify({
      v: 1,
      village_id: "vil_1",
      folder_label: "p",
      memberships: [
        {
          town_id: "twn_1",
          town_slug: "acme",
          relay_url: "https://relay.hawl.ai",
          workers: [{ resident_id: RID, platform: "claude_code", kid: "k" }],
        },
      ],
      written: [],
      restore: [],
    }),
  );
  const stateDir = tmpState();
  const claudeExe = join(dir, "claude.exe");
  try {
    linkSync(process.execPath, claudeExe);
  } catch {
    copyFileSync(process.execPath, claudeExe);
  }
  const agent = join(dir, "agent.mjs");
  writeFileSync(
    agent,
    `import { appendFileSync, existsSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import tty from "node:tty";
const [main, cwd, home, typedLog, markerFile, ackMod, clearMod] = process.argv.slice(2);
const { recordAck } = await import(ackMod);
const { noteTurn } = await import(clearMod);
const input = new tty.ReadStream(openSync("\\\\\\\\.\\\\CONIN$", "r+"));
input.setRawMode(true);
let buf = "";
input.on("data", (d) => {
  buf += d.toString("utf8");
  for (let i; (i = buf.indexOf("\\r")) >= 0; buf = buf.slice(i + 1)) {
    appendFileSync(typedLog, buf.slice(0, i) + "\\n");
    appendFileSync(markerFile, buf.slice(0, i) + "\\n");
  }
});
const steps = [];
const run = (args, ownConsole) =>
  new Promise((res) => {
    const p = spawn(process.env.HAWL_TEST_NODE, [main, "handover", ...args], {
      cwd,
      env: { ...process.env, HAWL_HOME: home, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s-console", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: ownConsole,
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => { steps.push({ args, ownConsole, code, out: out.trim() }); res(); });
  });
const lines = () => (existsSync(typedLog) ? readFileSync(typedLog, "utf8").split("\\n").filter(Boolean) : []);
const waitLines = async (n, ms) => { const end = Date.now() + ms; while (lines().length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); };
// Like Claude Code's Stop hook: the turn ends once the clear step has started (H25).
const typerLog = home + "/handover-typer.log";
const started = () => (existsSync(typerLog) ? readFileSync(typerLog, "utf8").split("\\n").filter((l) => / started /.test(l)).length : 0);
let typers = 0;
const endTurn = async () => {
  typers++;
  const end = Date.now() + 30000;
  while (started() < typers && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  noteTurn(home, cwd, "s-console", "Stop");
};
await run(["config", "--on", "--template", '[["hawl:windows-console","{text}"]]'], true);
let want = 0;
for (const [own, rev] of [[true, 3], [false, 4]]) {
  recordAck(home, ${JSON.stringify(RID)}, { handover_id: ${JSON.stringify(HOV)}, revision: rev, state: "stored" });
  const t = run(["test", "--marker-file", markerFile, "--delay-ms", "500"], own);
  await endTurn();
  await t;
  want++;
  await run(["clear", "--delay-ms", "500"], own);
  await endTurn();
  want++;
  await waitLines(want, 20000);
  await new Promise((r) => setTimeout(r, 1000));
  await run(["clear", "--delay-ms", "500"], own);
  await new Promise((r) => setTimeout(r, 3000));
}
// An --off right after clear, while its child is still starting PowerShell: nothing may be typed.
recordAck(home, ${JSON.stringify(RID)}, { handover_id: ${JSON.stringify(HOV)}, revision: 5, state: "stored" });
const t3 = run(["test", "--marker-file", markerFile, "--delay-ms", "500"], true);
await endTurn();
await t3;
want++;
await waitLines(want, 20000);
await run(["clear", "--delay-ms", "500"], true);
await endTurn();
// Past the child's first check (about 0.5 s plus its start), before PowerShell is ready (seconds).
await new Promise((r) => setTimeout(r, 800));
await run(["config", "--off"], true);
await new Promise((r) => setTimeout(r, 8000));
process.stdout.write(JSON.stringify({ pid: process.pid, steps, typed: lines() }));
process.exit(0);
`,
  );
  const typedLog = join(dir, "typed.log");
  const markerFile = join(dir, "marker.log");
  const main = fileURLToPath(new URL("../main.ts", import.meta.url));
  const ackMod = pathToFileURL(
    fileURLToPath(new URL("../daemon/handover.ts", import.meta.url)),
  ).href;
  const clearMod = new URL("./handover-clear.ts", import.meta.url).href;
  const res = await new Promise<{ code: number | null; out: string }>(
    (done) => {
      const p = spawn(
        claudeExe,
        [agent, main, cwd, stateDir, typedLog, markerFile, ackMod, clearMod],
        {
          // The CLI runs under plain node, so the only claude.exe above it is the agent.
          env: { ...process.env, HAWL_TEST_NODE: process.execPath },
          stdio: ["ignore", "pipe", "pipe"],
          // A console of its own with no window: nothing shows on screen.
          windowsHide: true,
        },
      );
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      const kill = setTimeout(() => p.kill(), 150_000);
      p.on("close", (code) => {
        clearTimeout(kill);
        done({ code, out });
      });
    },
  );
  writeFileSync(join(dir, "agent-out.json"), res.out);
  assert.equal(res.code, 0, res.out);
  const r = JSON.parse(res.out) as {
    pid: number;
    steps: { args: string[]; ownConsole: boolean; code: number; out: string }[];
    typed: string[];
  };
  console.log(
    `agent pid ${r.pid}\n${r.steps.map((s) => `${s.ownConsole ? "own console" : "shared console"} | hawl handover ${s.args.join(" ")} -> exit ${s.code}: ${s.out.split("\n")[0]}`).join("\n")}\ntyped into the agent's console: ${JSON.stringify(r.typed)}`,
  );
  const [cfg, ...rest] = r.steps;
  assert.equal(cfg?.code, 0, cfg?.out ?? "");
  for (const i of [0, 1]) {
    const [t, c, again] = rest.slice(i * 3, i * 3 + 3);
    assert.equal(t?.code, 0, t?.out ?? "");
    assert.match(
      t?.out ?? "",
      /PASSED: the clear command wrote hawl-handover-test-/,
    );
    assert.equal(c?.code, 0, c?.out ?? "");
    assert.match(c?.out ?? "", /Clearing 0\.5 s after this turn ends/);
    assert.equal(again?.code, 1);
    assert.match(again?.out ?? "", /already cleared: nothing typed/);
  }
  assert.equal(r.typed.length, 5, JSON.stringify(r.typed));
  assert.match(r.typed[0] as string, /^hawl-handover-test-[0-9a-f]{16}$/);
  assert.equal(r.typed[1], "/clear");
  assert.match(r.typed[2] as string, /^hawl-handover-test-[0-9a-f]{16}$/);
  assert.equal(r.typed[3], "/clear");
  assert.match(r.typed[4] as string, /^hawl-handover-test-[0-9a-f]{16}$/);
  const [t3, c3, off] = rest.slice(6);
  assert.equal(t3?.code, 0, t3?.out ?? "");
  assert.equal(c3?.code, 0, c3?.out ?? "");
  assert.equal(off?.code, 0, off?.out ?? "");
  assert.match(
    readFileSync(join(stateDir, "handover-acks", `${RID}.cleared`), "utf8"),
    /^skipped 5: auto-clear is off/,
    "the --off after clear won: its child wrote no keys",
  );
  // Each console step logged its target and outcome, tests included; the --off one says it was refused.
  const log = readFileSync(join(stateDir, "handover-typer.log"), "utf8");
  const typedLines = log.match(
    new RegExp(
      `${WIN_CONSOLE} into ${r.pid}:\\d+: exit 0, wrote (\\d+) of \\1 key events`,
      "g",
    ),
  );
  assert.equal(typedLines?.length, 5, log);
  assert.match(log, /\nskipped: auto-clear is off/);
  assert.doesNotMatch(
    log,
    /hawl-handover-test-|\/clear(?! yourself)/,
    "the typed text is not logged",
  );
});
