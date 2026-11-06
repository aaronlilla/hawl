import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileDurable } from "../daemon/fsutil.ts";
import { readProjectId } from "../project-id.ts";
import { detectHosts, onPath } from "./index.ts";
import { sha256, type WrittenEntry } from "./merge.ts";
import { skillPlansIn } from "./skills.ts";
import { SKILLS } from "./skills-data.ts";
import type { HostId } from "./types.ts";

/**
 * Where the four Hawl skills can live, from each tool's own docs (checked 2026-10-21):
 * - Claude Code: `~/.claude/skills/<name>/SKILL.md` (user) and `.claude/skills/` (project):
 *   code.claude.com/docs/en/skills, "Personal" and "Project".
 * - Codex: `$HOME/.agents/skills` (USER) and `.agents/skills` (REPO): learn.chatgpt.com/docs/build-skills.
 * - Cursor: `~/.agents/skills/` and `.agents/skills/`: cursor.com/docs/context/skills.
 * - Devin CLI: `~/.agents/skills/<name>/SKILL.md` (Global) and `.agents/skills/<name>/SKILL.md`
 *   (project): docs.devin.ai/cli/extensibility/skills/overview.
 * So two folders per scope cover all four tools. Gemini CLI and custom tools get none.
 *
 * What Hawl wrote is recorded per scope (global: `<stateDir>/user-skills.json`; project:
 * `<project>/.hawl/skills.json`) as path and hash. Install creates, updates a file whose bytes
 * are still what Hawl wrote, and never overwrites or deletes an edited one. Nothing here runs
 * unless the person asks: `hawl skills add`, the join question, or the join flags.
 */
export type Scope = "global" | "project";

export interface StoreDeps {
  home: string;
  stateDir: string;
  projectDir: string;
  /** For CLAUDE_CONFIG_DIR. Default: process.env. */
  env?: Record<string, string | undefined>;
  has?: (name: string) => boolean;
  /** Tools whose folders count even when not found on this machine. */
  hosts?: HostId[];
  /** Short or full skill names; default all four. */
  names?: string[];
}

export const SKILL_NAMES = Object.keys(SKILLS);

/** `coordinate` or `hawl-coordinate` -> `hawl-coordinate`. Throws on an unknown name. */
export function fullNames(list: string[]): string[] {
  return list.map((n) => {
    const full = n.startsWith("hawl-") ? n : `hawl-${n}`;
    if (!SKILL_NAMES.includes(full))
      throw new Error(
        `"${n}" is not a Hawl skill. Pick from: ${SKILL_NAMES.join(", ")}.`,
      );
    return full;
  });
}

const stateFile = (scope: Scope, d: StoreDeps) =>
  scope === "global"
    ? join(d.stateDir, "user-skills.json")
    : join(d.projectDir, ".hawl", "skills.json");

function readState(scope: Scope, d: StoreDeps): WrittenEntry[] {
  try {
    const j = JSON.parse(readFileSync(stateFile(scope, d), "utf8"));
    return Array.isArray(j.written) ? j.written : [];
  } catch {
    return [];
  }
}

const writeState = (scope: Scope, d: StoreDeps, written: WrittenEntry[]) =>
  writeFileDurable(
    stateFile(scope, d),
    `${JSON.stringify({ v: 1, written }, null, 2)}\n`,
  );

/** Tools joined in this folder plus tools found here. */
function foldersHosts(d: StoreDeps): HostId[] {
  const joined = (["claude_code", "codex", "cursor", "devin"] as const).filter(
    (h) => readProjectId(h, d.projectDir) !== null,
  );
  return [...new Set([...(d.hosts ?? []), ...joined])];
}

