import { homedir } from "node:os";
import { defaultStateDir } from "../daemon/main.ts";
import {
  fullNames,
  installSkills,
  listSkills,
  previewSkills,
  removeSkills,
  type Scope,
  SKILL_NAMES,
  type StoreDeps,
} from "../hosts/skill-store.ts";

export const ADD_LATER = "Add them later: hawl skills add all --global";

export interface SkillsIo {
  projectDir: string;
  home?: string;
  stateDir?: string;
  print: (line: string) => void;
  /** Passed through to the store (tests). */
  env?: StoreDeps["env"];
  has?: StoreDeps["has"];
  hosts?: StoreDeps["hosts"];
}

const store = (io: SkillsIo, names?: string[]): StoreDeps => ({
  home: io.home ?? homedir(),
  stateDir: io.stateDir ?? defaultStateDir(),
  projectDir: io.projectDir,
  env: io.env,
  has: io.has,
  hosts: io.hosts,
  names,
});

/** `all`, `none` or `a,b` (short or full names) -> full names. */
export function parseNames(arg: string | undefined): string[] {
  const a = (arg ?? "all").trim();
  if (a === "all") return SKILL_NAMES;
  if (a === "none" || a === "") return [];
  return fullNames(a.split(",").map((s) => s.trim()));
}

function installAt(io: SkillsIo, names: string[], scope: Scope): number {
  const d = store(io, names);
  const r = installSkills(scope, d);
  for (const f of r.files) io.print(`Installed ${f}`);
  for (const s of r.skipped)
    io.print(
      `Kept ${s.path}: ${s.reason.replace(/^file exists; not overwritten$/, "you changed it, so it was not overwritten")}`,
    );
  if (r.files.length === 0 && r.skipped.length === 0)
    io.print(
      "Nothing to install: already in place, or no Claude Code, Codex, Cursor or Devin found.",
    );
  return r.files.length;
}

/** `hawl skills add [names|all] [--global|--project]`. Default scope: global. */
export function skillsAdd(
  io: SkillsIo,
  names: string[],
  scope: Scope = "global",
) {
  installAt(io, names.length ? names : SKILL_NAMES, scope);
}

/** `hawl skills remove [names|all] [--global|--project]`. */
export function skillsRemove(
  io: SkillsIo,
  names: string[],
  scope: Scope = "global",
) {
  const r = removeSkills(scope, store(io, names.length ? names : SKILL_NAMES));
  for (const f of r.removed) io.print(`Removed ${f}`);
  for (const f of r.kept) io.print(`Kept ${f}: you changed it`);
  if (!r.removed.length && !r.kept.length)
    io.print("Nothing to remove: Hawl has no skills installed there.");
}

/** `hawl skills list`: what Hawl installed, where, and whether it is still as written. */
export function skillsList(io: SkillsIo) {
  const rows = listSkills(store(io));
  if (rows.length === 0) io.print(`No Hawl skills installed. ${ADD_LATER}`);
  for (const r of rows)
    io.print(`${r.scope.padEnd(8)}${r.status.padEnd(18)}${r.path}`);
}

export interface OfferOpts {
  /** `--skills all|none|a,b`. Set: install without asking. */
  skills?: string;
  /** `--skills-scope global|project`. Default global. */
  skillsScope?: Scope;
  /** A person at a keyboard: ask. Otherwise install nothing and say how to add them. */
  interactive: boolean;
  ask: (question: string) => Promise<string>;
}

/**
 * The join step for skills. Flags install what they name; a keyboard gets three questions and the
 * exact paths before anything is written; anything else installs nothing.
 */
export async function offerSkills(io: SkillsIo, o: OfferOpts): Promise<void> {
  if (o.skills !== undefined) {
    const names = parseNames(o.skills);
    if (names.length === 0) return;
    installAt(io, names, o.skillsScope ?? "global");
    return;
  }
  if (!o.interactive) {
    io.print(`Hawl's agent skills are not installed. ${ADD_LATER}`);
    return;
  }
  const yes = (
    await o.ask(
      "Install Hawl's agent skills (coordinate, delegate, verify, handover)? [y/N] ",
    )
  )
    .trim()
    .toLowerCase();
  if (yes !== "y" && yes !== "yes") {
    io.print(ADD_LATER);
    return;
  }
  const pick = (
    await o.ask(
      `Which? all, or a comma list of ${SKILL_NAMES.map((n) => n.slice(5)).join(", ")} [all] `,
    )
  ).trim();
  const names = parseNames(pick || "all");
  const where = (
    await o.ask(
      "Where? [g]lobal (every project on this machine) or [p]roject (this folder only) [g] ",
    )
  )
    .trim()
    .toLowerCase();
  const scope: Scope = where.startsWith("p") ? "project" : "global";
  const files = previewSkills(scope, store(io, names));
  if (files.length === 0) {
    io.print(
      "Nothing to install: already in place, or no supported tool found.",
    );
    return;
  }
  io.print("These files will be written:");
  for (const f of files) io.print(`  ${f}`);
  const go = (await o.ask("Write them? [Y/n] ")).trim().toLowerCase();
  if (go === "n" || go === "no") {
    io.print(ADD_LATER);
    return;
  }
  installAt(io, names, scope);
}
