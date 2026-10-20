import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileDurable } from "./fsutil.ts";
import type { WorkerSpec } from "./main.ts";

/**
 * `~/.hawl/workers.json`: every worker this machine runs, so a daemon started at login (or
 * restarted after a crash) reconnects all of them before any agent opens. No secrets: the keys
 * stay in the keychain.
 */
export function workersPath(stateDir: string): string {
  return join(stateDir, "workers.json");
}

function valid(w: unknown): w is WorkerSpec {
  const o = w as Partial<WorkerSpec> | null;
  return (
    !!o &&
    typeof o.relay_url === "string" &&
    typeof o.resident_id === "string" &&
    typeof o.platform === "string"
  );
}

export function readWorkers(stateDir: string): WorkerSpec[] {
  const f = workersPath(stateDir);
  if (!existsSync(f)) return [];
  try {
    const v = JSON.parse(readFileSync(f, "utf8")) as { workers?: unknown };
    return Array.isArray(v.workers) ? v.workers.filter(valid) : [];
  } catch {
    return []; // a torn or hand-edited file must not stop the daemon
  }
}

function write(stateDir: string, workers: WorkerSpec[]): void {
  writeFileDurable(
    workersPath(stateDir),
    `${JSON.stringify({ v: 1, workers }, null, 2)}\n`,
  );
}

export function rememberWorker(stateDir: string, spec: WorkerSpec): void {
  const all = readWorkers(stateDir).filter(
    (w) => w.resident_id !== spec.resident_id,
  );
  all.push({
    relay_url: spec.relay_url,
    resident_id: spec.resident_id,
    platform: spec.platform,
  });
  write(stateDir, all);
}

export function forgetWorker(stateDir: string, residentId: string): void {
  const all = readWorkers(stateDir);
  const rest = all.filter((w) => w.resident_id !== residentId);
  if (rest.length !== all.length) write(stateDir, rest);
}
