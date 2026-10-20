import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMANDS,
  cliVersion,
  HAWL_CLI,
  type Handlers,
  HELP,
  main,
} from "./main.ts";

function harness() {
  const calls: { cmd: string; argv: string[] }[] = [];
  const handlers = Object.fromEntries(
    COMMANDS.map((c) => [
      c,
      async (argv: string[]) => {
        calls.push({ cmd: c, argv });
        return 0;
      },
    ]),
  ) as Handlers;
  let out = "";
  let err = "";
  const io = {
    out: (s: string) => {
      out += s;
    },
    err: (s: string) => {
      err += s;
    },
  };
  return { calls, handlers, io, text: () => ({ out, err }) };
}

test("--version prints the package version", async () => {
  const h = harness();
  assert.equal(await main(["--version"], h.handlers, h.io), 0);
  assert.equal(h.text().out, `${cliVersion()}\n`);
  assert.match(cliVersion(), /^\d+\.\d+\.\d+/);
});

test("--help and no args print help, exit 0", async () => {
  for (const argv of [["--help"], []]) {
    const h = harness();
    assert.equal(await main(argv, h.handlers, h.io), 0);
    assert.equal(h.text().out, HELP);
  }
});

test("every spec 3.1 command dispatches with its args", async () => {
  const cases: string[][] = [
    ["join", "acme", "--host", "codex"],
    ["leave", "--all"],
    ["claude", "--model", "opus"],
    ["wake", "on"],
    ["config", "stop-hook", "off"],
    ["status", "--json"],
    ["doctor"],
    ["agents", "--json"],
    ["mcp", "--host", "claude_code"],
    ["hook", "claude_code", "Stop"],
    ["daemon", "--foreground"],
    ["autostart", "on"],
    ["local"],
    ["update", "--channel", "next"],
  ];
  assert.deepEqual(
    cases.map((c) => c[0]),
    [...COMMANDS],
  );
  for (const [cmd, ...rest] of cases) {
    const h = harness();
    assert.equal(await main([cmd as string, ...rest], h.handlers, h.io), 0);
    assert.deepEqual(h.calls, [{ cmd, argv: rest }]);
  }
});

test("unknown command exits 2 with help on stderr", async () => {
  const h = harness();
  assert.equal(await main(["nope"], h.handlers, h.io), 2);
  assert.match(h.text().err, /"nope" isn't a hawl command\./);
  assert.match(h.text().err, /Run hawl --help/);
  assert.deepEqual(h.calls, []);
});

test("handler exit code passes through; a throw exits 1", async () => {
  const h = harness();
  h.handlers.doctor = async () => 1;
  assert.equal(await main(["doctor"], h.handlers, h.io), 1);
  h.handlers.status = async () => {
    throw new Error("boom");
  };
  assert.equal(await main(["status"], h.handlers, h.io), 1);
  assert.match(h.text().err, /boom\./);
});

test("long-lived handler returns undefined", async () => {
  const h = harness();
  h.handlers.daemon = async () => undefined;
  assert.equal(await main(["daemon"], h.handlers, h.io), undefined);
});

test("HAWL_CLI points at dist/main.js", () => {
  assert.match(
    HAWL_CLI.replaceAll("\\", "/"),
    /packages\/cli\/dist\/main\.js$/,
  );
});

test("localHandle turns plain and folder names into valid local handles", async () => {
  const { localHandle } = await import("./main.ts");
  assert.equal(localHandle("sam"), "@sam");
  assert.equal(localHandle("@sam"), "@sam");
  assert.equal(localHandle("my app"), "@my-app");
  assert.equal(localHandle("tmp.U9CBFm7r4k"), "@tmp.U9CBFm7r4k");
  assert.equal(localHandle("..."), "@worker");
});
