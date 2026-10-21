import { join } from "node:path";
import {
  type FilePlan,
  planNewFile,
  type RestoreRecord,
  readIfExists,
  removeEntries,
  sha256,
  type WrittenEntry,
} from "./merge.ts";
import { SKILLS } from "./skills-data.ts";

/**
 * One file per skill under `dir`. Absent: created. Same bytes: kept. Different bytes: replaced only
 * when they are exactly what Hawl wrote before (`wrote` holds its hashes); otherwise it is the
 * person's file and is skipped, not overwritten. `dir` is absolute; so are the plan paths.
 */
export function skillPlansIn(
  dir: string,
  wrote: readonly WrittenEntry[] = [],
): FilePlan[] {
  return Object.entries(SKILLS).map(([name, text]) => {
    const path = join(dir, name, "SKILL.md");
    const before = readIfExists(path);
    const ours =
      before !== null &&
      before !== text &&
      wrote.some((w) => w.path === path && w.sha256 === sha256(before));
    if (!ours) return planNewFile(path, path, text, before);
    return {
      path,
      abs: path,
      before,
      after: text,
      entries: [{ path, key: "(file)", sha256: sha256(text) }],
      skipped: [],
      changed: true,
    };
  });
}

/** Where earlier Hawl versions wrote the skills inside a project folder. */
const PROJECT_SKILL =
  /^\.(claude|agents|devin|cursor)\/skills\/hawl-(coordinate|delegate|verify|handover)\/SKILL\.md$/;

/**
 * Skills are global now. Take back the project copies earlier versions wrote: a file whose bytes
 * still match a hash Hawl recorded goes (with the empty folders it made); an edited one stays.
 * `entries` and `restore` are the folder's records; returns what is left of them.
 */
export function dropProjectSkills(
  projectDir: string,
  entries: readonly WrittenEntry[],
  restore: readonly RestoreRecord[],
): {
  removed: string[];
  kept: string[];
  entries: WrittenEntry[];
  restore: RestoreRecord[];
} {
  const mine = entries.filter((e) => PROJECT_SKILL.test(e.path));
  const paths = [...new Set(mine.map((e) => e.path))];
  const removed: string[] = [];
  const kept: string[] = [];
  const dirs = { projectDir, stateDir: "" };
  for (const path of paths) {
    const uniq = new Map(
      mine.filter((e) => e.path === path).map((e) => [e.sha256, e]),
    );
    const r = removeEntries(
      join(projectDir, path),
      path,
      [...uniq.values()],
      restore.find((x) => x.path === path),
      dirs,
    );
    (r.kept.length ? kept : removed).push(path);
  }
  return {
    removed,
    kept,
    entries: entries.filter((e) => !paths.includes(e.path)),
    restore: restore.filter((r) => !paths.includes(r.path)),
  };
}
