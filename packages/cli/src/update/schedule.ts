import { applyPending, type CheckDeps, checkAndStage } from "./apply.ts";

export const DAY_MS = 24 * 60 * 60_000;

export type UpdaterDeps = Omit<CheckDeps, "channel" | "force"> & {
  log?: (line: string) => void;
  intervalMs?: number;
};

/**
 * Spec 16 section 3.7 in the daemon: swap a staged update before serving, then check once a
 * day. The automatic check is `latest` only and never forced past `update.auto: false`.
 * Never throws; returns a stop function. The timer is unref'd.
 */
export function startUpdater(d: UpdaterDeps): () => void {
  const log = d.log ?? (() => {});
  try {
    const r = applyPending({
      stateDir: d.stateDir,
      binPath: d.binPath,
      current: d.current,
    });
    if (r.status === "applied")
      log(
        `hawl updated ${r.from} to ${r.to}. What's new: hawl.ai/changelog (takes effect on the next restart)`,
      );
  } catch (e) {
    log(`hawl update swap failed: ${(e as Error).message}`);
  }
  const check = () =>
    checkAndStage({ ...d, channel: "latest" }).catch((e: Error) =>
      log(`hawl update check failed: ${e.message}`),
    );
  void check();
  const timer = setInterval(() => void check(), d.intervalMs ?? DAY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
