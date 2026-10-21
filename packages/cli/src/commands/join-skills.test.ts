import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as pjoin, relative } from "node:path";
import test from "node:test";
import { MemoryKeyStore } from "../daemon/keys.ts";
import { sha256 } from "../hosts/merge.ts";
import { SKILLS } from "../hosts/skills-data.ts";
import { type JoinOpts, join } from "./join.ts";
import { joinLocal } from "./join-local.ts";

const json = (o: unknown, status: number) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json" },
  });

const fakeRelay = (async (input: unknown) =>
  String(input).endsWith("/v1/join/start")
    ? json(
        {
          join_id: "jrq_1",
          user_code: "ABCD-EFGH",
          key_fingerprint: "7F3A-91C2",
          expires_in: 600,
        },
        201,
      )
    : json(
        {
          resident_id: "res_NEW",
          kid: "k1",
          town_id: "t1",
          relay_url: "https://relay.test",
          needs_owner_approval: false,
        },
        200,
      )) as typeof fetch;

/** `home` is a temp dir, never the real one. */
const deps = (
  root: string,
  lines: string[],
  extra: Record<string, unknown> = {},
) => ({
  home: root,
  stateDir: pjoin(root, "state"),
  keyStore: new MemoryKeyStore(),
  fetch: fakeRelay,
  print: (l: string) => lines.push(l),
  sleep: async () => {},
  ensureDaemon: async () => {},
  daemon: () => ({
    call: async () => ({ envelopes: [{ relay: { origin: "system" } }] }),
  }),
  skillsStore: { has: () => false, env: {} },
  ...extra,
});

