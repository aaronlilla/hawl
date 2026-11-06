export interface RunResult {
  status: number;
  stderr: string;
}

/** Runs an OS tool; injected so tests never touch the real scheduler. */
export type Runner = (cmd: string, args: string[]) => RunResult;

export const TASK_NAME = "hawl-daemon";
export const LAUNCH_LABEL = "com.hawl.daemon";
export const UNIT_NAME = "hawl-daemon.service";

export function check(r: RunResult, what: string): void {
  if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr.trim()}`);
}
