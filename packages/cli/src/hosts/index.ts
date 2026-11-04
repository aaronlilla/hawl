import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { devin } from "./devin.ts";
import { gemini } from "./gemini.ts";
import { other } from "./other.ts";
import type { HostId, HostWriter } from "./types.ts";

export const HOSTS: Record<HostId, HostWriter> = {
  claude_code: claudeCode,
  codex,
  cursor,
  devin,
  gemini,
  other,
};

export const JOIN_HOSTS: HostId[] = [
  "claude_code",
  "codex",
  "cursor",
  "devin",
  "other",
];

export function isHost(s: string): s is HostId {
  return Object.hasOwn(HOSTS, s);
}

/** True when `name` (or `name.exe`/`.cmd`) is in a PATH directory. */
export function onPath(
  name: string,
  pathVar: string = process.env.PATH ?? "",
): boolean {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of ["", ".exe", ".cmd"])
      if (existsSync(join(dir, name + ext))) return true;
  }
  return false;
}

/**
 * Tools found on this machine or in this folder, likeliest first (S-405/S-406).
 * Looks in PATH, ~/.claude, ~/.codex, and .claude/, .codex/, .cursor/, .devin/ in the folder.
 */
export function detectHosts(
  o: { projectDir: string; home: string },
  has: (name: string) => boolean = onPath,
): HostId[] {
  const found: HostId[] = [];
  const dir = (...p: string[]) => existsSync(join(...p));
  if (has("claude") || dir(o.home, ".claude") || dir(o.projectDir, ".claude"))
    found.push("claude_code");
  if (has("codex") || dir(o.home, ".codex") || dir(o.projectDir, ".codex"))
    found.push("codex");
  if (dir(o.projectDir, ".cursor")) found.push("cursor");
  if (dir(o.projectDir, ".devin")) found.push("devin");
  return found;
}

export type { HostCtx, HostId, HostWriter } from "./types.ts";
