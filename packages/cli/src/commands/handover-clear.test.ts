import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "../test-tmp.ts";
import { join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readAck, recordAck } from "../daemon/handover.ts";
import { socketPath, tokenPath } from "../daemon/socket.ts";
import { tmpState } from "../daemon/testkit.ts";
import { type HookDeps, hookOutput } from "../hook/hook.ts";
import { handover } from "./handover.ts";
import {
  beginTest,
  CLEAR_TEXT,
  type ClearConfig,
  clearRefusal,
  configHistory,
  configure,
  envNames,
  expire,
  finishTest,
  hookMarker,
  lastCleared,
  launchTyper,
  loadConfig,
  newNonce,
  noteTurn,
  parseDelay,
  parsePayload,
  parseTemplate,
  readTurn,
  render,
  runTyper,
  saveConfig,
  type Template,
  TURN_WAIT_MS,
  type TyperPayload,
  templateHash,
  testDeadline,
  tested,
  testHooks,
  typeRefusal,
  typerLaunch,
  updateConfig,
} from "./handover-clear.ts";
import { SETUP_PROMPT } from "./handover-setup.ts";

const RID = "res_01926f3a-0000-7000-8000-000000000001";

/** Claude Code's turn ended right after the clear or test that made `p` (its Stop hook, H25). */
function ended(p: TyperPayload): TyperPayload {
  if (p.turn)
    noteTurn(
      p.turn.state_dir,
      p.turn.root,
      p.turn.session,
      "Stop",
      p.turn.since + 1,
    );
  return p;
}
const HOV = "hov_01926f3a-0000-7000-8000-0000000000aa";
const NODE = process.execPath;

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "hawl-hclr-"));
  mkdirSync(join(dir, ".hawl"));
  writeFileSync(
    join(dir, ".hawl", "hawl.json"),
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
  return dir;
}

/** The fake terminal: appends the argv it got (and who started it, and when) to a log. */
function fakeTerminal(): { script: string; log: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "hawl-fake-term-"));
  const script = join(dir, "fake.mjs");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
