import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "../test-tmp.ts";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { recordAck } from "../daemon/handover.ts";
import { socketPath, tokenPath } from "../daemon/socket.ts";
import { tmpState } from "../daemon/testkit.ts";
import { handover } from "./handover.ts";

const RID = "res_01926f3a-0000-7000-8000-000000000001";
const HOV = "hov_01926f3a-0000-7000-8000-0000000000aa";

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "hawl-hov-cmd-"));
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

type Call = { op: string; args: Record<string, unknown> };

function io(
  o: {
    cwd?: string;
    stdin?: string;
    answer?: (c: Call) => unknown;
    stateDir?: string;
  } = {},
) {
  const lines: string[] = [];
  const calls: Call[] = [];
  return {
    lines,
    calls,
    io: {
      cwd: o.cwd ?? folder(),
      stateDir: o.stateDir ?? tmpState(),
      print: (l: string) => void lines.push(l),
      call: async (op: string, args: Record<string, unknown>) => {
        const c = { op, args };
        calls.push(c);
        return o.answer
          ? o.answer(c)
          : { handover_id: HOV, revision: 3, state: "stored" };
      },
      readStdin: async () => o.stdin ?? "",
    },
  };
}

const textOf = (c: Call | undefined) =>
  (c?.args.args as { text?: string } | undefined)?.text;

// These tests run as a plain shell in the folder, even when started from inside Claude Code.
delete process.env.CLAUDE_CODE_SESSION_ID;

test("invariant: inside a terminal, the handover is stored, read and cleared as that terminal's own agent", async () => {
  const TERM = "res_01926f3a-0000-7000-8000-0000000000t1";
  const h = io({
    answer: (c) =>
      c.op === "terminal_for"
        ? { resident_id: TERM }
        : { handover_id: HOV, revision: 3, state: "stored" },
  });
  const env = { CLAUDE_CODE_SESSION_ID: "sess-1", CLAUDE_PID: "4242" };
  assert.equal(
    await handover(["write", "notes"], { ...h.io, env } as never),
    0,
  );
  assert.deepEqual(h.calls[0], {
    op: "terminal_for",
    args: { resident_id: RID, host_session_id: "sess-1", claude_pid: 4242 },
  });
  const put = h.calls.find((c) => c.op === "tool");
  assert.equal(put?.args.resident_id, TERM);
  // No terminal agent (older helper, or not a terminal): the folder's worker as before.
  const h2 = io({
    answer: (c) =>
      c.op === "terminal_for"
        ? null
        : { handover_id: HOV, revision: 3, state: "stored" },
  });
  await handover(["write", "notes"], { ...h2.io, env } as never);
  assert.equal(h2.calls.find((c) => c.op === "tool")?.args.resident_id, RID);
});

test("H20: write sends the words to handover_put through the helper and prints the acknowledgement, not the text", async () => {
  const h = io();
  assert.equal(
    await handover(["write", "Goal:", "ship", "X.", "SECRET-NOTE"], h.io),
    0,
  );
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]?.op, "tool");
  assert.equal(h.calls[0]?.args.resident_id, RID);
  assert.equal(h.calls[0]?.args.name, "handover_put");
  assert.equal(textOf(h.calls[0]), "Goal: ship X. SECRET-NOTE");
  const out = h.lines.join("\n");
  assert.match(out, new RegExp(`Saved where .* got to .*${HOV} revision 3`));
  assert.match(out, /\/clear/);
  assert.ok(!out.includes("SECRET-NOTE"), "the text is never echoed");
});

test("H20: Windows-safe argv: each word reaches the relay byte for byte, joined by one space, never through a shell", async () => {
  const words = [
    'say "hi"',
    "a & b | c > d",
    "%PATH% $HOME ^caret `tick`",
    "line1\nline2",
    "ünïcødé 日本",
    "--not-an-option",
  ];
  const h = io();
  assert.equal(await handover(["write", "--", ...words], h.io), 0);
  assert.equal(textOf(h.calls[0]), words.join(" "));
});