/** The skills folders that apply in this scope. */
export function skillDirs(scope: Scope, d: StoreDeps): string[] {
  const env = d.env ?? process.env;
  const has = d.has ?? ((n) => onPath(n));
  const hosts =
    scope === "global"
      ? (d.hosts ?? [])
      : [...foldersHosts(d), ...detectHosts(d, has)];
  const claudeRoot = env.CLAUDE_CONFIG_DIR || join(d.home, ".claude");
  const codexRoot = env.CODEX_HOME || join(d.home, ".codex");
  const out: string[] = [];
  const claude =
    hosts.includes("claude_code") ||
    (scope === "global" && (has("claude") || existsSync(claudeRoot)));
  const agents =
    hosts.some((h) => h === "codex" || h === "cursor" || h === "devin") ||
    (scope === "global" && (has("codex") || existsSync(codexRoot)));
  if (claude)
    out.push(
      scope === "global"
        ? join(claudeRoot, "skills")
        : join(d.projectDir, ".claude", "skills"),
    );
  if (agents)
    out.push(
      join(scope === "global" ? d.home : d.projectDir, ".agents", "skills"),
    );
  return out;
}

function plans(scope: Scope, d: StoreDeps) {
  const wrote = readState(scope, d);
  const want = d.names ? fullNames(d.names) : SKILL_NAMES;
  return skillDirs(scope, d).flatMap((dir) =>
    skillPlansIn(dir, wrote).filter((p) =>
      want.includes(basename(dirname(p.path))),
    ),
  );
}

/** The files an install would create or update. Nothing is written. */
export function previewSkills(scope: Scope, d: StoreDeps): string[] {
  return plans(scope, d)
    .filter((p) => p.changed)
    .map((p) => p.path);
}

/** Install or update. An edited file is skipped and named. */
export function installSkills(scope: Scope, d: StoreDeps) {
  const out = {
    files: [] as string[],
    skipped: [] as { path: string; reason: string }[],
  };
  const written = readState(scope, d);
  for (const p of plans(scope, d)) {
    try {
      if (p.changed) {
        mkdirSync(dirname(p.abs), { recursive: true });
        writeFileSync(p.abs, p.after);
        out.files.push(p.path);
      }
    } catch (e) {
      out.skipped.push({ path: p.path, reason: (e as Error).message });
      continue;
    }
    for (const e of p.entries) {
      const i = written.findIndex((w) => w.path === e.path);
      if (i >= 0) written[i] = e;
      else written.push(e);
    }
    for (const s of p.skipped)
      out.skipped.push({ path: p.path, reason: s.reason });
  }
  if (out.files.length || written.length) writeState(scope, d, written);
  return out;
}

/** Remove the named skills Hawl wrote and nobody edited; an edited file stays and is named. */
export function removeSkills(scope: Scope, d: StoreDeps) {
  const want = d.names ? fullNames(d.names) : SKILL_NAMES;
  const out = { removed: [] as string[], kept: [] as string[] };
  const keep: WrittenEntry[] = [];
  for (const e of readState(scope, d)) {
    if (!want.includes(basename(dirname(e.path)))) {
      keep.push(e);
      continue;
    }
    if (!existsSync(e.path)) continue;
    if (sha256(readFileSync(e.path, "utf8")) !== e.sha256) {
      out.kept.push(e.path);
      continue;
    }
    rmSync(e.path);
    out.removed.push(e.path);
    // Drop the skill folder and an empty skills folder; never the tool's own folder above it.
    for (const dir of [dirname(e.path), dirname(dirname(e.path))])
      try {
        rmdirSync(dir);
      } catch {
        break;
      }
  }
  if (out.removed.length || out.kept.length) writeState(scope, d, keep);
  return out;
}

export interface SkillRow {
  scope: Scope;
  path: string;
  status: "installed" | "update available" | "edited" | "missing";
}

/** What Hawl installed, per scope, and whether each file is still as written. */
export function listSkills(d: StoreDeps): SkillRow[] {
  return (["global", "project"] as const).flatMap((scope) =>
    readState(scope, d).map((e): SkillRow => {
      if (!existsSync(e.path))
        return { scope, path: e.path, status: "missing" };
      const now = readFileSync(e.path, "utf8");
      const name = basename(dirname(e.path));
      const status =
        sha256(now) !== e.sha256
          ? "edited"
          : now === SKILLS[name]
            ? "installed"
            : "update available";
      return { scope, path: e.path, status };
    }),
  );
}