const [log, ...rest] = process.argv.slice(2);
appendFileSync(log, JSON.stringify({ argv: rest, ppid: process.ppid, t: Date.now() }) + "\\n");
if (rest.includes("FAIL")) process.exit(3);
`,
  );
  return { script, log: join(dir, "typed.jsonl"), dir };
}

type Typed = { argv: string[]; ppid: number; t: number };
const typed = (log: string): Typed[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** tmux-shaped template pointed at the fake terminal: the text and the Enter in one step. */
const tmuxLike = (f: { script: string; log: string }) => [
  [NODE, f.script, f.log, "-t", "${TMUX_PANE}", "{text}", "Enter"],
];

/** Claude Code's own session id, in its Bash tool's env and in every hook's payload. */
const SID = "2bf4dabc-9da2-493e-a013-5be82b565e04";
const ENV = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SID, TMUX_PANE: "%7" };

/** A folder ready to clear: on, template set, test passed, a stored handover at revision 3. */
function ready(o: { env?: NodeJS.ProcessEnv } = {}) {
  const cwd = folder();
  const stateDir = tmpState();
  const f = fakeTerminal();
  const lines: string[] = [];
  const runs: Promise<void>[] = [];
  const launched: TyperPayload[] = [];
  const t = tmuxLike(f);
  saveConfig(stateDir, {
    root: cwd,
    enabled: true,
    template: t,
    pass: {
      hash: templateHash(t),
      env: envNames(t),
      at: "2026-10-21T10:00:00.000Z",
      mode: "hook",
    },
  });
  recordAck(stateDir, RID, { handover_id: HOV, revision: 3, state: "stored" });
  const io = {
    cwd,
    stateDir,
    print: (l: string) => void lines.push(l),
    call: async (
      _op: string,
      _args: Record<string, unknown>,
    ): Promise<unknown> => ({
      handover_id: HOV,
      revision: 4,
      state: "stored",
    }),
    env: o.env ?? { ...ENV },
    // The real child body, without its wait, so the fake terminal shows exactly what would be typed.
    launch: (p: TyperPayload) => {
      launched.push(p);
      runs.push(runTyper({ ...ended(p), delay_ms: 0 }));
    },
  };
  return { cwd, stateDir, f, lines, runs, launched, io, t };
}

test("H24: the template is argv arrays with only {text} and allowlisted ${NAME}; anything else is refused", () => {
  const ok = [
    [["tmux", "send-keys", "-t", "${TMUX_PANE}", "{text}", "Enter"]],
    [
      [
        "wezterm",
        "cli",
        "send-text",
        "--pane-id",
        "${WEZTERM_PANE}",
        "{text}\r",
      ],
    ],
    [
      [
        "kitten",
        "@",
        "--to",
        "${KITTY_LISTEN_ON}",
        "send-text",
        "--match",
        "id:${KITTY_WINDOW_ID}",
        "{text}\\r",
      ],
    ],
    [
      [
        "x",
        "a$",
        "{text}",
        "${TMUX}",
        "${ITERM_SESSION_ID}",
        "${TERM_PROGRAM}",
        "${WT_SESSION}",
      ],
    ],
  ];
  for (const t of ok) assert.deepEqual(parseTemplate(t), t);
  const bad: [unknown, RegExp][] = [
    ["tmux send-keys {text}", /1 to 4 steps/],
    [[], /1 to 4 steps/],
    [[["a", "{text}"], ["a"], ["a"], ["a"], ["a"]], /1 to 4 steps/],
    [["tmux send-keys -l {text}"], /list of 1 to 32 strings/],
    [[[]], /list of 1 to 32 strings/],
    [[["tmux", 3, "{text}"]], /list of 1 to 32 strings/],
    [[["tmux", "{cmd}"]], /\{cmd\} is not allowed/],
    [[["tmux", "{TEXT}"]], /\{TEXT\} is not allowed/],
    [[["tmux", "{text}", "${HOME}"]], /\$\{HOME\} is not an allowed/],
    [[["tmux", "{text}", "${PATH}"]], /\$\{PATH\} is not an allowed/],
    [[["tmux", "{text}", "$TMUX_PANE"]], /stray/],
    [[["tmux", "{text}", "$(whoami)"]], /stray/],
    [[["tmux", "{text"]], /stray/],
    [[["tmux", "{{text}}"]], /stray/],
    [[["tmux", "${TMUX_PANE"]], /stray/],
    [[["${TERM_PROGRAM}", "{text}"]], /plain name or path/],
    [[["{text}"]], /plain name or path/],
    [[["tmux", "send-keys", "Enter"]], /no \{text\}/],
    [[["tmux", ""]], /1 to 1000 characters/],
    [[["tmux", "a\0b", "{text}"]], /no NUL/],
  ];
  for (const [t, why] of bad)
    assert.throws(() => parseTemplate(t), why, JSON.stringify(t));
});

test("H24: auto-clear defaults to off with no command; config refuses a bad template and saves nothing", async () => {
  const cwd = folder();
  const stateDir = tmpState();
  assert.deepEqual(loadConfig(stateDir, cwd), { root: cwd, enabled: false });
  const lines: string[] = [];
  const io = {
    cwd,
    stateDir,
    print: (l: string) => void lines.push(l),
    call: async () => null,
  };
  assert.equal(await handover(["config"], io), 0);
  assert.match(lines.join("\n"), /off, no clear command/);
  for (const raw of [
    "not json",
    '"tmux send-keys /clear"',
    '[["sh","-c","{text}; ${HOME}"]]',
  ])
    await assert.rejects(
      handover(["config", "--on", "--template", raw], io),
      /clear command refused/,
      raw,
    );
  assert.deepEqual(loadConfig(stateDir, cwd), { root: cwd, enabled: false });
  // A clear command is stored per machine (state dir), never in the folder.
  await handover(
    [
      "config",
      "--template",
      '[["tmux","send-keys","-t","${TMUX_PANE}","{text}","Enter"]]',
    ],
    io,
  );
  const cfg = loadConfig(stateDir, cwd);
  assert.equal(cfg.enabled, false, "setting a command does not turn it on");
  assert.ok(cfg.template);
  assert.ok(
    !readFileSync(join(cwd, ".hawl", "hawl.json"), "utf8").includes(
      "send-keys",
    ),
  );
});

test("H25: each missing precondition prints its own reason and types nothing", async () => {
  const cases: [string, (r: ReturnType<typeof ready>) => void, RegExp][] = [
    [
      "not Claude Code (Codex)",
      (r) => delete r.io.env.CLAUDECODE,
      /only from a Claude Code session.*Codex/,
    ],
    [
      "no Claude Code session id",
      (r) => delete r.io.env.CLAUDE_CODE_SESSION_ID,
      /CLAUDE_CODE_SESSION_ID is not set/,
    ],
    [
      "auto-clear off",
      (r) =>
        saveConfig(r.stateDir, {
          ...loadConfig(r.stateDir, r.cwd),
          enabled: false,
        }),
      /auto-clear is off/,
    ],
    [
      "no command",
      (r) => saveConfig(r.stateDir, { root: r.cwd, enabled: true }),
      /no clear command is configured/,
    ],
    [
      "never tested",
      (r) =>
        saveConfig(r.stateDir, {
          ...loadConfig(r.stateDir, r.cwd),
          pass: undefined,
        }),
      /has not passed hawl handover test/,
    ],
    [
      "tested a different command",
      (r) => {
        const c = loadConfig(r.stateDir, r.cwd);
        saveConfig(r.stateDir, {
          ...c,
          template: [[...(c.template?.[0] ?? []), "x"]],
        });
      },
      /has not passed hawl handover test/,
    ],
    [
      "no stored handover",
      (r) => {
        const s = tmpState();
        r.io.stateDir = s;
        saveConfig(s, loadConfig(r.stateDir, r.cwd));
      },
      /no stored handover/,
    ],
    ["env var missing", (r) => delete r.io.env.TMUX_PANE, /needs TMUX_PANE/],
    [
      "env var hostile",
      (r) => (r.io.env.TMUX_PANE = '%1" ; rm -rf ~'),
      /characters Hawl does not pass on/,
    ],
  ];
  for (const [name, breakIt, why] of cases) {
    const r = ready();
    breakIt(r);
    await assert.rejects(handover(["clear"], r.io), why, name);
    await Promise.all(r.runs);
    assert.equal(r.launched.length, 0, name);
    assert.deepEqual(typed(r.f.log), [], `${name}: nothing typed`);
  }
  // With every precondition met, exactly /clear then Enter reach the terminal named by TMUX_PANE.
  const r = ready();
  assert.equal(await handover(["clear"], r.io), 0);
  await Promise.all(r.runs);
  assert.deepEqual(
    typed(r.f.log).map((x) => x.argv),
    [["-t", "%7", "/clear", "Enter"]],
  );
  assert.match(
    r.lines.join("\n"),
    /Clearing 1\.5 s after this turn ends \(handover revision 3\)/,
  );
  assert.equal(
    readFileSync(join(r.stateDir, "handover-acks", `${RID}.cleared`), "utf8"),
    "cleared 3\n",
  );
});

test("H25: clear types only /clear; any other --command is refused before anything is claimed or started", async () => {
  assert.deepEqual(
    await (async () => {
      const r = ready();
      assert.equal(await handover(["clear"], r.io), 0);
      await Promise.all(r.runs);
      return typed(r.f.log).map((x) => x.argv);
    })(),
    [["-t", "%7", "/clear", "Enter"]],
  );
  for (const bad of [
    "/new",
    "",
    "new",
    "/New",
    "/clear now",
    "/clear;rm",
    "/clear\r",
    "//clear",
    "hawl-handover-test-0123456789abcdef",
  ]) {
    const r = ready();
    await assert.rejects(
      handover(["clear", "--command", bad], r.io),
      /--command must be \/clear: Hawl only ever types \/clear/,
      JSON.stringify(bad),
    );
    await Promise.all(r.runs);
    assert.equal(r.launched.length, 0, JSON.stringify(bad));
    assert.deepEqual(
      typed(r.f.log),
      [],
      `${JSON.stringify(bad)}: nothing typed`,
    );
    // Nothing claimed: the same revision still clears with /clear.
    assert.equal(await handover(["clear", "--command", "/clear"], r.io), 0);
  }
});

test("H25: one clear per revision, even when two run at once; a new write can be cleared once", async () => {
  const r = ready();
  const results = await Promise.allSettled([
    handover(["clear"], r.io),
    handover(["clear"], r.io),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const lost = results.find(
    (x) => x.status === "rejected",
  ) as PromiseRejectedResult;
  assert.match(
    lost.reason.message,
    /revision 3 was already cleared: nothing typed/,
  );
  await assert.rejects(handover(["clear"], r.io), /already cleared/);
  await Promise.all(r.runs);
  assert.equal(
    typed(r.f.log).filter((x) => x.argv.includes("/clear")).length,
    1,
  );
  recordAck(r.stateDir, RID, {
    handover_id: HOV,
    revision: 4,
    state: "stored",
  });
  assert.equal(await handover(["clear"], r.io), 0);
  await assert.rejects(
    handover(["clear"], r.io),
    /revision 4 was already cleared/,
  );
  await Promise.all(r.runs);
  assert.equal(
    typed(r.f.log).filter((x) => x.argv.includes("/clear")).length,
    2,
  );
});

test("H25: --delay-ms defaults to 1500 and stays within 500..10000", async () => {
  assert.equal(parseDelay(undefined), 1500);
  assert.equal(parseDelay("500"), 500);
  assert.equal(parseDelay("10000"), 10000);
  for (const bad of ["499", "10001", "0", "-1", "1.5e3", "abc", "", "1000.5"])
    assert.throws(() => parseDelay(bad), /500 to 10000/, bad);
  for (const delay of [100, 20_000, 1.5])
    assert.throws(
      () => parsePayload(JSON.stringify({ steps: [["a"]], delay_ms: delay })),
      /bad clear payload/,
    );
  const r = ready();
  await assert.rejects(
    handover(["clear", "--delay-ms", "100"], r.io),
    /500 to 10000/,
  );
  assert.equal(r.launched.length, 0);
  assert.equal(await handover(["clear", "--delay-ms", "2500"], r.io), 0);
  assert.equal(r.launched[0]?.delay_ms, 2500);
});

test("H25: {text} is only ever /clear or the test marker, whatever the handover text or env holds", async () => {
  // Seeded generator: the same hostile inputs every run.
  let seed = 0x5eed;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const pieces = [
    "/clear",
    "{text}",
    "${TMUX_PANE}",
    '"',
    "'",
    ";",
    "&&",
    "|",
    "`id`",
    "$(id)",
    "%PATH%",
    "\n",
    "\r",
    "\u001b[2J",
    " ",
    "hawl-handover-test-0123456789abcdef",
    "/hawl-handover-test-0123456789abcdef",
    "ü",
    "\\",
  ];
  const hostile = () =>
    Array.from({ length: 1 + rnd(8) }, () => pieces[rnd(pieces.length)]).join(
      "",
    );
  const f = fakeTerminal();
  const t = parseTemplate(tmuxLike(f));
  // The old slash form is not a marker any more.
  assert.throws(
    () => render(t, "/hawl-handover-test-0123456789abcdef", ENV),
    /only \/clear or the test marker can be typed/,
  );
  for (let i = 0; i < 300; i++) {
    const text = hostile();
    if (text !== "/clear" && !/^hawl-handover-test-[0-9a-f]{16}$/.test(text))
      assert.throws(
        () => render(t, text, ENV),
        /only \/clear or the test marker can be typed/,
      );
    const pane = hostile();
    const env = { TMUX_PANE: pane };
    let steps: string[][] | undefined;
    try {
      steps = render(t, CLEAR_TEXT, env);
    } catch (e) {
      assert.match((e as Error).message, /does not pass on|needs TMUX_PANE/);
      continue;
    }
    assert.equal(steps[0]?.[5], "/clear");
    assert.equal(
      steps[0]?.[4],
      pane,
      "env value lands in its own argument, unexpanded",
    );
    assert.match(pane, /^[A-Za-z0-9_.:/@,=+%-]+$/);
  }
  // Through `write` then `clear`: whatever the agent wrote, the terminal gets /clear.
  for (let i = 0; i < 20; i++) {
    const r = ready();
    const words = hostile();
    r.io.call = async () => ({
      handover_id: HOV,
      revision: 10 + i,
      state: "stored",
    });
    await handover(["write", "--text", `x${words}`], r.io);
    recordAck(r.stateDir, RID, {
      handover_id: HOV,
      revision: 10 + i,
      state: "stored",
    });
    await handover(["clear"], r.io);
    await Promise.all(r.runs);
    assert.deepEqual(typed(r.f.log)[0]?.argv, ["-t", "%7", "/clear", "Enter"]);
  }
});

test("H27: a test pass is bound to the command it ran; a change, off/on, or a failed or expired retest revokes it", async () => {
  const cwd = folder();
  const stateDir = tmpState();
  const dir = mkdtempSync(join(tmpdir(), "hawl-mark-"));
  const writer = join(dir, "write-marker.mjs");
  writeFileSync(
    writer,
    'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], process.argv[3]);\n',
  );
  const markerFile = join(dir, "marker.txt");
  const launched: Promise<void>[] = [];
  const lines: string[] = [];
  const io = {
    cwd,
    stateDir,
    print: (l: string) => void lines.push(l),
    call: async () => null,
    env: { ...ENV },
    launch: (p: TyperPayload) =>
      void launched.push(runTyper({ ...ended(p), delay_ms: 0 })),
  };
  const tpl = JSON.stringify([[NODE, writer, markerFile, "{text}"]]);
  await handover(["config", "--on", "--template", tpl], io);
  assert.equal(
    await handover(
      ["test", "--marker-file", markerFile, "--delay-ms", "500"],
      io,
    ),
    0,
  );
  assert.match(
    lines.at(-1) ?? "",
    /PASSED: the clear command wrote hawl-handover-test-[0-9a-f]{16} /,
  );
  let cfg = loadConfig(stateDir, cwd);
  assert.ok(tested(cfg));
  assert.equal(cfg.pass?.hash, templateHash(JSON.parse(tpl)));
  assert.equal(cfg.pass?.mode, "marker-file");

  // Changing the command drops the pass.
  await handover(
    [
      "config",
      "--template",
      JSON.stringify([[NODE, writer, markerFile, "{text}", "x"]]),
    ],
    io,
  );
  assert.equal(tested(loadConfig(stateDir, cwd)), false);
  // Same command again: still needs a new test. Off then on drops a fresh pass too.
  await handover(["config", "--template", tpl], io);
  await handover(
    ["test", "--marker-file", markerFile, "--delay-ms", "500"],
    io,
  );
  assert.ok(tested(loadConfig(stateDir, cwd)));
  await handover(["config", "--off"], io);
  await handover(["config", "--on"], io);
  assert.equal(tested(loadConfig(stateDir, cwd)), false);

  // A failed retest of the same command removes the old pass and turns auto-clear off.
  await handover(
    [
      "config",
      "--template",
      JSON.stringify([[NODE, writer, markerFile, "{text}", "${TMUX}"]]),
    ],
    io,
  );
  (io.env as NodeJS.ProcessEnv).TMUX = "/tmp/tmux-1000/default,4242,0";
  await handover(
    ["test", "--marker-file", markerFile, "--delay-ms", "500"],
    io,
  );
  assert.ok(tested(loadConfig(stateDir, cwd)));
  assert.equal(loadConfig(stateDir, cwd).enabled, true);
  delete (io.env as NodeJS.ProcessEnv).TMUX;
  await assert.rejects(
    handover(["test", "--marker-file", markerFile], io),
    /test failed: the clear command needs TMUX/,
  );
  cfg = loadConfig(stateDir, cwd);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.pass, undefined);
  assert.match(cfg.last_test ?? "", /^failed/);

  // An interrupted test (pending past its deadline) counts as failed, never inherits the old pass.
  const t = JSON.parse(tpl);
  saveConfig(stateDir, {
    root: cwd,
    enabled: true,
    template: t,
    pending: {
      nonce: "0123456789abcdef",
      hash: templateHash(t),
      env: [],
      mode: "hook",
      deadline: Date.now() - 1,
    },
  } satisfies ClearConfig);
  cfg = loadConfig(stateDir, cwd);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.pass, undefined);
  assert.match(cfg.last_test ?? "", /did not arrive in time/);
  await Promise.all(launched);
});

test("H27: a retest revokes the old pass before touching anything; any failure leaves auto-clear off and clear types nothing", async () => {
  const revoked = (r: ReturnType<typeof ready>, why: RegExp, name: string) => {
    const cfg = loadConfig(r.stateDir, r.cwd);
    assert.equal(cfg.enabled, false, `${name}: auto-clear off`);
    assert.equal(cfg.pass, undefined, `${name}: no pass`);
    assert.equal(cfg.pending, undefined, `${name}: no test running`);
    assert.match(cfg.last_test ?? "", why, name);
  };
  const scratch = mkdtempSync(join(tmpdir(), "hawl-mark-bad-"));
  const dirTarget = join(scratch, "a-folder");
  mkdirSync(dirTarget);
  const cases: [string, string[], RegExp][] = [
    ["marker file is a folder", ["--marker-file", dirTarget], /is a folder/],
    [
      "marker file's folder is missing",
      ["--marker-file", join(scratch, "nope", "m.txt")],
      /folder does not exist/,
    ],
    ["marker file path is bad", ["--marker-file", "bad\0path"], /^failed: /],
    ["bad delay", ["--delay-ms", "5"], /--delay-ms must be/],
  ];
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const ro = join(scratch, "read-only");
    mkdirSync(ro);
    chmodSync(ro, 0o555);
    cases.push([
      "marker file's folder is read-only",
      ["--marker-file", join(ro, "m.txt")],
      /permission denied/,
    ]);
  }
  for (const [name, args, why] of cases) {
    const r = ready();
    await assert.rejects(
      handover(["test", ...args], r.io),
      /^Error: test failed: .*Auto-clear is off/,
      name,
    );
    assert.equal(r.launched.length, 0, `${name}: nothing launched`);
    revoked(r, why, name);
    // The old pass is gone, so a later clear refuses and types nothing.
    await assert.rejects(handover(["clear"], r.io), /auto-clear is off/, name);
    await Promise.all(r.runs);
    assert.deepEqual(typed(r.f.log), [], `${name}: nothing typed`);
  }

  // An error after the revocation (here: the clear step cannot start) leaves it revoked too.
  const r = ready();
  r.io.launch = () => {
    throw new Error("cannot start the clear step from this install of hawl");
  };
  await assert.rejects(
    handover(["test"], r.io),
    /test failed: cannot start the clear step/,
  );
  revoked(r, /cannot start the clear step/, "launch throws");

  // While a test runs, the old pass is already gone and auto-clear is off.
  const armed = ready();
  armed.io.launch = (p: TyperPayload) => void armed.launched.push(p);
  assert.equal(await handover(["test"], armed.io), 0);
  const during = loadConfig(armed.stateDir, armed.cwd);
  assert.equal(during.enabled, false);
  assert.equal(during.pass, undefined);
  assert.equal(during.pending?.enabled_before, true);
  await assert.rejects(handover(["clear"], armed.io), /auto-clear is off/);
  // A full pass turns it back on only because it was on before the retest.
  const marker = armed.launched[0]?.steps[0]?.[5] as string;
  assert.match(hookMarker(armed.stateDir, armed.cwd, marker) ?? "", /PASSED/);
  assert.equal(loadConfig(armed.stateDir, armed.cwd).enabled, true);
  assert.ok(tested(loadConfig(armed.stateDir, armed.cwd)));

  // Off before the retest: a pass stores the pass but leaves it off.
  const off = ready();
  off.io.launch = (p: TyperPayload) => void off.launched.push(p);
  saveConfig(off.stateDir, {
    ...loadConfig(off.stateDir, off.cwd),
    enabled: false,
  });
  assert.equal(await handover(["test"], off.io), 0);
  const m2 = off.launched[0]?.steps[0]?.[5] as string;
  assert.match(hookMarker(off.stateDir, off.cwd, m2) ?? "", /PASSED.*off/);
  const after = loadConfig(off.stateDir, off.cwd);
  assert.ok(tested(after));
  assert.equal(after.enabled, false);
});

test("H27: hook mode: only the exact marker of the running test, in time, stores the pass", async () => {
  const cwd = folder();
  const stateDir = tmpState();
  const f = fakeTerminal();
  const launched: TyperPayload[] = [];
  const lines: string[] = [];
  const io = {
    cwd,
    stateDir,
    print: (l: string) => void lines.push(l),
    call: async () => null,
    env: { ...ENV } as NodeJS.ProcessEnv,
    launch: (p: TyperPayload) => void launched.push(p),
  };
  await handover(
    ["config", "--on", "--template", JSON.stringify(tmuxLike(f))],
    io,
  );
  assert.equal(await handover(["test"], io), 0);
  assert.match(lines.at(-1) ?? "", /Test armed\. End your turn now/);
  // The real child body types into the fake terminal: plain text and Enter in one step, an ordinary prompt.
  await runTyper({ ...ended(launched[0] as TyperPayload), delay_ms: 0 });
  const keys = typed(f.log).map((x) => x.argv);
  const marker = keys[0]?.[2] as string;
  assert.match(marker, /^hawl-handover-test-[0-9a-f]{16}$/);
  assert.deepEqual(keys, [["-t", "%7", marker, "Enter"]]);
  assert.equal(
    launched[0]?.done,
    undefined,
    "a test never marks a revision cleared",
  );

  assert.match(
    hookMarker(stateDir, cwd, "hawl-handover-test-ffffffffffffffff") ?? "",
    /does not belong/,
  );
  assert.equal(
    hookMarker(stateDir, cwd, `${marker} please`),
    undefined,
    "not exactly the marker",
  );
  assert.equal(
    hookMarker(stateDir, cwd, `/${marker}`),
    undefined,
    "the old slash form is ignored",
  );
  assert.equal(hookMarker(stateDir, cwd, "hello"), undefined);
  assert.equal(tested(loadConfig(stateDir, cwd)), false);

  // Through the real hook entry, as Claude Code would call it on the next prompt.
  const deps = {
    stateDir,
    relayUrl: undefined,
    agentToken: undefined,
    mintToken: undefined,
  };
  const plain = await hookOutput(
    "claude_code",
    "UserPromptSubmit",
    { cwd, session_id: "s0", prompt: "hello" },
    deps,
  );
  assert.ok(
    !plain.includes("handover test"),
    "an ordinary prompt is untouched",
  );
  const slash = await hookOutput(
    "claude_code",
    "UserPromptSubmit",
    { cwd, session_id: "s0", prompt: `/${marker}` },
    deps,
  );
  assert.ok(!slash.includes("handover test"), "the slash form is untouched");
  assert.equal(tested(loadConfig(stateDir, cwd)), false);
  const out = await hookOutput(
    "claude_code",
    "UserPromptSubmit",
    { cwd, session_id: "s1", prompt: `${marker}\n` },
    {
      stateDir,
      relayUrl: undefined,
      agentToken: undefined,
      mintToken: undefined,
    },
  );
  const note = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(note, /handover test PASSED/);
  assert.match(
    note,
    /not a task: reply in one short line .*just ok.*then carry on/,
    "one short ordinary turn, then carry on",
  );
  const cfg = loadConfig(stateDir, cwd);
  assert.ok(tested(cfg));
  assert.equal(cfg.pass?.mode, "hook");

  // A marker arriving after the deadline fails the test.
  await handover(["test"], io);
  const late = launched[1]?.steps[0]?.[5] as string;
  assert.match(late, /^hawl-handover-test-[0-9a-f]{16}$/);
  assert.match(
    hookMarker(stateDir, cwd, late, Date.now() + 10 * 60_000) ?? "",
    /does not belong.*failed: the test marker did not arrive in time/,
  );
  assert.equal(loadConfig(stateDir, cwd).enabled, false);
  // Hook mode needs Claude Code.
  delete io.env.CLAUDECODE;
  await assert.rejects(
    handover(["test"], io),
    /only from a Claude Code session/,
  );
});

test("H26: the clear step starts this CLI again with an argv array, never a shell", () => {
  const p = { steps: [["tmux", "send-keys", "-l", "/clear"]], delay_ms: 500 };
  const node = typerLaunch(p, {
    sea: false,
    script: "C:\\hawl\\dist\\main.js",
    execPath: "C:\\node\\node.exe",
  });
  assert.equal(node.command, "C:\\node\\node.exe");
  assert.deepEqual(node.args.slice(-4), [
    "C:\\hawl\\dist\\main.js",
    "handover",
    "_type",
    JSON.stringify(p),
  ]);
  const sea = typerLaunch(p, { sea: true, execPath: "C:\\hawl\\hawl.exe" });
  assert.deepEqual(sea, {
    command: "C:\\hawl\\hawl.exe",
    args: ["handover", "_type", JSON.stringify(p)],
  });
  assert.throws(
    () => typerLaunch(p, { sea: false, script: undefined }),
    /cannot start/,
  );
});

test("H24: one config per folder however its path is spelled; --off from any spelling stops clear from every other", async () => {
  const spellings: [string, (cwd: string) => string][] = [
    ["trailing separator", (cwd) => cwd + sep],
    ["real long path", (cwd) => realpathSync.native(cwd)],
    [
      "link to the folder",
      (cwd) => {
        const link = join(mkdtempSync(join(tmpdir(), "hawl-alias-")), "l");
        symlinkSync(
          cwd,
          link,
          process.platform === "win32" ? "junction" : "dir",
        );
        return link;
      },
    ],
  ];
  if (process.platform === "win32" || process.platform === "darwin")
    spellings.push(["other letter case", (cwd) => cwd.toUpperCase()]);
  if (process.platform === "win32")
    spellings.push([
      "\\\\?\\ prefix",
      (cwd) => `\\\\?\\${realpathSync.native(cwd)}`,
    ]);
  for (const [name, spell] of spellings) {
    const r = ready();
    const alias = { ...r.io, cwd: spell(r.cwd) };
    assert.equal(await handover(["config", "--off"], alias), 0, name);
    await assert.rejects(
      handover(["clear"], r.io),
      /auto-clear is off/,
      `${name}: --off from ${alias.cwd} stops clear from ${r.cwd}`,
    );
    assert.equal(loadConfig(r.stateDir, alias.cwd).enabled, false, name);
    await Promise.all(r.runs);
    assert.deepEqual(typed(r.f.log), [], `${name}: nothing typed`);
  }
});

test("H26: the detached clear step's output and exit go to a log in Hawl's state dir, so a failed run says why", async () => {
  const stateDir = tmpState();
  // A wrapper that hands handover() the whole argv, "handover" included: the child refuses it.
  const bad = join(mkdtempSync(join(tmpdir(), "hawl-typer-log-")), "bad.mjs");
  const mod = new URL("./handover.ts", import.meta.url).href;
  writeFileSync(
    bad,
    `const m = await import(${JSON.stringify(mod)});\nawait m.handover(process.argv.slice(2), m.realIo());\n`,
  );
  const p = { steps: [["tmux", "send-keys", "-l", "/clear"]], delay_ms: 500 };
  launchTyper(p, stateDir, { sea: false, script: bad });
  const log = join(stateDir, "handover-typer.log");
  const until = Date.now() + 15_000;
  const read = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  while (!/exited \d/.test(read()) && Date.now() < until)
    await new Promise((r) => setTimeout(r, 50));
  assert.match(read(), /started .*bad\.mjs handover _type/);
  assert.match(read(), /usage: hawl handover write\|status/);
  assert.match(read(), /exited 1/);
  assert.doesNotMatch(read(), /send-keys/, "the payload is not logged");
});

test("H28: every template in the setup prompt is valid, and it says to stop on the VS Code terminal outside Windows", () => {
  const templates = SETUP_PROMPT.split("\n")
    .map((l) => /: (\[\[.*\]\])$/.exec(l)?.[1])
    .filter((x): x is string => !!x);
  assert.equal(templates.length, 5);
  for (const t of templates) parseTemplate(JSON.parse(t));
  assert.match(SETUP_PROMPT, /Windows Terminal.*hawl:windows-console/s);
  assert.match(SETUP_PROMPT, /VS Code terminal on macOS or Linux.*stop here/s);
  assert.match(SETUP_PROMPT, /ask me instead of guessing/);
});

/** The real CLI entry in a child process, with a fake helper that records the ack like the daemon. */
async function cli(
  argv: string[],
  o: { stateDir: string; cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; out: string; err: string; at: number }> {
  writeFileSync(tokenPath(o.stateDir), "tok");
  const server = createServer((s) => {
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (c: string) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      const result = {
        handover_id: HOV,
        revision: 5,
        state: "stored",
        scan: { verdict: "clean", reasons: [] },
      };
      if (req.name === "handover_put")
        recordAck(o.stateDir, req.resident_id, result);
      s.end(`${JSON.stringify({ ok: true, result })}\n`);
    });
  });
  await new Promise<void>((r) => server.listen(socketPath(o.stateDir), r));
  try {
    const main = fileURLToPath(new URL("../main.ts", import.meta.url));
    const child = spawn(NODE, [main, ...argv], {
      cwd: o.cwd,
      env: {
        ...process.env,
        CLAUDECODE: "",
        HAWL_HOME: o.stateDir,
        NO_COLOR: "1",
        ...o.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.stderr.on("data", (c) => {
      err += c;
    });
    const code = await new Promise<number | null>((r) => {
      const t = setTimeout(() => child.kill(), 20_000);
      child.on("close", (c) => {
        clearTimeout(t);
        r(c);
      });
    });
    return { code, out, err, at: Date.now() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("H25/H26 end to end: write, then clear through the real CLI; a detached child types exactly /clear once after the CLI exited, then exits", async () => {
  const cwd = folder();
  const stateDir = tmpState();
  const f = fakeTerminal();
  const t = tmuxLike(f);
  saveConfig(stateDir, {
    root: cwd,
    enabled: true,
    template: t,
    pass: {
      hash: templateHash(t),
      env: envNames(t),
      at: new Date().toISOString(),
      mode: "hook",
    },
  });
  const w = await cli(
    [
      "handover",
      "write",
      "--",
      'Goal: "x" & %PATH% $(id) hawl-handover-test-0123456789abcdef',
    ],
    { stateDir, cwd },
  );
  assert.equal(w.code, 0, w.err);
  assert.equal(readAck(stateDir, RID)?.revision, 5);

  const started = Date.now();
  const c = await cli(["handover", "clear", "--delay-ms", "800"], {
    stateDir,
    cwd,
    env: ENV,
  });
  assert.equal(c.code, 0, c.err);
  assert.match(
    c.out,
    /Clearing 0\.8 s after this turn ends \(handover revision 5\)/,
  );
  assert.deepEqual(typed(f.log), [], "nothing typed while the CLI ran");
  // H25: past the delay, still nothing: the turn has not ended. Then Claude Code's Stop hook runs.
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(typed(f.log), [], "nothing typed before the turn ended");
  const stopped = Date.now();
  await hookOutput(
    "claude_code",
    "Stop",
    { cwd, session_id: SID },
    {
      stateDir,
      relayUrl: undefined,
      agentToken: undefined,
      mintToken: undefined,
    },
  );

  const cleared = join(stateDir, "handover-acks", `${RID}.cleared`);
  const until = Date.now() + 15_000;
  while (!existsSync(cleared) && Date.now() < until)
    await new Promise((r) => setTimeout(r, 50));
  const got = typed(f.log);
  assert.deepEqual(
    got.map((x) => x.argv),
    [["-t", "%7", "/clear", "Enter"]],
  );
  assert.ok((got[0]?.t ?? 0) > c.at, "typed after the CLI had exited");
  assert.ok((got[0]?.t ?? 0) - started >= 800, "typed after the delay");
  assert.ok(
    (got[0]?.t ?? 0) - stopped >= 800,
    "typed the delay after the Stop",
  );
  assert.equal(readFileSync(cleared, "utf8"), "cleared 5\n");
  // The detached child (the fake terminal's parent) exits by itself; kill it only if it hangs.
  const typer = got[0]?.ppid as number;
  const gone = Date.now() + 5_000;
  while (alive(typer) && Date.now() < gone)
    await new Promise((r) => setTimeout(r, 50));
  const stillAlive = alive(typer);
  if (stillAlive) process.kill(typer);
  assert.equal(stillAlive, false, "the clear step exited on its own");

  // Second clear for the same revision: refused, nothing more typed.
  const again = await cli(["handover", "clear", "--delay-ms", "500"], {
    stateDir,
    cwd,
    env: ENV,
  });
  assert.equal(again.code, 1);
  assert.match(again.err, /revision 5 was already cleared: nothing typed/);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(typed(f.log).length, 1);

  // Not Claude Code: refused with the Codex reason.
  const codex = await cli(["handover", "clear"], {
    stateDir,
    cwd,
    env: { TMUX_PANE: "%7" },
  });
  assert.equal(codex.code, 1);
  assert.match(codex.err, /only from a Claude Code session/);
});

test("I2/I3: config --off during a retest cancels it; its marker turns nothing back on and clear types nothing", async () => {
  // The judge's run: a passing folder, a retest in flight, then --off, then the marker arrives.
  const r = ready();
  const runReal = r.io.launch;
  r.io.launch = (p: TyperPayload) => void r.launched.push(p);
  assert.equal(await handover(["test"], r.io), 0);
  const marker = r.launched[0]?.steps[0]?.[5] as string;
  assert.equal(await handover(["config", "--off"], r.io), 0);
  assert.match(r.lines.join("\n"), /running test was cancelled/);
  assert.match(
    hookMarker(r.stateDir, r.cwd, marker) ?? "",
    /does not belong.*cancelled/,
  );
  let cfg = loadConfig(r.stateDir, r.cwd);
  assert.equal(cfg.enabled, false, "off stays off");
  assert.equal(tested(cfg), false);
  assert.equal(cfg.pending, undefined);
  r.io.launch = runReal;
  await assert.rejects(handover(["clear"], r.io), /auto-clear is off/);
  // An explicit --on still needs a fresh passing test.
  await handover(["config", "--on"], r.io);
  await assert.rejects(handover(["clear"], r.io), /has not passed/);
  await Promise.all(r.runs);
  assert.deepEqual(typed(r.f.log), [], "nothing typed");

  // The same through test --marker-file: the waiting test sees it was cancelled and stores nothing.
  const dir = mkdtempSync(join(tmpdir(), "hawl-mark-off-"));
  const writer = join(dir, "write-marker.mjs");
  writeFileSync(
    writer,
    'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], process.argv[3]);\n',
  );
  const markerFile = join(dir, "marker.txt");
  const m = ready();
  const children: TyperPayload[] = [];
  m.io.launch = (p: TyperPayload) => void children.push(p);
  await handover(
    [
      "config",
      "--template",
      JSON.stringify([[NODE, writer, markerFile, "{text}"]]),
    ],
    m.io,
  );
  const first = handover(["test", "--marker-file", markerFile], m.io);
  await runTyper({ ...ended(children[0] as TyperPayload), delay_ms: 0 });
  assert.equal(await first, 0);
  assert.ok(tested(loadConfig(m.stateDir, m.cwd)));
  assert.equal(loadConfig(m.stateDir, m.cwd).enabled, true);
  const retest = handover(["test", "--marker-file", markerFile], m.io);
  await handover(["config", "--off"], m.io);
  await runTyper({ ...ended(children[1] as TyperPayload), delay_ms: 0 });
  await assert.rejects(retest, /test cancelled/);
  cfg = loadConfig(m.stateDir, m.cwd);
  assert.equal(cfg.enabled, false);
  assert.equal(tested(cfg), false);
});

/**
 * H25: the clear step types only once Claude Code's turn has ended (its Stop hook), never into a
 * running turn or a dialog that turn opened (a permission prompt would take the Enter). Bounded: no
 * Stop newer than the clear within the wait, or a new turn after that Stop, types nothing.
 */
test("H25: the clear step waits for this session's Stop of the armed turn; no Stop, an old Stop or any later turn start types nothing", async () => {
  const run = async (o: {
    before?: [string, number][];
    during?: [string, number, number][];
    delay?: number;
  }) => {
    const r = ready();
    const p: TyperPayload[] = [];
    r.io.launch = (x: TyperPayload) => void p.push(x);
    const t0 = Date.now();
    assert.equal(await handover(["clear"], r.io), 0);
    const x = p[0] as TyperPayload;
    assert.ok(x.turn, "clear always waits for the turn to end");
    assert.equal(x.turn.root, r.cwd);
    assert.equal(x.turn.session, SID);
    // Since this process started: a Stop that lands while `clear` itself starts up still counts.
    assert.equal(x.turn.since, Math.floor(performance.timeOrigin));
    assert.ok(x.turn.since < t0);
    assert.equal(x.turn.wait_ms, TURN_WAIT_MS);
    assert.equal(x.turn.armed, 0, "no turn recorded yet in this folder");
    const note = (event: string, dt: number) => {
      const [ev, sid] = event.split("@");
      noteTurn(r.stateDir, r.cwd, sid ?? SID, ev as string, x.turn!.since + dt);
    };
    for (const [event, dt] of o.before ?? []) note(event, dt);
    const timers = (o.during ?? []).map(([event, dt, after]) =>
      setTimeout(() => note(event, dt), after),
    );
    await runTyper({
      ...x,
      delay_ms: o.delay ?? 0,
      turn: { ...x.turn, wait_ms: 1500 },
    });
    timers.forEach(clearTimeout);
    return {
      keys: typed(r.f.log).map((k) => k.argv),
      done: lastCleared(r.stateDir, RID) ?? "",
    };
  };
  const both = [["-t", "%7", "/clear", "Enter"]];
  // Stop after the clear: typed.
  assert.deepEqual((await run({ before: [["Stop", 5]] })).keys, both);
  // The Stop lands while the child waits: typed then.
  assert.deepEqual((await run({ during: [["Stop", 400, 300]] })).keys, both);
  // No Stop at all, only a Stop from before this process, or only another session's Stop:
  // nothing typed, and it says why.
  for (const before of [[], [["Stop", -50]], [["Stop@other-session", 5]]] as [
    string,
    number,
  ][][]) {
    const r = await run({ before });
    assert.deepEqual(r.keys, []);
    assert.match(
      r.done,
      /^skipped 3: Claude Code's turn did not end within 1\.5 s/,
    );
  }
  // Any turn start after arming cancels, even when a Stop follows it (judge j2 #2: start, start,
  // Stop), and so does a Stop that Hawl's own Stop hook turned into a continue.
  for (const before of [
    [["StopBlocked", 5]],
    [
      ["UserPromptSubmit", 1],
      ["Stop", 5],
    ],
    [
      ["Stop", 2],
      ["UserPromptSubmit", 3],
      ["PreToolUse", 4],
      ["Stop", 5],
    ],
  ] as [string, number][][]) {
    const r = await run({ before });
    assert.deepEqual(r.keys, [], JSON.stringify(before));
    assert.match(r.done, /^skipped 3: a new turn started/);
  }
  // A turn after the Stop (a prompt typed, a tool about to run) before the keys: nothing typed.
  for (const event of ["UserPromptSubmit", "PreToolUse"]) {
    const r = await run({
      before: [["Stop", 5]],
      during: [[event, 10, 100]],
      delay: 400,
    });
    assert.deepEqual(r.keys, [], event);
    assert.match(r.done, /^skipped 3: a new turn started/, event);
  }
  // Another session's turn in the same folder changes nothing for this one.
  assert.deepEqual(
    (
      await run({
        before: [["Stop", 5]],
        during: [["PreToolUse@other-session", 10, 100]],
        delay: 400,
      })
    ).keys,
    both,
  );
});

test("H25: Claude Code's hooks count each session's turn starts and record the Stop of the current one", async () => {
  const cwd = folder();
  const stateDir = tmpState();
  const deps = {
    stateDir,
    relayUrl: undefined,
    agentToken: undefined,
    mintToken: undefined,
  };
  const hook = (
    event: string,
    input: Record<string, unknown>,
    d: HookDeps = deps,
  ) =>
    hookOutput("claude_code", event, { cwd, tool_name: "Bash", ...input }, d);
  const turn = (sid: string) => {
    const t = readTurn(stateDir, cwd, sid);
    return t && { turn: t.turn, stopped: t.stopped };
  };
  assert.equal(readTurn(stateDir, cwd, "s1"), undefined);
  const t0 = Date.now();
  await hook("PreToolUse", { session_id: "s1" });
  assert.deepEqual(turn("s1"), { turn: 1, stopped: -1 });
  await hook("Stop", { session_id: "s1" });
  assert.deepEqual(turn("s1"), { turn: 1, stopped: 1 });
  const at = readTurn(stateDir, cwd, "s1")?.stop_at ?? 0;
  assert.ok(at >= t0 && at <= Date.now());
  await hook("UserPromptSubmit", { session_id: "s1", prompt: "hi" });
  assert.deepEqual(turn("s1"), { turn: 2, stopped: 1 });
  await hook("Stop", { session_id: "s1" });
  assert.deepEqual(turn("s1"), { turn: 2, stopped: 2 });
  // Codex never clears, so its hooks leave the turn alone; other events do too.
  await hookOutput(
    "codex",
    "UserPromptSubmit",
    { cwd, session_id: "s2", prompt: "x" },
    deps,
  );
  await hook("PostToolUse", { session_id: "s1" });
  assert.deepEqual(turn("s1"), { turn: 2, stopped: 2 });
  // Each session has its own record: s2's prompt above left s1 alone and wrote none for s2.
  assert.equal(readTurn(stateDir, cwd, "s2"), undefined);
  // When Hawl's Stop hook continues Claude (mail aimed at it), the turn goes on: a new start.
  const out = await hook(
    "Stop",
    { session_id: "s4" },
    {
      ...deps,
      relayUrl: "http://127.0.0.1:9",
      agentToken: "t",
      fetch: async () => new Response(JSON.stringify({ unread: 1, aimed: 1 })),
    },
  );
  assert.match(out, /"decision":"block"/);
  assert.deepEqual(turn("s4"), { turn: 1, stopped: -1 });
  // Judge j2 #1: with the machine-wide twin installed, the same prompt typed again is a duplicate
  // for the notices, but it still starts a new turn.
  writeFileSync(join(stateDir, "user-scope.json"), "{}");
  await hook("UserPromptSubmit", { session_id: "s5", prompt: "go on" });
  await hook("Stop", { session_id: "s5" });
  await hook("UserPromptSubmit", { session_id: "s5", prompt: "go on" });
  assert.deepEqual(turn("s5"), { turn: 2, stopped: 1 });
});

test("I6: the clear child reads the config again right before typing; --off after clear types nothing", async () => {
  const r = ready();
  const p: TyperPayload[] = [];
  r.io.launch = (x: TyperPayload) => void p.push(x);
  assert.equal(await handover(["clear"], r.io), 0);
  assert.equal(await handover(["config", "--off"], r.io), 0);
  await runTyper({ ...ended(p[0] as TyperPayload), delay_ms: 0 });
  assert.deepEqual(typed(r.f.log), []);
  assert.match(
    lastCleared(r.stateDir, RID) ?? "",
    /^skipped 3: auto-clear is off/,
  );
  // An --off that lands while an earlier step runs stops every later step (judge #21: the Enter step).
  const mid = ready();
  const q: TyperPayload[] = [];
  mid.io.launch = (x: TyperPayload) => void q.push(x);
  assert.equal(await handover(["clear"], mid.io), 0);
  const off = nodeScript(`
