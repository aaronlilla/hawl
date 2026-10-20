import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { COMMAND_HELP, TOP_HELP } from "../help.ts";
import {
  COMMANDS,
  defaultHandlers,
  type Handlers,
  main,
  styleHelp,
} from "../main.ts";
import { colorEnabled, makeStyle, wrap } from "../style.ts";
import { runUpdate } from "../update/cmd.ts";
import { renderChecks } from "./doctor.ts";

function harness(
  over: Partial<{ isTTY: boolean; env: Record<string, string> }> = {},
) {
  let out = "";
  let err = "";
  const calls: string[] = [];
  const handlers: Handlers = { ...defaultHandlers };
  for (const c of COMMANDS) handlers[c] = async () => (calls.push(c), 0);
  const io = {
    out: (s: string) => void (out += s),
    err: (s: string) => void (err += s),
    ...over,
  };
  return { handlers, io, calls, text: () => ({ out, err }) };
}

test("top help is grouped and hides plumbing", async () => {
  const h = harness();
  assert.equal(await main([], h.handlers, h.io), 0);
  assert.equal(h.text().out, TOP_HELP);
  for (const g of ["Everyday", "Setup", "Options"])
    assert.match(TOP_HELP, new RegExp(`^${g}$`, "m"));
  assert.match(TOP_HELP, /wake on\|off/);
  assert.doesNotMatch(TOP_HELP, /\bmcp\b|\bhook\b|\bdaemon\b/);
});

test("every command accepts --help and exits 0 without running", async () => {
  for (const c of COMMANDS) {
    const h = harness();
    assert.equal(await main([c, "--help"], h.handlers, h.io), 0, c);
    assert.equal(h.text().out, COMMAND_HELP[c], c);
    assert.deepEqual(h.calls, []);
  }
  assert.match(COMMAND_HELP.join ?? "", /--host <tool>/);
});

test("unknown command: did you mean, exit 2", async () => {
  const h = harness();
  assert.equal(await main(["joyn"], h.handlers, h.io), 2);
  assert.match(
    h.text().err,
    /"joyn" isn't a hawl command\. Did you mean "join"\?/,
  );
  assert.match(h.text().err, /Run hawl --help to see all commands\./);
});

test("usage errors exit 2 with the command's usage line", async () => {
  const h = harness();
  h.handlers.wake = async () => {
    throw new Error("usage: hawl wake on|off");
  };
  assert.equal(await main(["wake"], h.handlers, h.io), 2);
  assert.match(h.text().err, /Usage: hawl wake on\|off/);
  const e = Object.assign(new Error("Unknown option '--bad'"), {
    code: "ERR_PARSE_ARGS_UNKNOWN_OPTION",
  });
  h.handlers.status = async () => {
    throw e;
  };
  assert.equal(await main(["status", "--bad"], h.handlers, h.io), 2);
});

test("other failures exit 1 with the doctor line", async () => {
  const h = harness();
  h.handlers.status = async () => {
    throw new Error("boom");
  };
  assert.equal(await main(["status"], h.handlers, h.io), 1);
  assert.match(h.text().err, /^.{1,3} boom\.\nStill stuck\? Run hawl doctor\./);
});

test("hawl mcp typed by a person exits 2", async () => {
  const h = harness();
  assert.equal(
    await main(["mcp", "--host", "x"], h.handlers, {
      ...h.io,
      stdinIsTTY: true,
    }),
    2,
  );
  assert.match(h.text().err, /started by your agent tool, not typed/);
});

test("colour: NO_COLOR, --no-color and non-terminals turn it off", () => {
  assert.equal(colorEnabled({ env: {}, argv: [], isTTY: true }), true);
  assert.equal(
    colorEnabled({ env: { NO_COLOR: "1" }, argv: [], isTTY: true }),
    false,
  );
  assert.equal(
    colorEnabled({ env: { NO_COLOR: "" }, argv: [], isTTY: true }),
    true,
  );
  assert.equal(
    colorEnabled({ env: {}, argv: ["--no-color"], isTTY: true }),
    false,
  );
  assert.equal(colorEnabled({ env: {}, argv: [], isTTY: false }), false);
  const plain = makeStyle(false, false);
  assert.deepEqual(
    [plain.ok, plain.fail, plain.warn, plain.bullet],
    ["ok", "x", "!", "-"],
  );
  assert.equal(plain.bold("a"), "a");
  assert.match(makeStyle(true).ok, /\u001b\[32m✓/);
  assert.equal(styleHelp(TOP_HELP, plain), TOP_HELP);
  assert.match(styleHelp(TOP_HELP, makeStyle(true)), /\u001b\[1mEveryday/);
});

test("wrap keeps indented commands whole", () => {
  const long = `${"word ".repeat(30)}`.trim();
  assert.ok(
    wrap(long)
      .split("\n")
      .every((l) => l.length <= 78),
  );
  const cmd = `    ${"x".repeat(100)}`;
  assert.equal(wrap(cmd), cmd);
});

test("doctor suggests --fix when something needs a look", () => {
  const out = renderChecks([{ name: "daemon", state: "fail", detail: "down" }]);
  assert.match(out, /Fix: hawl doctor --fix/);
  assert.doesNotMatch(
    renderChecks([{ name: "daemon", state: "ok", detail: "up" }]),
    /Fix:/,
  );
});

test("hawl update prints a summary, not JSON, and runs with auto-update off", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "hawl-upd-"));
  let out = "";
  let err = "";
  const io = {
    out: (s: string) => void (out += s),
    err: (s: string) => void (err += s),
  };
  const d = {
    stateDir,
    binPath: join(stateDir, "hawl"),
    current: "0.4.0",
    os: "linux",
    arch: "x64",
    fetchManifest: async () => ({}),
    download: async () => new Uint8Array(),
  };
  assert.equal(await runUpdate({ channel: "latest" }, d, io), 1);
  assert.match(err, /Checking hawl\.ai for updates \(channel: latest\)\.\.\./);
  assert.match(err, /didn't pass its signature check/);
  assert.match(err, /Fix: report this.*npm i -g hawl\.ai/);
  assert.doesNotMatch(err, /try again later/i);
  assert.doesNotMatch(out + err, /\{"status"/);
  assert.equal(await runUpdate({ channel: "latest", now: true }, d, io), 0);
  assert.match(out, /Nothing is staged/);
});
