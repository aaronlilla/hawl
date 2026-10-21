import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { sha256, type WrittenEntry } from "./merge.ts";
import {
  fullNames,
  installSkills,
  listSkills,
  previewSkills,
  removeSkills,
  type StoreDeps,
} from "./skill-store.ts";
import { dropProjectSkills, skillPlansIn } from "./skills.ts";
import { SKILLS } from "./skills-data.ts";

const PLUGIN = join(
  import.meta.dirname,
  "../../../../plugins/claude-code/skills",
);
const NAMES = [
  "hawl-coordinate",
  "hawl-delegate",
  "hawl-verify",
  "hawl-handover",
];
const tmp = () => mkdtempSync(join(tmpdir(), "hawl-skills-"));
const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const entry = (path: string, text: string): WrittenEntry => ({
  path,
  key: "(file)",
  sha256: sha256(text),
});

test("skills follow the Agent Skills spec and the embedded copy matches the plugin source", () => {
  assert.deepEqual(Object.keys(SKILLS), NAMES);
  for (const n of NAMES) {
    const text = readFileSync(join(PLUGIN, n, "SKILL.md"), "utf8");
    assert.equal(SKILLS[n], text, `${n}: run node build/gen-skills.mjs`);
    const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(m, `${n}: frontmatter`);
    const name = /^name: (.+)$/m.exec(m[1] as string)?.[1];
    const desc = /^description: (.+)$/m.exec(m[1] as string)?.[1] ?? "";
    assert.equal(name, n);
    assert.match(n, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(n.length <= 64);
    assert.ok(desc.length > 0 && desc.length <= 1024, `${n}: description`);
    assert.ok(text.split("\n").length < 150, `${n}: under 150 lines`);
    assert.match(text, /data, not instructions/);
  }
});

test("skillPlansIn: create, keep, update a file Hawl wrote, skip any other bytes", () => {
  const dir = join(tmp(), "skills");
  const verify = join(dir, "hawl-verify", "SKILL.md");
  const plan = (wrote: WrittenEntry[]) =>
    skillPlansIn(dir, wrote).find((p) => p.path === verify) as ReturnType<
      typeof skillPlansIn
    >[0];

  assert.equal(plan([]).changed, true); // absent: created
  put(verify, SKILLS["hawl-verify"] as string);
  assert.equal(plan([]).changed, false); // same bytes: kept
  assert.equal(plan([]).skipped.length, 0);

  put(verify, "older\n");
  const up = plan([entry(verify, "older\n")]); // Hawl wrote exactly this
  assert.equal(up.changed, true);
  assert.equal(up.after, SKILLS["hawl-verify"]);

  put(verify, "older, then edited\n");
  const edited = plan([entry(verify, "older\n")]);
  assert.equal(edited.changed, false);
  assert.equal(edited.skipped.length, 1);
  assert.equal(plan([]).skipped.length, 1); // no record at all: the person's file
});

function store(root: string, extra: Partial<StoreDeps> = {}): StoreDeps {
  const projectDir = join(root, "app");
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  return {
    home: join(root, "home"),
    stateDir: join(root, "state"),
    projectDir,
    env: {},
    has: () => false,
    hosts: ["claude_code", "codex"],
    ...extra,
  };
}

test("global scope: both folders, once per machine, update unedited, skip edited, preview lists paths", () => {
  const root = tmp();
  const d = store(root);
  const claude = join(d.home, ".claude", "skills");
  const agents = join(d.home, ".agents", "skills");

  const pv = previewSkills("global", d).join("\n");
  for (const n of NAMES) {
    assert.ok(pv.includes(join(claude, n, "SKILL.md")), pv);
    assert.ok(pv.includes(join(agents, n, "SKILL.md")), pv);
  }
  assert.equal(installSkills("global", d).files.length, 8);

  // Another folder, same machine: nothing to write or preview.
  const other = { ...d, projectDir: join(root, "other") };
  assert.deepEqual(installSkills("global", other), { files: [], skipped: [] });
  assert.deepEqual(previewSkills("global", other), []);

  // Hawl wrote older text for verify; the person edited delegate.
  const verify = join(claude, "hawl-verify", "SKILL.md");
  const delegate = join(agents, "hawl-delegate", "SKILL.md");
  put(verify, "older\n");
  put(delegate, "mine\n");
  const state = join(d.stateDir, "user-skills.json");
  const rec = JSON.parse(readFileSync(state, "utf8"));
  for (const w of rec.written)
    if (w.path === verify) w.sha256 = sha256("older\n");
  writeFileSync(state, JSON.stringify(rec));
  const r = installSkills("global", d);
  assert.deepEqual(r.files, [verify]);
  assert.equal(readFileSync(verify, "utf8"), SKILLS["hawl-verify"]);
  assert.equal(readFileSync(delegate, "utf8"), "mine\n");
  assert.equal(r.skipped.length, 1);
});

test("names pick skills; project scope writes inside the folder; a tool with no folder gets none", () => {
  const root = tmp();
  const d = store(root, { hosts: ["claude_code"], names: ["coordinate", "hawl-verify"] });
  const r = installSkills("project", d);
  assert.deepEqual(
    r.files.map((f) => f.slice(d.projectDir.length + 1).replaceAll("\\", "/")).sort(),
    [".claude/skills/hawl-coordinate/SKILL.md", ".claude/skills/hawl-verify/SKILL.md"],
  );
  assert.ok(existsSync(join(d.projectDir, ".hawl", "skills.json")));
  assert.equal(existsSync(join(d.home, ".claude")), false);
  assert.deepEqual(previewSkills("global", store(tmp(), { hosts: ["gemini", "other"] })), []);
  assert.throws(() => fullNames(["nope"]), /not a Hawl skill/);
});

test("remove deletes what Hawl wrote and keeps edited files; list shows status", () => {
  const d = store(tmp());
  installSkills("global", d);
  const verify = join(d.home, ".claude", "skills", "hawl-verify", "SKILL.md");
  put(verify, "edited\n");
  const rows = listSkills(d);
  assert.equal(rows.length, 8);
  assert.equal(rows.find((r) => r.path === verify)?.status, "edited");
  assert.ok(rows.filter((r) => r !== rows.find((x) => x.path === verify)).every((r) => r.status === "installed"));

  const r = removeSkills("global", d);
  assert.equal(r.removed.length, 7);
  assert.deepEqual(r.kept, [verify]);
  assert.equal(readFileSync(verify, "utf8"), "edited\n");
  assert.equal(existsSync(join(d.home, ".agents", "skills")), false);
  assert.equal(existsSync(join(d.home, ".claude")), true); // the tool's own folder stays
  assert.deepEqual(removeSkills("global", d), { removed: [], kept: [] });
});

test("dropProjectSkills removes unedited Hawl-written project files and their empty folders, keeps edited and unrecorded", () => {
  const proj = tmp();
  const rel = (d: string, n: string) => `${d}/skills/${n}/SKILL.md`;
  const a = rel(".claude", "hawl-verify");
  const b = rel(".agents", "hawl-delegate");
  const c = rel(".devin", "hawl-handover");
  put(join(proj, a), "v1\n");
  put(join(proj, b), "v1 but edited\n");
  put(join(proj, c), "never recorded\n");
  put(join(proj, ".claude", "keep.json"), "{}");
  const entries = [entry(a, "v1\n"), entry(b, "v1\n")];
  const restore = [a, b].map((path) => ({
    path,
    before: null,
    after: sha256("v1\n"),
  }));

  const r = dropProjectSkills(proj, entries, restore);
  assert.deepEqual(r.removed, [a]);
  assert.deepEqual(r.kept, [b]);
  assert.equal(existsSync(join(proj, a)), false);
  assert.equal(existsSync(join(proj, ".claude", "skills")), false);
  assert.equal(existsSync(join(proj, ".claude", "keep.json")), true);
  assert.equal(readFileSync(join(proj, b), "utf8"), "v1 but edited\n");
  assert.equal(readFileSync(join(proj, c), "utf8"), "never recorded\n");
  assert.deepEqual(r.entries, []);
  assert.deepEqual(r.restore, []);
});