import { configure, updateConfig } from MOD;
const [stateDir, root] = process.argv.slice(2);
updateConfig(stateDir, root, (c) => configure(c, { off: true }));
`);
  const steps = (q[0] as TyperPayload).steps;
  await runTyper({
    ...ended(q[0] as TyperPayload),
    steps: [[NODE, off, mid.stateDir, mid.cwd], steps[0] as string[]],
    delay_ms: 0,
  });
  assert.deepEqual(
    typed(mid.f.log).map((x) => x.argv),
    [],
    "the typing step after the --off never ran",
  );
  assert.match(
    lastCleared(mid.stateDir, RID) ?? "",
    /^skipped 3: auto-clear is off/,
  );
  // Untouched config: the child types /clear once.
  const ok = ready();
  assert.equal(await handover(["clear"], ok.io), 0);
  await Promise.all(ok.runs);
  assert.equal(typed(ok.f.log).length, 1);
  assert.equal(lastCleared(ok.stateDir, RID), "cleared 3");
  assert.throws(
    () =>
      parsePayload(
        JSON.stringify({
          steps: [["x"]],
          delay_ms: 500,
          guard: { state_dir: 1 },
        }),
      ),
    /bad clear payload/,
  );
});

/**
 * Model check of the auto-clear rules I1-I6 (top of handover-clear.ts). Every ordering of DEPTH
 * events, from a folder that is on, tested and holds one stored handover, runs against the real
 * config functions in memory. The fake terminal is the clear child's last check (typeRefusal) plus
 * a count of what it would type. No files, children, sleeps or real clock. Beside the code under
 * test runs an oracle of what the owner asked for (`want`, `on`, `live`, `restores`, `passOk`).
 *
 * | Rule | Asserted after every event of every ordering                                                                        |
 * | ---- | ------------------------------------------------------------------------------------------------------------------- |
 * | I1   | a test start, a template change, or --on/--off that changes or cancels raises `version`; markers and expiry do not   |
 * | I2   | a marker of a cancelled, replaced or expired test changes nothing; the config's running test is the oracle's `live` |
 * | I3   | auto-clear is on exactly when the oracle says so, and never after --off until an explicit --on                      |
 * | I4   | `enabled_before` exists only on a running test                                                                      |
 * | I5   | a usable pass (on and tested) exists exactly when the live test's marker arrived and no explicit change came after  |
 * | I6   | /clear is typed at most once per revision, only when at that instant auto-clear is on, tested, and the oracle agrees |
 * | fail | a running, failed or interrupted test means auto-clear off with no pass                                             |
 */
const EVENTS = [
  "test-hook",
  "test-file",
  "marker",
  "off",
  "on",
  "template",
  "clear",
  "crash",
  "expire",
] as const;
type Ev = (typeof EVENTS)[number];
const TA: Template = [["fake-term", "{text}"]];
const TB: Template = [["fake-term", "-x", "{text}"]];
interface Model {
  cfg: ClearConfig;
  now: number;
  n: number;
  /** Detached children not yet run: a test marker, or a clear that saw config version `clear`. */
  kids: ({ nonce: string; mode: "hook" | "marker-file" } | { clear: number })[];
  /** The Claude Code session whose hook would read a hook marker. */
  session: boolean;
  /** The nonce a running `test --marker-file` process still waits for. */
  loop: string | null;
  claimed: boolean;
  typed: number;
  // Oracle: the owner's last switch, the effective switch, the running test, what its pass restores.
  want: boolean;
  on: boolean;
  live: string | null;
  restores: boolean;
  passOk: boolean;
}

function modelStep(m: Model, e: Ev): Model {
  // Every command starts with loadConfig, which records an expired test as failed.
  const x: Model = { ...m, cfg: expire(m.cfg, m.now), kids: [...m.kids] };
  const was = x.cfg;
  const v0 = was.version ?? 0;
  let explicit = false;
  const config = (c: Parameters<typeof configure>[1]) => {
    const next = configure(was, c);
    if (next) {
      x.cfg = next;
      explicit = true;
    }
  };
  switch (e) {
    case "test-hook":
    case "test-file": {
      const mode = e === "test-hook" ? "hook" : "marker-file";
      const nonce = (x.n++).toString(16).padStart(16, "0");
      x.cfg = beginTest(was, mode, nonce, testDeadline(1500, x.now));
      explicit = true;
      x.kids.push({ nonce, mode });
      if (mode === "hook") x.session = true;
      else x.loop = nonce;
      x.restores = x.on;
      x.on = false;
      x.live = nonce;
      x.passOk = false;
      break;
    }
    case "off":
      config({ off: true });
      x.want = false;
      x.on = false;
      x.live = null;
      x.passOk = false;
      break;
    case "on":
      config({ on: true });
      x.passOk = x.passOk && x.on && !x.live;
      x.want = true;
      x.on = true;
      x.live = null;
      break;
    case "template":
      config({ template: was.template === TA ? TB : TA });
      x.live = null;
      x.passOk = false;
      break;
    case "clear":
      if (!clearRefusal(was) && !x.claimed) {
        x.claimed = true;
        x.kids.push({ clear: v0 });
      }
      break;
    case "crash":
      x.session = false;
      x.loop = null;
      break;
    case "expire":
      x.now += TURN_WAIT_MS + 20_000;
      x.cfg = expire(was, x.now);
      if (x.live) {
        assert.match(x.cfg.last_test ?? "", /^failed/, "an expired test fails");
        x.live = null;
      }
      break;
    case "marker":
      for (const k of x.kids) {
        if ("clear" in k) {
          const cfg = expire(x.cfg, x.now);
          x.cfg = cfg;
          if (typeRefusal(cfg, k.clear)) continue;
          x.typed++;
          assert.ok(x.typed <= 1, "I6: /clear at most once per revision");
          assert.ok(
            cfg.enabled && tested(cfg),
            "I6: typed only when on and tested",
          );
          assert.ok(
            x.on && x.passOk,
            "I6: typed only when the owner's state allows it",
          );
          continue;
        }
        if (k.mode === "hook" ? !x.session : x.loop !== k.nonce) continue;
        if (k.mode === "marker-file") x.loop = null;
        const out = finishTest(x.cfg, k.nonce, k.mode, new Date(x.now));
        if (k.nonce !== x.live) {
          assert.equal(
            out,
            undefined,
            "I2: a stale test's marker changes nothing",
          );
          continue;
        }
        assert.ok(out?.pass, "I5: the live test's marker stores a pass");
        x.cfg = out;
        x.live = null;
        x.on = x.restores;
        x.passOk = true;
      }
      x.kids = [];
      break;
  }
  const cfg = x.cfg;
  const v = cfg.version ?? 0;
  if (explicit) assert.ok(v > v0, "I1: an explicit change raises the version");
  else assert.equal(v, v0, "I1: only explicit changes move the version");
  assert.equal(
    cfg.pending?.nonce ?? null,
    x.live,
    "I2: the running test is the live one",
  );
  assert.equal(
    cfg.enabled,
    x.on,
    "I3: auto-clear on exactly when the owner's state says so",
  );
  assert.ok(!cfg.enabled || x.want, "I3: never on after --off without --on");
  assert.ok(
    cfg.pending || !JSON.stringify(cfg).includes("enabled_before"),
    "I4: enabled_before only on a running test",
  );
  assert.equal(cfg.enabled && tested(cfg), x.on && x.passOk, "I5: usable pass");
  if (cfg.pending)
    assert.ok(!cfg.enabled && !cfg.pass, "a running test means off, no pass");
  return x;
}

test("I1-I6 model: every ordering of 6 events keeps the auto-clear rules", () => {
  const DEPTH = 6;
  const start: Model = {
    cfg: {
      root: "/model",
      enabled: true,
      template: TA,
      pass: {
        hash: templateHash(TA),
        env: [],
        at: "2026-10-21T10:00:00.000Z",
        mode: "hook",
      },
    },
    now: Date.UTC(2026, 9, 21, 10),
    n: 1,
    kids: [],
    session: true,
    loop: null,
    claimed: false,
    typed: 0,
    want: true,
    on: true,
    live: null,
    restores: false,
    passOk: true,
  };
  const trail: Ev[] = [];
  let orderings = 0;
  let typedRuns = 0;
  const walk = (m: Model) => {
    if (trail.length === DEPTH) {
      orderings++;
      if (m.typed) typedRuns++;
      return;
    }
    for (const e of EVENTS) {
      trail.push(e);
      let next: Model;
      try {
        next = modelStep(m, e);
      } catch (err) {
        throw new Error(
          `${(err as Error).message}\n  after: ${trail.join(", ")}`,
        );
      }
      walk(next);
      trail.pop();
    }
  };
  walk(start);
  assert.equal(orderings, EVENTS.length ** DEPTH);
  assert.ok(typedRuns > 0, "some orderings do clear");
  console.log(
    `model: ${orderings} orderings of ${DEPTH} events checked, ${typedRuns} typed /clear`,
  );
});

/** A node script in its own scratch folder that imports this CLI's handover-clear module. */
const MOD = new URL("./handover-clear.ts", import.meta.url).href;
function nodeScript(body: string): string {
  const f = join(mkdtempSync(join(tmpdir(), "hawl-race-")), "s.mjs");
  writeFileSync(f, body.replaceAll("MOD", JSON.stringify(MOD)));
  return f;
}
/** Run it bounded: killed at the timeout, resolved only once the process has exited. */
function runNode(
  script: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const p = spawn(NODE, [script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const kill = setTimeout(() => p.kill(), timeoutMs);
    p.on("close", (code) => {
      clearTimeout(kill);
      res({ code, out });
    });
  });
}

/** A ready folder with a hook-mode test running (auto-clear was on before it). Returns the marker. */
async function armedTest() {
  const r = ready();
  r.io.launch = (p: TyperPayload) => void r.launched.push(p);
  assert.equal(await handover(["test"], r.io), 0);
  return { ...r, marker: r.launched[0]?.steps[0]?.[5] as string };
}

function assertOffAfterCancel(r: { stateDir: string; cwd: string }) {
  const cfg = loadConfig(r.stateDir, r.cwd);
  assert.equal(cfg.enabled, false, "the explicit --off wins");
  assert.equal(cfg.pass, undefined, "the cancelled test stored no pass");
  assert.equal(cfg.pending, undefined);
  assert.match(cfg.last_test ?? "", /^cancelled/);
}

test("race: an --off made while a test completion sits between its read and its write wins", async () => {
  const r = await armedTest();
  let gaps = 0;
  let inner = false;
  testHooks.gap = () => {
    if (inner) return;
    // The owner's --off lands inside the completion's read-modify-write gap (the CLI path runs synchronously).
    if (gaps++ === 0) {
      inner = true;
      try {
        void handover(["config", "--off"], r.io);
      } finally {
        inner = false;
      }
    }
  };
  let note: string | undefined;
  try {
    note = hookMarker(r.stateDir, r.cwd, r.marker);
  } finally {
    delete testHooks.gap;
  }
  assertOffAfterCancel(r);
  assert.ok(
    gaps >= 2,
    `the stale completion re-read and retried (gaps ${gaps})`,
  );
  assert.match(note ?? "", /does not belong.*cancelled.*Nothing changed/);
  await assert.rejects(handover(["clear"], r.io), /auto-clear is off/);
});

test("race, two processes: an --off made while another process's test completion is paused in its gap wins", async () => {
  const r = await armedTest();
  const sig = join(mkdtempSync(join(tmpdir(), "hawl-race-sig-")), "paused");
  const script = nodeScript(`
