import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileDurable } from "../daemon/fsutil.ts";

export const EXCLUDE_LINE = ".hawl/";

/** `<git dir>/info/exclude` for the folder, or null when it is not a git checkout. */
export function excludePath(projectDir: string): string | null {
  const dotGit = join(projectDir, ".git");
  if (!existsSync(dotGit)) return null;
  let gitDir = dotGit;
  if (statSync(dotGit).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m?.[1]) return null;
    gitDir = resolve(projectDir, m[1].trim());
    // A linked worktree keeps info/exclude in the shared git dir.
    const common = join(gitDir, "commondir");
    if (existsSync(common))
      gitDir = resolve(gitDir, readFileSync(common, "utf8").trim());
  }
  return join(gitDir, "info", "exclude");
}

const hasLine = (text: string) =>
  text.split(/\r?\n/).some((l) => l.trim() === EXCLUDE_LINE);

/** Add `.hawl/` to `.git/info/exclude`. True only when this call added the line. */
export function addExclude(projectDir: string): boolean {
  const f = excludePath(projectDir);
  if (!f) return false;
  const text = existsSync(f) ? readFileSync(f, "utf8") : "";
  if (hasLine(text)) return false;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileDurable(f, `${text}${sep}${EXCLUDE_LINE}\n`);
  return true;
}

/** Remove the line we added. True when it was there. */
export function removeExclude(projectDir: string): boolean {
  const f = excludePath(projectDir);
  if (!f || !existsSync(f)) return false;
  const text = readFileSync(f, "utf8");
  if (!hasLine(text)) return false;
  const rest = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== EXCLUDE_LINE)
    .join("\n");
  writeFileDurable(f, rest);
  return true;
}
