import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SKILLS } from "../hosts/skills-data.ts";
import { parseNames, skillsAdd, skillsList, skillsRemove } from "./skills.ts";

function io() {
  const root = mkdtempSync(join(tmpdir(), "hawl-skillscmd-"));
  const projectDir = join(root, "app");
  mkdirSync(projectDir, { recursive: true });
  const lines: string[] = [];
  return {
    root,
    lines,
    io: {
      projectDir,
      home: join(root, "home"), // a temp HOME, never the real one
      stateDir: join(root, "state"),
      env: {},
      has: (n: string) => n === "claude" || n === "codex",
      print: (l: string) => lines.push(l),
    },
  };
}

test("parseNames: all, none, short and full names, unknown refused", () => {
  assert.equal(parseNames("all").length, 4);
  assert.deepEqual(parseNames("none"), []);
  assert.deepEqual(parseNames("verify,hawl-handover"), [
    "hawl-verify",
    "hawl-handover",
  ]);
  assert.throws(() => parseNames("nope"), /not a Hawl skill/);
});

test("skills list / add --global / list / remove", () => {
  const t = io();
  skillsList(t.io);
  assert.match(
    t.lines.at(-1) as string,
    /No Hawl skills installed\. Add them later: hawl skills add all --global/,
  );

  t.lines.length = 0;
  skillsAdd(t.io, parseNames("all"), "global");
  assert.equal(t.lines.filter((l) => l.startsWith("Installed ")).length, 8);
  const verify = join(
    t.io.home,
    ".claude",
    "skills",
    "hawl-verify",
    "SKILL.md",
  );
  assert.equal(readFileSync(verify, "utf8"), SKILLS["hawl-verify"]);

  t.lines.length = 0;
  skillsList(t.io);
  assert.equal(t.lines.length, 8);
  assert.ok(
    t.lines.every((l) => l.startsWith("global") && l.includes("installed")),
  );

  // A person edits one file: list says so, remove keeps it, the rest goes.
  writeFileSync(verify, "mine\n");
  t.lines.length = 0;
  skillsList(t.io);
  assert.ok(t.lines.some((l) => l.includes("edited") && l.includes(verify)));
  t.lines.length = 0;
  skillsRemove(t.io, parseNames("all"), "global");
  assert.equal(t.lines.filter((l) => l.startsWith("Removed ")).length, 7);
  assert.ok(t.lines.some((l) => l.startsWith("Kept ") && l.includes(verify)));
  assert.equal(readFileSync(verify, "utf8"), "mine\n");
});

test("skills add --project writes inside the folder only, and a second add changes nothing", () => {
  const t = io();
  skillsAdd(t.io, parseNames("coordinate"), "project");
  assert.ok(
    existsSync(
      join(t.io.projectDir, ".claude", "skills", "hawl-coordinate", "SKILL.md"),
    ),
  );
  assert.equal(existsSync(join(t.io.home, ".claude")), false);
  t.lines.length = 0;
  skillsAdd(t.io, parseNames("coordinate"), "project");
  assert.match(t.lines[0] as string, /Nothing to install/);
});
