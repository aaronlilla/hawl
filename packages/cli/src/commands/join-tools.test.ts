import assert from "node:assert/strict";
import test from "node:test";
import { planTools, type ToolItem } from "../install/tools.ts";
import { type JoinOpts, toolsStep } from "./join.ts";

const plan = (): ToolItem[] =>
  planTools({
    os: "linux",
    root: true,
    pm: "apt-get",
    states: {
      git: { installed: null },
      claude: { installed: null },
      codex: { installed: null },
    },
  });

function setup(opts: Partial<JoinOpts>, keyboard: boolean, answer = "") {
  const lines: string[] = [];
  const ran: string[] = [];
  const asked: string[] = [];
  const deps = {
    home: "/h",
    ask: async (q: string) => (asked.push(q), answer),
    tools: {
      plan: async () => plan(),
      run: (t: ToolItem) => (ran.push(t.id), true),
    },
  };
  const go = () =>
    toolsStep(
      { site: "a", hosts: [], ...opts },
      deps,
      "/h",
      (l) => lines.push(l),
      keyboard,
    );
  return { lines, ran, asked, go };
}

test("no keyboard and no flag: lists, installs nothing, names the flag", async () => {
  const t = setup({}, false);
  await t.go();
  assert.deepEqual(t.ran, []);
  assert.deepEqual(t.asked, []);
  assert.match(t.lines.join("\n"), /Claude Code: not installed/);
  assert.match(t.lines.join("\n"), /--install-tools claude,codex,git/);
});

test("--install-tools claude,codex: installs those two, git stays", async () => {
  const t = setup({ installTools: "claude,codex" }, false);
  await t.go();
  assert.deepEqual(t.ran, ["claude", "codex"]);
  assert.match(t.lines.join("\n"), /codex login/);
});

test("keyboard: Enter means all, a number picks one, none installs nothing", async () => {
  const all = setup({}, true, "");
  await all.go();
  assert.deepEqual(all.ran, ["git", "claude", "codex"]);
  const one = setup({}, true, "2");
  await one.go();
  assert.deepEqual(one.ran, ["claude"]);
  const nope = setup({}, true, "none");
  await nope.go();
  assert.deepEqual(nope.ran, []);
});