test("H20: write reads --file, or stdin when no words are given; empty text or both sources is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hawl-hov-file-"));
  const file = join(dir, "notes.md");
  writeFileSync(file, "From a file.\nNext step: test.");
  const a = io();
  assert.equal(await handover(["write", "--file", file], a.io), 0);
  assert.equal(textOf(a.calls[0]), "From a file.\nNext step: test.");

  const b = io({ stdin: "From stdin & co %X%\n" });
  assert.equal(await handover(["write"], b.io), 0);
  assert.equal(textOf(b.calls[0]), "From stdin & co %X%\n");

  const c = io({ stdin: "   \n" });
  await assert.rejects(handover(["write"], c.io), /usage: hawl handover write/);
  assert.equal(c.calls.length, 0);
  const d = io();
  await assert.rejects(
    handover(["write", "words", "--file", file], d.io),
    /not both/,
  );
  assert.equal(d.calls.length, 0);
});

test("H20: write fails when the relay does not answer stored", async () => {
  for (const answer of [
    { state: "queued", handover_id: HOV, revision: 1 },
    { state: "stored" },
    null,
  ]) {
    const h = io({ answer: () => answer });
    await assert.rejects(
      handover(["write", "x"], h.io),
      /did not confirm/,
      JSON.stringify(answer),
    );
  }
});

test("H18/H20: status shows the relay's state (peek, never consuming) and the acknowledgement the helper recorded", async () => {
  const stateDir = tmpState();
  const none = io({ stateDir, answer: () => ({ state: "none" }) });
  assert.equal(await handover(["status"], none.io), 0);
  assert.deepEqual(none.calls[0]?.args, {
    resident_id: RID,
    name: "handover_get",
    args: { peek: true },
  });
  assert.match(none.lines.join("\n"), /relay: nothing stored/);
  assert.match(none.lines.join("\n"), /last stored here: nothing/);
  assert.match(none.lines.join("\n"), /auto-clear: off, no clear command/);

  recordAck(
    stateDir,
    RID,
    { handover_id: HOV, revision: 3, state: "stored" },
    new Date("2026-10-21T10:00:00Z"),
  );
  const waiting = io({
    stateDir,
    answer: () => ({ state: "stored", handover_id: HOV, revision: 3 }),
  });
  await handover(["status"], waiting.io);
  const out = waiting.lines.join("\n");
  assert.match(out, new RegExp(`relay: waiting \\(${HOV} revision 3\\)`));
  assert.match(
    out,
    new RegExp(
      `last stored here: ${HOV} revision 3 at 2026-10-21T10:00:00.000Z`,
    ),
  );

  const picked = io({
    stateDir,
    answer: () => ({ state: "consumed", handover_id: HOV, revision: 3 }),
  });
  await handover(["status"], picked.io);
  assert.match(picked.lines.join("\n"), /relay: picked up/);

  const down = io({
    stateDir,
    answer: () => {
      throw new Error("the Hawl helper is not running");
    },
  });
  assert.equal(await handover(["status"], down.io), 0);
  assert.match(down.lines.join("\n"), /relay: unknown/);
});

/**
 * Through the REAL entry point: `node src/main.ts handover write ...` in a child process, talking to
 * a fake helper on the real socket path. Returns the exit code, stdout, stderr and the text the
 * helper was asked to store (undefined when nothing was sent).
 */
