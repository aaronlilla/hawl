import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { writeFileDurable } from "../daemon/fsutil.ts";
import {
  compareVersions,
  planUpdate,
  type UpdateAsset,
  verifyUpdateManifest,
} from "./manifest.ts";

/** `~/.hawl/config.json` `update.auto`; only an explicit `false` turns updates off. */
export function autoUpdateEnabled(stateDir: string): boolean {
  try {
    const f = join(stateDir, "config.json");
    if (!existsSync(f)) return true;
    const c = JSON.parse(readFileSync(f, "utf8")) as {
      update?: { auto?: unknown };
    };
    return c.update?.auto !== false;
  } catch {
    return true;
  }
}

export interface Pending {
  version: string;
  sha256: string;
  staged: string;
}

function pendingFile(stateDir: string): string {
  return join(stateDir, "update-pending.json");
}

export function readPending(stateDir: string): Pending | null {
  try {
    return JSON.parse(readFileSync(pendingFile(stateDir), "utf8")) as Pending;
  } catch {
    return null;
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface CheckDeps {
  stateDir: string;
  /** Path of the running binary. The staged copy sits beside it so the swap is one rename. */
  binPath: string;
  current: string;
  channel: string;
  os: string;
  arch: string;
  fetchManifest: () => Promise<unknown>;
  download: (url: string) => Promise<Uint8Array>;
  /** `hawl update` typed by a person: run even when `update.auto` is false. */
  force?: boolean;
  /** Pinned key override (tests). */
  pubkey?: Parameters<typeof verifyUpdateManifest>[1];
}

export type CheckResult =
  | { status: "staged"; version: string }
  | { status: "skipped"; reason: "auto_off" | "up_to_date" }
  | { status: "refused"; reason: string };

/** Daily check: verify signature, plan, download, verify sha256, stage. Never swaps. */
export async function checkAndStage(d: CheckDeps): Promise<CheckResult> {
  if (!d.force && !autoUpdateEnabled(d.stateDir)) {
    return { status: "skipped", reason: "auto_off" };
  }
  const v = verifyUpdateManifest(await d.fetchManifest(), d.pubkey);
  if (!v.ok) return { status: "refused", reason: v.reason };
  const plan = planUpdate(v.manifest, d);
  if (!plan.ok) {
    return plan.reason === "up_to_date"
      ? { status: "skipped", reason: "up_to_date" }
      : { status: "refused", reason: plan.reason };
  }
  const bytes = await d.download(plan.asset.url);
  return stage(d, plan.version, plan.asset, bytes);
}

function stage(
  d: CheckDeps,
  version: string,
  asset: UpdateAsset,
  bytes: Uint8Array,
): CheckResult {
  if (sha256Hex(bytes) !== asset.sha256) {
    return { status: "refused", reason: "sha256" };
  }
  const staged = `${d.binPath}.next`;
  writeFileSync(staged, bytes, { mode: 0o755 });
  const p: Pending = { version, sha256: asset.sha256, staged };
  writeFileDurable(pendingFile(d.stateDir), JSON.stringify(p));
  return { status: "staged", version };
}

export interface ApplyDeps {
  stateDir: string;
  binPath: string;
  current: string;
}

export type ApplyResult =
  | { status: "applied"; from: string; to: string }
  | { status: "none" }
  | { status: "skipped"; reason: "auto_off" }
  | { status: "refused"; reason: "sha256" | "downgrade" | "missing" };

/**
 * Run at daemon restart, before the new binary is exec'd. Re-checks the staged bytes and the
 * version, then swaps with two renames and rolls back if the second one fails.
 * The caller prints the one-line notice with the changelog link.
 */
export function applyPending(d: ApplyDeps): ApplyResult {
  const p = readPending(d.stateDir);
  if (!p) return { status: "none" };
  if (!autoUpdateEnabled(d.stateDir)) {
    return { status: "skipped", reason: "auto_off" };
  }
  const drop = (reason: "sha256" | "downgrade" | "missing"): ApplyResult => {
    rmSync(p.staged, { force: true });
    rmSync(pendingFile(d.stateDir), { force: true });
    return { status: "refused", reason };
  };
  if (!existsSync(p.staged)) return drop("missing");
  if (sha256Hex(readFileSync(p.staged)) !== p.sha256) return drop("sha256");
  if (compareVersions(p.version, d.current) <= 0) return drop("downgrade");
  const old = `${d.binPath}.old`;
  rmSync(old, { force: true });
  renameSync(d.binPath, old);
  try {
    renameSync(p.staged, d.binPath);
  } catch (e) {
    renameSync(old, d.binPath);
    throw e;
  }
  rmSync(pendingFile(d.stateDir), { force: true });
  return { status: "applied", from: d.current, to: p.version };
}
