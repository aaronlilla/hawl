import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@hawl/protocol/src/ids.ts";
import { writeFileDurable } from "./daemon/fsutil.ts";
import type { RestoreRecord, WrittenEntry } from "./hosts/merge.ts";

export interface WorkerRef {
  resident_id: string;
  platform: string;
  kid: string;
}

export interface Membership {
  town_id: string;
  town_slug: string;
  relay_url: string;
  workers: WorkerRef[];
}

/** A written entry plus the worker that asked for it, so `leave` removes only its own. */
export interface OwnedEntry extends WrittenEntry {
  resident_id: string;
}

/** `.hawl/hawl.json` (spec 16 §3.4). No secrets. */
export interface TownFile {
  v: 1;
  village_id: string;
  folder_label: string;
  memberships: Membership[];
  written: OwnedEntry[];
  /** Hash records that let an untouched file return to its original bytes. */
  restore: (RestoreRecord & { resident_id: string })[];
  /** True when join added `.hawl/` to `.git/info/exclude`, so leave takes the line out again. */
  exclude?: boolean;
  /** `hawl config wake on|off` (or `hawl wake on|off`): idle wake for this folder. Absent means on. */
  wake?: boolean;
  /** `hawl config stop-hook on|off`: Stop and mid-task notices for aimed mail. Absent means on. */
  stop_hook?: boolean;
}

export const townDir = (projectDir: string) => join(projectDir, ".hawl");
export const townPath = (projectDir: string) =>
  join(townDir(projectDir), "hawl.json");

export function readTownFile(projectDir: string): TownFile | null {
  const f = townPath(projectDir);
  if (!existsSync(f)) return null;
  const j = JSON.parse(readFileSync(f, "utf8")) as TownFile;
  if (j.v !== 1) throw new Error(`unknown .hawl/hawl.json version ${j.v}`);
  return j;
}

export function newTownFile(folderLabel: string): TownFile {
  return {
    v: 1,
    village_id: newId("vil"),
    folder_label: folderLabel,
    memberships: [],
    written: [],
    restore: [],
  };
}

export function writeTownFile(projectDir: string, t: TownFile): void {
  writeFileDurable(join(townDir(projectDir), ".gitignore"), "*\n");
  writeFileDurable(townPath(projectDir), `${JSON.stringify(t, null, 2)}\n`);
}

/** Add or update a membership and worker. */
export function addWorker(
  t: TownFile,
  m: Omit<Membership, "workers">,
  w: WorkerRef,
): void {
  let mem = t.memberships.find((x) => x.town_id === m.town_id);
  if (!mem) {
    mem = { ...m, workers: [] };
    t.memberships.push(mem);
  }
  mem.workers = [
    ...mem.workers.filter((x) => x.resident_id !== w.resident_id),
    w,
  ];
}

export function dropWorker(t: TownFile, residentId: string): void {
  for (const m of t.memberships)
    m.workers = m.workers.filter((w) => w.resident_id !== residentId);
  t.memberships = t.memberships.filter((m) => m.workers.length > 0);
  t.written = t.written.filter((e) => e.resident_id !== residentId);
  t.restore = t.restore.filter((r) => r.resident_id !== residentId);
}

/** Remove `.hawl/` once nothing is left in it. */
export function removeTownDir(projectDir: string): void {
  rmSync(townDir(projectDir), { recursive: true, force: true });
}