async function realCli(
  argv: string[],
  o: { stdin?: string; answer?: unknown } = {},
): Promise<{ code: number | null; out: string; err: string; text?: string }> {
  const stateDir = tmpState();
  writeFileSync(tokenPath(stateDir), "tok");
  let text: string | undefined;
  const server = createServer((s) => {
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (c: string) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl));
      text = req.args?.text;
      s.end(
        `${JSON.stringify({ ok: true, result: o.answer ?? { handover_id: HOV, revision: 1, state: "stored", scan: { verdict: "clean", reasons: [] } } })}\n`,
      );
    });
  });
  await new Promise<void>((r) => server.listen(socketPath(stateDir), r));
  try {
    const main = fileURLToPath(new URL("../main.ts", import.meta.url));
    const child = spawn(process.execPath, [main, ...argv], {
      cwd: folder(),
      env: { ...process.env, HAWL_HOME: stateDir, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
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
    child.stdin.end(o.stdin ?? "");
    const code = await new Promise<number | null>((r) => {
      const t = setTimeout(() => child.kill(), 20_000);
      child.on("close", (c) => {
        clearTimeout(t);
        r(c);
      });
    });
    return { code, out, err, text };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("H20 entry point: after `--` nothing is interpreted or removed; the text reaches the helper verbatim", async () => {
  for (const words of [
    ["--help"],
    ["-h"],
    ["--no-color"],
    ["--json"],
    ["--version"],
    ["--starts-with-dashes", "then", "--help", "-h", "--no-color"],
    ["-"],
  ]) {
    const r = await realCli(["handover", "write", "--", ...words]);
    assert.equal(r.code, 0, `${words.join(" ")}: ${r.err}`);
    assert.equal(r.text, words.join(" "), words.join(" "));
    assert.match(
      r.out,
      new RegExp(`Saved where .* got to .*${HOV} revision 1`),
    );
  }
});

test("H20 entry point: --text, --file, stdin via `-` or a pipe; empty text is refused and nothing is sent", async () => {
  const t = await realCli(["handover", "write", "--text=--help me -h"]);
  assert.equal(t.code, 0, t.err);
  assert.equal(t.text, "--help me -h");
  const t2 = await realCli(["handover", "write", "--text", 'a "b" & %c%']);
  assert.equal(t2.code, 0, t2.err);
  assert.equal(t2.text, 'a "b" & %c%');

  const dir = mkdtempSync(join(tmpdir(), "hawl-hov-entry-"));
  const file = join(dir, "n.md");
  writeFileSync(file, "--no-color\n-h\n");
  const f = await realCli(["handover", "write", "--file", file]);
  assert.equal(f.code, 0, f.err);
  assert.equal(f.text, "--no-color\n-h\n");

  const dash = await realCli(["handover", "write", "-"], {
    stdin: "--help from stdin\n",
  });
  assert.equal(dash.code, 0, dash.err);
  assert.equal(dash.text, "--help from stdin\n");

  const pipe = await realCli(["handover", "write"], { stdin: "-- piped" });
  assert.equal(pipe.code, 0, pipe.err);
  assert.equal(pipe.text, "-- piped");

  for (const argv of [
    ["handover", "write", "--", ""],
    ["handover", "write", "--text", ""],
    ["handover", "write"],
  ]) {
    const e = await realCli(argv, { stdin: "  \n" });
    assert.equal(e.code, 2, argv.join(" "));
    assert.equal(e.text, undefined, "nothing sent");
  }
  const both = await realCli(["handover", "write", "--text", "a", "b"]);
  assert.equal(both.code, 2);
  assert.equal(both.text, undefined);
});

test("H20 entry point: very long text reaches the helper whole; a flagged scan is shown to the writer", async () => {
  const long = `--${"x".repeat(19_990)}`;
  const r = await realCli(["handover", "write", "--", long], {
    answer: {
      handover_id: HOV,
      revision: 2,
      state: "stored",
      scan: { verdict: "flagged", reasons: ["l1.secrets"] },
    },
  });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.text, long);
  assert.match(r.out, /flagged \(l1\.secrets\)/);
});

test("H20 entry point: before `--` help still works and stores nothing", async () => {
  const r = await realCli(["handover", "write", "--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Usage: hawl handover write/);
  assert.equal(r.text, undefined);
});

test("H20: a folder that is not joined says so; an unknown sub-command shows the usage", async () => {
  const bare = mkdtempSync(join(tmpdir(), "hawl-hov-bare-"));
  await assert.rejects(
    handover(["status"], io({ cwd: bare }).io),
    /not joined/,
  );
  for (const argv of [
    [],
    ["on"],
    ["frob"],
    ["status", "extra"],
    ["status", "--on"],
    ["write", "--template", "x"],
  ])
    await assert.rejects(
      handover(argv, io().io),
      /usage: hawl handover write\|status/,
      argv.join(" "),
    );
});