import { writeFileSync } from "node:fs";
import { hookMarker, testHooks } from MOD;
const [stateDir, root, marker, sig] = process.argv.slice(2);
let gaps = 0;
testHooks.gap = () => {
  if (gaps++ === 0) {
    writeFileSync(sig, "1");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  }
};
const note = hookMarker(stateDir, root, marker);
process.stdout.write(JSON.stringify({ note, gaps }));
`);
  const child = runNode(script, [r.stateDir, r.cwd, r.marker, sig]);
  const until = Date.now() + 15_000;
  while (!existsSync(sig) && Date.now() < until)
    await new Promise((res) => setTimeout(res, 20));
  assert.ok(existsSync(sig), "the completion paused between read and write");
  assert.equal(await handover(["config", "--off"], r.io), 0);
  const { code, out } = await child;
  assert.equal(code, 0, out);
  const res = JSON.parse(out) as { note: string; gaps: number };
  assertOffAfterCancel(r);
  assert.ok(res.gaps >= 2, `the stale completion retried (gaps ${res.gaps})`);
  assert.match(res.note, /does not belong.*Nothing changed/);
});

test("race, two processes for ~1 s: --on/--off in one, test start/finish in the other; no lost update", async () => {
  const r = ready();
  const ms = "1000";
  const dir = mkdtempSync(join(tmpdir(), "hawl-race-log-"));
  // Random short pauses inside updateConfig's gap make interleavings likely.
  const jitter = `const nap = () => { if (Math.random() < 0.5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(Math.random() * 3)); };
