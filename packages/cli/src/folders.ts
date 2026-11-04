import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileDurable } from "./daemon/fsutil.ts";

/**
 * `~/.hawl/folders.json`: the folders on this PC that have joined a site, so `hawl share --list`
 * can show all of them. Paths only. A folder stays listed after `hawl share --stop` (private again).
 */
const file = (stateDir: string) => join(stateDir, "folders.json");

export function readFolders(stateDir: string): string[] {
  try {
    const v = JSON.parse(readFileSync(file(stateDir), "utf8")) as {
      folders?: unknown;
    };
    return Array.isArray(v.folders)
      ? v.folders.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return []; // missing or torn file: start over
  }
}

export function rememberFolder(stateDir: string, dir: string): void {
  const d = resolve(dir);
  const all = readFolders(stateDir);
  if (all.includes(d)) return;
  writeFileDurable(
    file(stateDir),
    `${JSON.stringify({ v: 1, folders: [...all, d] }, null, 2)}\n`,
  );
}

/** Folders that still exist on disk. */
export const liveFolders = (stateDir: string): string[] =>
  readFolders(stateDir).filter((d) => existsSync(d));
