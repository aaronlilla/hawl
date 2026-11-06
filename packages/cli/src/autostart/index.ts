import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { detectSea, launcherPath } from "../install/self-install.ts";
import type { Runner } from "./types.ts";

const realRun: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status ?? 1, stderr: r.stderr ?? "" };
};

/**
 * The binary the daemon task runs. A Node SEA is itself `hawl`; otherwise (`npx hawl.ai join`,
 * where execPath is node) use the self-installed launcher, never bare node (spec 16 §3.6).
 */
export function resolveAutostartBin(
  o: {
    home?: string;
    platform?: string;
    isSea?: boolean;
    execPath?: string;
    exists?: (p: string) => boolean;
  } = {},
): string {
  const isSea = o.isSea ?? detectSea();
  const execPath = o.execPath ?? process.execPath;
  if (isSea) return execPath;
  const launcher = launcherPath(
    o.home ?? homedir(),
    o.platform ?? process.platform,
    false,
  );
  if (!(o.exists ?? existsSync)(launcher))
    throw new Error(
      `hawl launcher not found at ${launcher}; run \`npx hawl.ai join\` first`,
    );
  return launcher;
}

/** `hawl autostart on|off` and the autostart-on step of `hawl join`, for the current OS. */
export async function setAutostart(
  on: boolean,
  o: {
    run?: Runner;
    bin?: string;
    home?: string;
    platform?: string;
    command?: "daemon" | "local";
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<void> {
  // The login entry is one per OS user (Windows task `hawl-daemon`, one launchd label, one systemd
  // unit), whatever HOME says. Test machines set this so they never repoint the real one.
  if ((o.env ?? process.env).HAWL_NO_AUTOSTART === "1")
    throw new Error("HAWL_NO_AUTOSTART=1 is set");
  const run = o.run ?? realRun;
  const home = o.home ?? homedir();
  const platform = o.platform ?? process.platform;
  const bin = on
    ? (o.bin ?? resolveAutostartBin({ home, platform }))
    : (o.bin ?? "");
  if (platform === "win32") {
    const m = await import("./windows.ts");
    if (on)
      m.installAutostart(run, bin, home, process.env, o.command, o.stateDir);
    else m.uninstallAutostart(run, home);
  } else if (platform === "darwin") {
    const m = await import("./macos.ts");
    const uid = process.getuid?.() ?? 0;
    if (on) m.installAutostart(run, bin, home, uid, o.command, o.stateDir);
    else m.uninstallAutostart(run, home, uid);
  } else {
    const m = await import("./linux.ts");
    if (on)
      m.installAutostart(
        run,
        bin,
        home,
        process.env.XDG_CONFIG_HOME,
        o.command,
        o.stateDir,
      );
    else m.uninstallAutostart(run, home, process.env.XDG_CONFIG_HOME);
  }
}
