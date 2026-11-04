import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "../test-tmp.ts";
import { join } from "node:path";
import test from "node:test";
import {
  isOutdated,
  parseToolVersion,
  persistToolPath,
  pickTools,
  planTools,
  type ToolState,
} from "./tools.ts";

const none: Record<string, ToolState> = {
  claude: { installed: null },
  codex: { installed: null },
  git: { installed: null },
};

test("parseToolVersion reads the three --version formats", () => {
  assert.equal(parseToolVersion("2.1.301 (Claude Code)"), "2.1.301");
  assert.equal(parseToolVersion("codex-cli 0.163.0"), "0.163.0");
  assert.equal(parseToolVersion("git version 2.43.0.windows.1"), "2.43.0");
  assert.equal(parseToolVersion("nope"), null);
});

test("isOutdated compares numbers, not strings", () => {
  assert.equal(isOutdated("0.163.0", "0.164.0"), true);
  assert.equal(isOutdated("2.1.9", "2.1.10"), true);
  assert.equal(isOutdated("2.1.10", "2.1.10"), false);
  assert.equal(isOutdated("3.0.0", "2.9.9"), false);
});

test("planTools: bare Linux as root lists all three with official commands", () => {
  const p = planTools({ os: "linux", root: true, pm: "apt-get", states: none });
  assert.deepEqual(
    p.map((i) => [i.id, i.status]),
    [
      ["git", "missing"],
      ["claude", "missing"],
      ["codex", "missing"],
    ],
  );
  assert.deepEqual(p[0]?.command, [
    "sh",
    "-c",
    "apt-get update && apt-get install -y git",
  ]);
  assert.match(
    p[1]?.command?.[2] ?? "",
    /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/,
  );
  assert.match(p[2]?.command?.[2] ?? "", /CODEX_NON_INTERACTIVE=1 sh/);
});

test("planTools: non-root Linux uses sudo for git only", () => {
  const p = planTools({
    os: "linux",
    root: false,
    pm: "dnf",
    sudo: true,
    states: none,
  });
  assert.match(p[0]?.command?.[2] ?? "", /^sudo dnf install -y git$/);
  const q = planTools({
    os: "linux",
    root: false,
    pm: "dnf",
    sudo: false,
    states: none,
  });
  assert.equal(q[0]?.command, null);
  assert.match(q[0]?.note ?? "", /git-scm\.com\/download\/linux/);
});

test("planTools: Windows uses winget for git and the vendors' PowerShell installers", () => {
  const p = planTools({ os: "win32", winget: true, states: none });
  assert.equal(p[0]?.command?.[0], "winget");
  assert.ok(p[0]?.command?.includes("Git.Git"));
  assert.equal(p[1]?.command?.[0], "powershell");
  assert.ok(p[1]?.command?.join(" ").includes("https://claude.ai/install.ps1"));
  assert.ok(
    p[2]?.command?.join(" ").includes("https://chatgpt.com/codex/install.ps1"),
  );
  const noWinget = planTools({ os: "win32", winget: false, states: none });
  assert.equal(noWinget[0]?.command, null);
  assert.match(noWinget[0]?.note ?? "", /git-scm\.com\/download\/win/);
});

test("planTools: current tools are left out, old ones are marked outdated", () => {
  const p = planTools({
    os: "linux",
    root: true,
    pm: "apt-get",
    states: {
      claude: { installed: "2.1.301", latest: "2.1.309" },
      codex: { installed: "0.164.0", latest: "0.164.0" },
      git: { installed: "2.43.0" },
    },
  });
  assert.deepEqual(
    p.map((i) => [i.id, i.status]),
    [["claude", "outdated"]],
  );
  assert.deepEqual(p[0]?.command, ["claude", "update"]);
});

test("pickTools: names, all, none, numbers", () => {
  const p = planTools({ os: "linux", root: true, pm: "apt-get", states: none });
  assert.deepEqual(
    pickTools(p, "claude,codex").map((i) => i.id),
    ["claude", "codex"],
  );
  assert.equal(pickTools(p, "all").length, 3);
  assert.equal(pickTools(p, "none").length, 0);
  assert.deepEqual(
    pickTools(p, "1,3").map((i) => i.id),
    ["git", "codex"],
  );
  assert.throws(() => pickTools(p, "vim"), /unknown tool/);
});

test("persistToolPath: Linux profile gets ~/.local/bin once; nothing without the folder or with the opt-out", () => {
  const home = mkdtempSync(join(tmpdir(), "hawl-tools-"));
  assert.equal(persistToolPath("linux", home, {}), null);
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  assert.equal(
    persistToolPath("linux", home, { HAWL_NO_PERSIST_PATH: "1" }),
    null,
  );
  assert.equal(persistToolPath("linux", home, {}), join(home, ".profile"));
  assert.equal(persistToolPath("linux", home, {}), null);
  assert.match(readFileSync(join(home, ".profile"), "utf8"), /\.local\/bin/);
});