testHooks.gap = nap;
testHooks.commit = nap;`;
  const switcher = nodeScript(`
import { writeFileSync } from "node:fs";
import { configure, testHooks, updateConfig } from MOD;
const [stateDir, root, ms, out] = process.argv.slice(2);
${jitter}
const log = [];
const end = Date.now() + Number(ms);
while (Date.now() < end) {
  const op = Math.random() < 0.5 ? "on" : "off";
  const r = updateConfig(stateDir, root, (c) => configure(c, { [op]: true }));
  log.push({ op, changed: r.changed, v: r.after.version ?? 0 });
}
writeFileSync(out, JSON.stringify(log));
`);
  const tester = nodeScript(`
import { writeFileSync } from "node:fs";
import { beginTest, hookMarker, newNonce, testDeadline, testHooks, updateConfig } from MOD;
const [stateDir, root, ms, out] = process.argv.slice(2);
${jitter}
const log = [];
const nonces = [];
const end = Date.now() + Number(ms);
while (Date.now() < end) {
  const nonce = newNonce();
  const b = updateConfig(stateDir, root, (c) => beginTest(c, "hook", nonce, testDeadline(1500)));
  log.push({ op: "begin", nonce, changed: b.changed, v: b.after.version ?? 0 });
  nonces.push(nonce);
  // A third of the completions are stale: the marker of an older test arrives late.
  const late = Math.random() < 0.33 ? nonces[Math.floor(Math.random() * nonces.length)] : nonce;
  const note = hookMarker(stateDir, root, "hawl-handover-test-" + late) ?? "";
  log.push({ op: "finish", nonce: late, passed: /PASSED/.test(note) });
}
writeFileSync(out, JSON.stringify(log));
`);
  const outs = [join(dir, "switch.json"), join(dir, "test.json")];
  const runs = await Promise.all([
    runNode(switcher, [r.stateDir, r.cwd, ms, outs[0] as string]),
    runNode(tester, [r.stateDir, r.cwd, ms, outs[1] as string]),
  ]);
  for (const x of runs) assert.equal(x.code, 0, x.out);
  type Entry = {
    op: "on" | "off" | "begin" | "finish";
    changed?: boolean;
    v?: number;
    nonce?: string;
    passed?: boolean;
  };
  const [sw, ts] = outs.map(
    (f) => JSON.parse(readFileSync(f, "utf8")) as Entry[],
  ) as [Entry[], Entry[]];
  for (const log of [sw, ts]) {
    const vs = log.filter((e) => e.v !== undefined).map((e) => e.v as number);
    vs.forEach((v, i) =>
      assert.ok(i === 0 || v >= (vs[i - 1] as number), "version monotonic"),
    );
  }
  const explicit = [...sw, ...ts].filter((e) => e.changed && e.op !== "finish");
  const vs = explicit.map((e) => e.v as number).sort((a, b) => a - b);
  // Every explicit change raised the version by exactly one: a lost update would repeat or skip a number.
  assert.deepEqual(
    vs,
    vs.map((_, i) => i + 1),
    "each explicit change got its own version",
  );
  assert.ok(vs.length > 20, `both processes hammered (${vs.length} changes)`);
  const final = loadConfig(r.stateDir, r.cwd);
  assert.equal(final.version, vs.length, "the final config is the last change");
  const byV = new Map(explicit.map((e) => [e.v, e]));
  const lastSwitch = explicit
    .filter((e) => e.op !== "begin")
    .sort((a, b) => (b.v as number) - (a.v as number))[0];
  if (lastSwitch?.op === "off")
    assert.equal(final.enabled, false, "the last explicit --off wins");
  if (final.enabled) assert.equal(lastSwitch?.op, "on", "on only after --on");
  if (tested(final)) {
    // A usable pass belongs to the test that started at the current version and passed.
    const e = byV.get(final.version);
    assert.equal(e?.op, "begin");
    assert.ok(
      ts.some((x) => x.op === "finish" && x.nonce === e?.nonce && x.passed),
    );
  }
  assert.ok(
    !final.pending || (!final.enabled && !final.pass),
    "a running test means off, no pass",
  );
  // I7: the stored history has no gaps, and every slot is one legal event applied to the slot before.
  const hist = configHistory(r.stateDir, r.cwd);
  hist.forEach((h, i) => assert.equal(h.seq, i + 1, "slots have no gaps"));
  for (let i = 1; i < hist.length; i++)
    assertLegalStep(
      (hist[i - 1] as { cfg: ClearConfig }).cfg,
      (hist[i] as { cfg: ClearConfig }).cfg,
      i + 1,
    );
  console.log(
    `hammer: ${vs.length} explicit changes, ${ts.filter((x) => x.passed).length} passes, ${hist.length} slots all legal, final ${final.enabled ? "on" : "off"} v${final.version}`,
  );
});

/**
 * One stored step is legal when auto-clear comes back on only by an explicit --on (a new version,
 * no pass, no test) or by the running test of that same version passing with enabled_before, and a
 * usable pass appears only by that test passing (I2, I3, I5).
 */
function assertLegalStep(prev: ClearConfig, next: ClearConfig, slot: number) {
  const pv = prev.version ?? 0;
  const nv = next.version ?? 0;
  assert.ok(nv >= pv, `slot ${slot}: the version never goes back`);
  const ownPass =
    !!prev.pending &&
    prev.pending.version === pv &&
    nv === pv &&
    next.last_test === "passed" &&
    next.pass?.version === pv;
  if (next.enabled && !prev.enabled)
    assert.ok(
      (nv === pv + 1 && !next.pass && !next.pending) ||
        (ownPass && prev.pending?.enabled_before === true),
      `slot ${slot}: auto-clear came back on without --on or its own test passing: ${JSON.stringify({ prev, next })}`,
    );
  if (
    tested(next) &&
    !(tested(prev) && JSON.stringify(prev.pass) === JSON.stringify(next.pass))
  )
    assert.ok(
      ownPass,
      `slot ${slot}: a usable pass appeared without the running test passing: ${JSON.stringify({ prev, next })}`,
    );
}

test("I7: a writer paused at either read-then-write point while --off lands loses its slot; --off wins and clear types nothing", async () => {
  type R = Awaited<ReturnType<typeof armedTest>>;
  const writers: Record<string, (r: R) => unknown> = {
    "hook test completion": (r) => hookMarker(r.stateDir, r.cwd, r.marker),
    "marker-file style completion": (r) =>
      updateConfig(r.stateDir, r.cwd, (c) =>
        finishTest(c, r.marker.slice(19), "hook", new Date()),
      ),
    "test start": (r) =>
      updateConfig(r.stateDir, r.cwd, (c) =>
        beginTest(c, "hook", newNonce(), testDeadline(1500)),
      ),
    "config --on": (r) => handover(["config", "--on"], r.io),
    "config --template": (r) =>
      handover(
        [
          "config",
          "--template",
          JSON.stringify([...r.t, [NODE, r.f.script, r.f.log, "noop"]]),
        ],
        r.io,
      ),
    "expiry of the running test": (r) =>
      loadConfig(r.stateDir, r.cwd, Date.now() + TURN_WAIT_MS + 60_000),
  };
  let rows = 0;
  for (const point of ["gap", "commit"] as const)
    for (const [name, write] of Object.entries(writers)) {
      const r = await armedTest();
      let reads = 0;
      let paused = false;
      let inner = false;
      const pause = () => {
        if (inner || paused) return;
        paused = true;
        inner = true;
        try {
          // The owner's --off lands while this writer is paused (the CLI path runs synchronously).
          void handover(["config", "--off"], r.io);
        } finally {
          inner = false;
        }
      };
      testHooks.gap = () => {
        if (!inner) reads++;
        if (point === "gap") pause();
      };
      if (point === "commit") testHooks.commit = pause;
      const before = configHistory(r.stateDir, r.cwd).length;
      try {
        await write(r);
      } finally {
        delete testHooks.gap;
        delete testHooks.commit;
      }
      const row = `${name}, paused at ${point}`;
      assert.ok(paused, `${row}: the pause point was reached`);
      assert.ok(reads >= 2, `${row}: the writer lost its slot and read again`);
      const hist = configHistory(r.stateDir, r.cwd);
      assert.ok(hist.length > before, `${row}: --off was stored`);
      for (let i = 1; i < hist.length; i++)
        assertLegalStep(
          (hist[i - 1] as { cfg: ClearConfig }).cfg,
          (hist[i] as { cfg: ClearConfig }).cfg,
          i + 1,
        );
      const cfg = loadConfig(r.stateDir, r.cwd);
      assert.equal(tested(cfg), false, `${row}: no usable pass`);
      // A paused --on that lands after the --off is the owner's newest choice, and it still needs a fresh test.
      if (name !== "config --on")
        assert.equal(cfg.enabled, false, `${row}: the explicit --off wins`);
      await assert.rejects(
        handover(["clear"], r.io),
        name === "config --on" ? /has not passed/ : /auto-clear is off/,
        row,
      );
      await Promise.all(r.runs);
      assert.deepEqual(typed(r.f.log), [], `${row}: nothing typed`);
      rows++;
    }
  assert.equal(rows, 12);
});

test("I7, two processes: a test completion paused 6.5 s right before its write (past the old 5 s lock window) cannot undo a real --off", async () => {
  const r = await armedTest();
  const sig = join(mkdtempSync(join(tmpdir(), "hawl-race-sig-")), "paused");
  const script = nodeScript(`