const walk = (d: string): string[] =>
  existsSync(d)
    ? readdirSync(d).flatMap((n) => {
        const p = pjoin(d, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];
const skillFiles = (d: string) =>
  walk(d)
    .map((f) => relative(d, f).split("\\").join("/"))
    .filter((f) => f.includes("/skills/"))
    .sort();

function folder() {
  const root = mkdtempSync(pjoin(tmpdir(), "hawl-joinsk-"));
  const projectDir = pjoin(root, "app");
  mkdirSync(projectDir, { recursive: true });
  return { root, projectDir };
}

const NAMES = Object.keys(SKILLS);
const opts = (projectDir: string, more: Partial<JoinOpts> = {}): JoinOpts => ({
  site: "acme",
  hosts: ["claude_code", "codex"],
  projectDir,
  yes: true,
  ...more,
});

test("join without a keyboard or flags installs no skills and says how to add them", async () => {
  const { root, projectDir } = folder();
  const lines: string[] = [];
  await join(opts(projectDir), deps(root, lines));
  assert.deepEqual(skillFiles(root), []);
  assert.ok(
    lines.some(
      (l) =>
        l.includes("skills are not installed") &&
        l.includes("hawl skills add all --global"),
    ),
  );
  assert.ok(
    lines.some((l) => l.startsWith("Agent skills are optional")),
    "preview mentions them",
  );
});

test("--skills all installs globally by default; names and --skills-scope project go where asked", async () => {
  const a = folder();
  await join(opts(a.projectDir, { skills: "all" }), deps(a.root, []));
  assert.equal(skillFiles(a.root).length, 8); // 4 skills x (.claude, .agents)
  assert.deepEqual(skillFiles(a.projectDir), []);

  const b = folder();
  const lines: string[] = [];
  await join(
    opts(b.projectDir, { skills: "coordinate,verify", skillsScope: "project" }),
    deps(b.root, lines),
  );
  assert.deepEqual(skillFiles(b.projectDir), [
    ".agents/skills/hawl-coordinate/SKILL.md",
    ".agents/skills/hawl-verify/SKILL.md",
    ".claude/skills/hawl-coordinate/SKILL.md",
    ".claude/skills/hawl-verify/SKILL.md",
  ]);
  assert.equal(
    walk(b.root).some((f) => f.includes(pjoin(b.root, ".claude"))),
    false,
  );

  const c = folder();
  await join(opts(c.projectDir, { skills: "none" }), deps(c.root, []));
  assert.deepEqual(skillFiles(c.root), []);
});

test("at a keyboard join asks, shows the exact paths, then writes", async () => {
  const { root, projectDir } = folder();
  const lines: string[] = [];
  const answers = ["y", "all", "g", "y"];
  const asked: string[] = [];
  await join(
    opts(projectDir, { yes: false }),
    deps(root, lines, {
      isTTY: true,
      ask: async (q: string) => {
        asked.push(q);
        // "Continue? [Y/n/d]" comes first, then the four skill questions.
        return q.startsWith("Continue?") ? "y" : (answers.shift() ?? "n");
      },
    }),
  );
  assert.ok(asked.some((q) => q.startsWith("Install Hawl's agent skills")));
  for (const n of NAMES)
    assert.ok(
      lines.includes(`  ${pjoin(root, ".claude", "skills", n, "SKILL.md")}`),
      n,
    );
  assert.equal(skillFiles(root).length, 8);
});

test("saying no at the keyboard installs nothing", async () => {
  const { root, projectDir } = folder();
  await join(
    opts(projectDir, { yes: false }),
    deps(root, [], {
      isTTY: true,
      ask: async (q: string) => (q.startsWith("Continue?") ? "y" : ""),
    }),
  );
  assert.deepEqual(skillFiles(root), []);
});

test("re-join removes the project skill files npm 0.1.12 wrote, unless edited, and says so", async () => {
  const { root, projectDir } = folder();
  const o = opts(projectDir, { hosts: ["claude_code"] });
  await join(o, deps(root, []));

  const townPath = pjoin(projectDir, ".hawl", "hawl.json");
  const town = JSON.parse(readFileSync(townPath, "utf8"));
  const rel = (n: string) => `.claude/skills/${n}/SKILL.md`;
  for (const n of NAMES) {
    mkdirSync(dirname(pjoin(projectDir, rel(n))), { recursive: true });
    writeFileSync(pjoin(projectDir, rel(n)), SKILLS[n] as string);
    const h = sha256(SKILLS[n] as string);
    town.written.push({
      resident_id: "res_NEW",
      path: rel(n),
      key: "(file)",
      sha256: h,
    });
    town.restore.push({
      resident_id: "res_NEW",
      path: rel(n),
      before: null,
      after: h,
    });
  }
  writeFileSync(townPath, JSON.stringify(town));
  writeFileSync(pjoin(projectDir, rel("hawl-delegate")), "my own version\n");

  const lines: string[] = [];
  await join(o, deps(root, lines));
  assert.deepEqual(skillFiles(projectDir), [rel("hawl-delegate")]);
  assert.equal(
    readFileSync(pjoin(projectDir, rel("hawl-delegate")), "utf8"),
    "my own version\n",
  );
  assert.equal(lines.filter((l) => l.startsWith("Removed ")).length, 3);
  assert.ok(lines.some((l) => l.startsWith(`Kept ${rel("hawl-delegate")}`)));
});

test("join --local: project copies from npm 0.1.12 go unless edited", async () => {
  const { root, projectDir } = folder();
  const rel = (n: string) => `.claude/skills/${n}/SKILL.md`;
  const entries = NAMES.map((n) => {
    mkdirSync(dirname(pjoin(projectDir, rel(n))), { recursive: true });
    writeFileSync(pjoin(projectDir, rel(n)), SKILLS[n] as string);
    return { path: rel(n), key: "(file)", sha256: sha256(SKILLS[n] as string) };
  });
  mkdirSync(pjoin(projectDir, ".hawl"), { recursive: true });
  writeFileSync(
    pjoin(projectDir, ".hawl", "local-skills.json"),
    JSON.stringify(entries),
  );
  writeFileSync(pjoin(projectDir, rel("hawl-verify")), "edited\n");

  const r = await joinLocal({
    projectDir,
    dir: pjoin(root, "hub"),
    handle: "@a",
  });
  assert.deepEqual(skillFiles(projectDir), [rel("hawl-verify")]);
  assert.deepEqual(r.projectSkills.kept, [rel("hawl-verify")]);
  assert.equal(r.projectSkills.removed.length, 3);
});
