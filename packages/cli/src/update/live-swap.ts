import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileDurable } from "../daemon/fsutil.ts";
import { winCommandLine } from "../shell.ts";
import { applyPending, autoUpdateEnabled, readPending } from "./apply.ts";
import { compareVersions, verifyUpdateManifest } from "./manifest.ts";

/**
 * The shared helper replaces itself while agent sessions stay open. The shims (`hawl mcp`) call
 * the helper once per request and retry when it is down, so a restart costs them one retry.
 * npx users have no binary to swap: the helper stages `hawl.ai@X` under `~/.hawl/versions/X/`
 * and points `~/.hawl/versions/current` (a JSON file, not a symlink, for Windows) at it.
 */
export interface Current {
  version: string;
  entry: string;
}

export const currentFile = (stateDir: string) =>
  join(stateDir, "versions", "current");

/** The staged npx version, or null when none is staged or its files are gone. */
export function readCurrent(stateDir: string): Current | null {
  try {
    const c = JSON.parse(
      readFileSync(currentFile(stateDir), "utf8"),
    ) as Current;
    return typeof c.version === "string" &&
      typeof c.entry === "string" &&
      existsSync(c.entry)
      ? c
      : null;
  } catch {
    return null;
  }
}

/** The staged version when it is newer than `own`. Never throws. */
export function newerCurrent(stateDir: string, own: string): Current | null {
  const c = readCurrent(stateDir);
  try {
    return c && compareVersions(c.version, own) > 0 ? c : null;
  } catch {
    return null;
  }
}

export type Install = (dir: string, spec: string) => Promise<void>;

/** `npm install --prefix <dir> hawl.ai@X`. No lifecycle scripts: the keyring ships prebuilt. */
export const npmInstall: Install = (dir, spec) =>
  new Promise((resolve, reject) => {
    const args = [
      "install",
      "--prefix",
      dir,
      spec,
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
    ];
    const win = process.platform === "win32";
    const p = win
      ? spawn(winCommandLine("npm", args), { shell: true, stdio: "ignore" })
      : spawn("npm", args, { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (c) =>
      c === 0 ? resolve() : reject(new Error(`npm install exit ${c}`)),
    );
  });

/**
 * Stage `hawl.ai@version` and point `current` at it. With `integrity` (from the signed
 * manifest's `npm` field) the installed lock entry must match, else the dir is dropped.
 */
export async function stageNpm(d: {
  stateDir: string;
  version: string;
  integrity?: string;
  install?: Install;
}): Promise<Current> {
  const dir = join(d.stateDir, "versions", d.version);
  const entry = join(dir, "node_modules", "hawl.ai", "dist", "main.js");
  if (!existsSync(entry))
    await (d.install ?? npmInstall)(dir, `hawl.ai@${d.version}`);
  if (d.integrity) {
    let got: unknown;
    try {
      got = (
        JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as {
          packages: Record<string, { integrity?: string }>;
        }
      ).packages["node_modules/hawl.ai"]?.integrity;
    } catch {
      got = undefined;
    }
    if (got !== d.integrity) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error("npm integrity mismatch");
    }
  }
  if (!existsSync(entry)) throw new Error("staged package has no dist/main.js");
  const c = { version: d.version, entry };
  writeFileDurable(currentFile(d.stateDir), JSON.stringify(c));
  return c;
}

/** Daily check for npx helpers: verified manifest, newer version, stage it. Never swaps. */
export async function stageLatestNpm(d: {
  stateDir: string;
  current: string;
  fetchManifest: () => Promise<unknown>;
  pubkey?: Parameters<typeof verifyUpdateManifest>[1];
  install?: Install;
}): Promise<"staged" | "none"> {
  // 0.0.0 is an unstamped source build (e2e, local stack): every release looks newer and would replace it.
  if (d.current === "0.0.0" || !autoUpdateEnabled(d.stateDir)) return "none";
  const v = verifyUpdateManifest(await d.fetchManifest(), d.pubkey);
  if (!v.ok) throw new Error(`manifest refused: ${v.reason}`);
  // `npm` is read defensively: the manifest schema owner adds it.
  const npm = (
    v.manifest as { npm?: { version?: unknown; integrity?: unknown } }
  ).npm;
  const version =
    typeof npm?.version === "string" ? npm.version : v.manifest.version;
  if (compareVersions(version, d.current) <= 0) return "none";
  if (newerCurrent(d.stateDir, d.current)?.version === version) return "none";
  await stageNpm({
    stateDir: d.stateDir,
    version,
    integrity: typeof npm?.integrity === "string" ? npm.integrity : undefined,
    install: d.install,
  });
  return "staged";
}

export interface Next {
  version: string;
  /** Starts the new helper. Called after the old one released the socket. */
  launch: () => void;
}

/** Next helper for an npx install: the staged package, run with the same node. */
export function npxNext(
  stateDir: string,
  own: string,
  execPath = process.execPath,
): Next | null {
  const c = newerCurrent(stateDir, own);
  if (!c) return null;
  return {
    version: c.version,
    launch: () => {
      const p = spawn(execPath, [c.entry, "daemon"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, HAWL_HOME: stateDir },
      });
      p.on("error", () => {});
      p.unref();
    },
  };
}

export interface SwapDeps {
  stateDir: string;
  /** What the next helper would replace (an older or equal version is never swapped in). */
  next: () => Next | null;
  /** True while no proxied tool call is in flight. */
  idle: () => boolean;
  /** Releases the socket or pipe so the new helper can bind. */
  stop: () => Promise<void>;
  log?: (line: string) => void;
  current: string;
  drainMs?: number;
  pollMs?: number;
}

/**
 * Swap when a newer helper is staged and nothing is in flight. Waits up to `drainMs` for idle,
 * else gives up ("busy", try again later). `update.auto: false` never swaps.
 */
export async function swapWhenIdle(
  d: SwapDeps,
): Promise<"swapped" | "busy" | "none"> {
  if (!autoUpdateEnabled(d.stateDir)) return "none";
  const n = d.next();
  if (!n) return "none";
  const until = Date.now() + (d.drainMs ?? 30_000);
  while (!d.idle()) {
    if (Date.now() >= until) return "busy";
    await new Promise((r) => setTimeout(r, d.pollMs ?? 100));
  }
  await d.stop();
  n.launch();
  d.log?.(`helper swap ${d.current} to ${n.version}`);
  return "swapped";
}

/** SEA binary: the daily check already staged `.next`; swap the file, then run the new binary. */
export function seaNext(d: {
  stateDir: string;
  binPath: string;
  current: string;
}): Next | null {
  const p = readPending(d.stateDir);
  try {
    if (!p || compareVersions(p.version, d.current) <= 0) return null;
  } catch {
    return null;
  }
  return {
    version: p.version,
    launch: () => {
      applyPending(d);
      const c = spawn(d.binPath, ["daemon"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, HAWL_HOME: d.stateDir },
      });
      c.on("error", () => {});
      c.unref();
    },
  };
}

/**
 * The shim's tool list is owned by the shim (list_changed is not honoured by every host), so a
 * helper swap needs no session restart. A session reconnect is needed only when the tool name
 * sets differ: the running shim keeps the old list. Used by the relay message builder.
 */
export function toolsNeedReconnect(
  oldTools: Iterable<string>,
  newTools: Iterable<string>,
): boolean {
  const a = new Set(oldTools);
  const b = new Set(newTools);
  return [...a].some((t) => !b.has(t)) || [...b].some((t) => !a.has(t));
}