import { writeFileSync } from "node:fs";
import { hookMarker, testHooks } from MOD;
const [stateDir, root, marker, sig] = process.argv.slice(2);
let reads = 0;
let commits = 0;
testHooks.gap = () => void reads++;
testHooks.commit = () => {
  if (commits++ === 0) {
    writeFileSync(sig, "1");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
  }
};
const note = hookMarker(stateDir, root, marker);
process.stdout.write(JSON.stringify({ note, reads, commits }));
`);
  const child = runNode(script, [r.stateDir, r.cwd, r.marker, sig], 30_000);
  const until = Date.now() + 15_000;
  while (!existsSync(sig) && Date.now() < until)
    await new Promise((res) => setTimeout(res, 20));
  assert.ok(
    existsSync(sig),
    "the completion paused after deciding, right before its write",
  );
  const t0 = Date.now();
  assert.equal(await handover(["config", "--off"], r.io), 0);
  const offMs = Date.now() - t0;
  assert.ok(
    offMs < 2000,
    `--off did not wait for the paused writer (${offMs} ms)`,
  );
  const { code, out } = await child;
  assert.equal(code, 0, out);
  const res = JSON.parse(out) as { note: string; reads: number };
  assertOffAfterCancel(r);
  assert.ok(
    res.reads >= 2,
    `the paused completion lost its slot and read again (reads ${res.reads})`,
  );
  assert.match(res.note, /does not belong.*Nothing changed/);
  await assert.rejects(handover(["clear"], r.io), /auto-clear is off/);
  await Promise.all(r.runs);
  assert.deepEqual(typed(r.f.log), [], "nothing typed");
  console.log(
    `paused 6.5 s: --off took ${offMs} ms; the woken completion changed nothing`,
  );
});

/**
 * Judge j3 #1: hooks of one session overlap (a Stop while a subagent's tool call starts). No writer may
 * erase another's turn start: two processes, one counting starts and one recording Stops at the same
 * time, end with every start counted, and a Stop never claims a turn that started after it read.
 */
test("H25: overlapping hook processes never erase a turn start", async () => {
  const cwd = folder();
  const stateDir = tmpState();
  const N = 300;
  const writer = nodeScript(`
