import assert from "node:assert/strict";
import { test } from "node:test";
import { LINK_WINDOW_MS, SessionLinks } from "./session-link.ts";

const F = "res_folder";
const CLAUDE = 33084; // the Claude Code process: hooks get it as CLAUDE_PID
const CMD = 10948; // hawl.cmd's cmd.exe on Windows, child of CLAUDE
const tree = new Map([
  [CMD, CLAUDE],
  [CLAUDE, 1],
  [777, 1],
]);
const parentOf = async (pid: number) => tree.get(pid);
const none = () => false;

function clock() {
  let t = 1_000_000;
  return { now: () => t, add: (ms: number) => (t += ms) };
}

test("claude --continue: the MCP server's fresh id pairs with the resumed id its Claude's hooks report, once and for good", async () => {
  const l = new SessionLinks();
  const ask = (ppid: number) => l.link(F, "X", { ppid, parentOf, live: none });
  assert.equal(await ask(CMD), undefined, "no hook yet");
  l.hookSaw(F, "Y", CLAUDE); // SessionStart source=resume, CLAUDE_PID
  assert.equal(await ask(CMD), "Y", "through cmd.exe (Windows)");
  assert.equal(await ask(CMD), "Y", "the same answer again");
  const direct = new SessionLinks();
  direct.hookSaw(F, "Y", CLAUDE);
  assert.equal(
    await direct.link(F, "X", { ppid: CLAUDE, parentOf, live: none }),
    "Y",
    "started directly (macOS, Linux)",
  );
});

test("a normal start, another Claude's session, another folder, or a session open elsewhere never pairs", async () => {
  const l = new SessionLinks();
  l.hookSaw(F, "X", CLAUDE); // its own hooks report its own id
  assert.equal(
    await l.link(F, "X", { ppid: CMD, parentOf, live: none }),
    undefined,
  );

  const other = new SessionLinks();
  other.hookSaw(F, "Y", 777); // a different Claude Code process
  other.hookSaw("res_other", "Z", CLAUDE); // same Claude, other folder
  assert.equal(
    await other.link(F, "X", { ppid: CMD, parentOf, live: none }),
    undefined,
  );

  const open = new SessionLinks();
  open.hookSaw(F, "Y", CLAUDE);
  assert.equal(
    await open.link(F, "X", { ppid: CMD, parentOf, live: (id) => id === "Y" }),
    undefined,
  );
  // No parent pid (an older MCP server): no pairing.
  assert.equal(await open.link(F, "X", { parentOf, live: none }), undefined);
});

test("a hook report older than the window is not used", async () => {
  const c = clock();
  const l = new SessionLinks({ now: c.now });
  l.hookSaw(F, "Y", CLAUDE);
  c.add(LINK_WINDOW_MS + 1);
  assert.equal(
    await l.link(F, "X", { ppid: CMD, parentOf, live: none }),
    undefined,
  );
});
