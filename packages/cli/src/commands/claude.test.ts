import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newTownFile, writeTownFile } from "../town-file.ts";
import { CHANNEL_FLAG, CHANNEL_SERVER, claude } from "./claude.ts";

function joinedFolder(wake?: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "hawl-claude-"));
  const t = newTownFile("shop-site");
  t.memberships.push({
    town_id: "twn_1",
    town_slug: "acme",
    relay_url: "https://relay.test",
    workers: [],
  } as never);
  if (wake !== undefined) t.wake = wake;
  writeTownFile(dir, t);
  return dir;
}

test("hawl claude starts Claude Code with the channel flag, prints exactly what it runs, and passes arguments through", async () => {
  const lines: string[] = [];
  const calls: { command: string; args: string[] }[] = [];
  const code = await claude(["--model", "opus", "fix the bug"], {
    cwd: joinedFolder(),
    print: (l) => lines.push(l),
    run: async (command, args) => {
      calls.push({ command, args });
      return 0;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    {
      command: "claude",
      args: [CHANNEL_FLAG, CHANNEL_SERVER, "--model", "opus", "fix the bug"],
    },
  ]);
  assert.match(
    lines.join("\n"),
    /Starting: claude --dangerously-load-development-channels server:hawl --model opus fix the bug/,
  );
  assert.match(lines.join("\n"), /I am using this for local development/);
});

test("the exit code of Claude Code is the exit code of hawl claude", async () => {
  const code = await claude([], {
    cwd: joinedFolder(),
    print: () => {},
    run: async () => 3,
  });
  assert.equal(code, 3);
});

test("with wake off for the folder, Claude Code starts plainly and says why", async () => {
  const lines: string[] = [];
  let args: string[] = [];
  await claude(["-c"], {
    cwd: joinedFolder(false),
    print: (l) => lines.push(l),
    run: async (_c, a) => {
      args = a;
      return 0;
    },
  });
  assert.deepEqual(args, ["-c"]);
  assert.match(lines.join("\n"), /Wake is off for this folder/);
});

test("in a folder that has not joined, Claude Code starts as usual with a pointer to hawl join", async () => {
  const lines: string[] = [];
  let args: string[] = ["x"];
  await claude([], {
    cwd: mkdtempSync(join(tmpdir(), "hawl-nojoin-")),
    print: (l) => lines.push(l),
    run: async (_c, a) => {
      args = a;
      return 0;
    },
  });
  assert.deepEqual(args, []);
  assert.match(lines.join("\n"), /has not joined a Hawl site/);
});