import { noteTurn } from MOD;
const [stateDir, root, event, n, at] = process.argv.slice(2);
while (Date.now() < Number(at)) {}
for (let i = 0; i < Number(n); i++) noteTurn(stateDir, root, "s-race", event);
`);
  const at = String(Date.now() + 1500);
  const [a, b] = await Promise.all([
    runNode(writer, [stateDir, cwd, "PreToolUse", String(N), at], 60_000),
    runNode(writer, [stateDir, cwd, "Stop", String(N), at], 60_000),
  ]);
  assert.equal(a.code, 0, a.out);
  assert.equal(b.code, 0, b.out);
  const t = readTurn(stateDir, cwd, "s-race");
  assert.equal(t?.turn, N, "every turn start counted");
  assert.ok((t?.stopped ?? N + 1) <= N);
});

/**
 * Judge j7: the count a clear arms on and the count a Stop ends are both read before anything slow.
 * (1) A Stop hook whose relay read is slow, while a new turn starts, must not mark that new turn stopped.
 * (2) A turn that ends and a new one that starts while `clear` looks up its terminal cancels the clear.
 */
test("H25: a slow Stop hook never ends a turn that started meanwhile; a slow clear lookup never re-arms on a later turn", async () => {
  const cwd = folder();
  const stateDir = tmpState();
  const sid = "s-slow";
  let release!: () => void;
  const held = new Promise<void>((ok) => (release = ok));
  const deps = {
    stateDir,
    relayUrl: "http://127.0.0.1:9",
    agentToken: "t",
    mintToken: undefined,
    budgetMs: 5_000,
    fetch: async () => {
      await held;
      return new Response(JSON.stringify({ unread: 0, aimed: 0 }));
    },
  };
  await hookOutput(
    "claude_code",
    "PreToolUse",
    { cwd, session_id: sid, tool_name: "Bash" },
    { ...deps, fetch: undefined, relayUrl: undefined, agentToken: undefined },
  );
  const stop = hookOutput(
    "claude_code",
    "Stop",
    { cwd, session_id: sid },
    deps,
  );
  await new Promise((r) => setTimeout(r, 50));
  noteTurn(stateDir, cwd, sid, "UserPromptSubmit");
  release();
  assert.equal(await stop, "");
  const t = readTurn(stateDir, cwd, sid);
  assert.deepEqual(
    t && { turn: t.turn, stopped: t.stopped },
    { turn: 2, stopped: 1 },
    "the Stop ends turn 1, the one it saw when it fired",
  );

  const r = ready();
  noteTurn(r.stateDir, r.cwd, SID, "PreToolUse");
  const p: TyperPayload[] = [];
  r.io.launch = (x: TyperPayload) => void p.push(x);
  const call = r.io.call;
  r.io.call = async (op: string, args: Record<string, unknown>) => {
    if (op === "terminal_for") {
      // While the lookup is slow: this turn ends and the person starts another one.
      noteTurn(r.stateDir, r.cwd, SID, "Stop");
      noteTurn(r.stateDir, r.cwd, SID, "UserPromptSubmit");
      return null;
    }
    return call(op, args);
  };
  assert.equal(await handover(["clear"], r.io), 0);
  const x = p[0] as TyperPayload;
  assert.equal(x.turn?.armed, 1, "armed on the turn clear ran in");
  await runTyper({ ...ended(x), delay_ms: 0 });
  assert.deepEqual(typed(r.f.log), [], "nothing typed into the later turn");
  assert.match(
    lastCleared(r.stateDir, RID) ?? "",
    /^skipped 3: a new turn started/,
  );
});

/** Judge j9: the turn is the last thing read before each step, so a turn started while the config is read cancels. */
test("H25: a turn that starts while the final guard reads the config types nothing", async () => {
  const r = ready();
  const p: TyperPayload[] = [];
  r.io.launch = (x: TyperPayload) => void p.push(x);
  assert.equal(await handover(["clear"], r.io), 0);
  const x = ended(p[0] as TyperPayload);
  let fired = false;
  testHooks.gap = () => {
    if (fired) return;
    fired = true;
    noteTurn(r.stateDir, r.cwd, SID, "UserPromptSubmit");
  };
  try {
    await runTyper({ ...x, delay_ms: 0 });
  } finally {
    delete testHooks.gap;
  }
  assert.ok(fired, "the guard read the config");
  assert.deepEqual(typed(r.f.log), [], "nothing typed into the new turn");
  assert.match(
    lastCleared(r.stateDir, RID) ?? "",
    /^skipped 3: a new turn started/,
  );
});
