import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export const BIN_LINE = "Installs `hawl` to ~/.hawl/bin";
const MARK = "# added by hawl";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface SelfInstallDeps {
  home?: string;
  platform?: NodeJS.Platform;
  /** The running executable: node, or the single-file hawl binary. */
  execPath?: string;
  /** The running entry script (dist/main.js under npx). Ignored for a single-file binary. */
  scriptPath?: string;
  /** True when execPath is the hawl binary itself (node SEA). */
  isSea?: boolean;
  env?: NodeJS.ProcessEnv;
  run?: (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => RunResult;
  /** Skip the user-PATH write (Windows registry). */
  persistPath?: boolean;
}

export interface SelfInstallResult {
  binDir: string;
  binPath: string;
  /** Files (or "user PATH") changed to put binDir on PATH. */
  pathUpdated: string[];
  /** True when the current process PATH was changed. */
  processPathUpdated: boolean;
  /** Set when the install or PATH step failed; join keeps going. */
  warning?: string;
}

export function detectSea(): boolean {
  try {
    const sea = process.getBuiltinModule("node:sea") as
      | { isSea?: () => boolean }
      | undefined;
    return Boolean(sea?.isSea?.());
  } catch {
    return false;
  }
}

/** Where the self-installed `hawl` launcher lives: `~/.hawl/bin/hawl` (`hawl.cmd` / `hawl.exe` on Windows). */
export function launcherPath(
  home: string,
  platform: NodeJS.Platform | string,
  isSea: boolean,
): string {
  const win = platform === "win32";
  return join(
    home,
    ".hawl",
    "bin",
    win ? (isSea ? "hawl.exe" : "hawl.cmd") : "hawl",
  );
}

function defaultRun(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): RunResult {
  const { spawnSync } = process.getBuiltinModule("node:child_process");
  const r = spawnSync(cmd, args, { encoding: "utf8", env });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function onPath(pathValue: string | undefined, dir: string, win: boolean) {
  const norm = (p: string) => {
    const t = p.replace(/[\\/]+$/, "");
    return win ? t.toLowerCase() : t;
  };
  return (pathValue ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((p) => norm(p) === norm(dir));
}

/** Shell profiles that get the PATH line: `create` always, `maybe` only if it exists. */
export function profileFiles(home: string, platform: NodeJS.Platform) {
  if (platform === "darwin")
    return {
      create: join(home, ".zprofile"),
      maybe: [join(home, ".bash_profile")],
    };
  return {
    create: join(home, ".profile"),
    maybe: [join(home, ".bashrc"), join(home, ".zshrc")],
  };
}

function appendOnce(file: string, line: string): boolean {
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (cur.includes(MARK)) return false;
  const sep = cur === "" || cur.endsWith("\n") ? "" : "\n";
  writeFileSync(file, `${cur}${sep}${line} ${MARK}\n`);
  return true;
}

// First in the user PATH, moved there if it sits later: an older global `hawl` (npm -g) must not
// answer the hooks in place of the one just joined with.
export const PS_ADD_PATH =
  "$d=$env:HAWL_BIN;$p=[Environment]::GetEnvironmentVariable('Path','User');" +
  "if(-not $p){$p=''};" +
  "$n=(@($d)+@(($p -split ';') | Where-Object {$_ -and $_ -ne $d})) -join ';';" +
  "if($n -ne $p.TrimEnd(';')){" +
  "[Environment]::SetEnvironmentVariable('Path',$n,'User');Write-Output changed}";

/**
 * Put the running hawl at `~/.hawl/bin/hawl` and that folder on PATH, so a bare `hawl`
 * works after `npx hawl.ai join` (spec 16 §3.4). Idempotent; re-running refreshes the copy.
 */
export function selfInstall(deps: SelfInstallDeps = {}): SelfInstallResult {
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const win = platform === "win32";
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const isSea = deps.isSea ?? detectSea();
  const scriptPath = deps.scriptPath ?? process.argv[1];
  const binDir = join(home, ".hawl", "bin");
  const binPath = launcherPath(home, platform, isSea);
  const out: SelfInstallResult = {
    binDir,
    binPath,
    pathUpdated: [],
    processPathUpdated: false,
  };
  try {
    mkdirSync(binDir, { recursive: true });
    if (isSea) {
      if (resolve(execPath) !== resolve(binPath))
        copyFileSync(execPath, binPath);
    } else {
      if (!scriptPath)
        throw new Error("cannot tell which hawl script is running");
      const script = resolve(scriptPath);
      writeFileSync(
        binPath,
        win
          ? `@echo off\r\n"${execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec "${execPath}" "${script}" "$@"\n`,
      );
      // Claude Code runs hooks in Git Bash on Windows, and bash never runs `hawl.cmd` for a bare
      // `hawl` (code.claude.com/docs/en/hooks: "Git Bash on Windows"). Its own launcher, beside it.
      if (win) {
        const fwd = (p: string) => p.split("\\").join("/");
        writeFileSync(
          join(binDir, "hawl"),
          `#!/bin/sh\nexec "${fwd(execPath)}" "${fwd(script)}" "$@"\n`,
        );
      }
    }
    if (!win) chmodSync(binPath, 0o755);
  } catch (e) {
    out.warning = `could not install hawl to ${binDir}: ${(e as Error).message}`;
    return out;
  }

  const key =
    win && env.PATH === undefined && env.Path !== undefined ? "Path" : "PATH";
  if (!onPath(env[key], binDir, win)) {
    env[key] = `${binDir}${delimiter}${env[key] ?? ""}`;
    out.processPathUpdated = true;
  }

  try {
    if (win) {
      // HAWL_NO_PERSIST_PATH=1: tests and proofs fake HOME but the registry PATH is real.
      if (deps.persistPath !== false && env.HAWL_NO_PERSIST_PATH !== "1") {
        const run = deps.run ?? defaultRun;
        const r = run(
          "powershell",
          ["-NoProfile", "-NonInteractive", "-Command", PS_ADD_PATH],
          { ...process.env, HAWL_BIN: binDir },
        );
        if (r.status !== 0)
          throw new Error(r.stderr.trim() || "powershell failed");
        if (/changed/.test(r.stdout)) out.pathUpdated.push("user PATH");
      }
    } else {
      const line = 'export PATH="$HOME/.hawl/bin:$PATH"';
      const { create, maybe } = profileFiles(home, platform);
      for (const f of [create, ...maybe.filter(existsSync)])
        if (appendOnce(f, line)) out.pathUpdated.push(f);
    }
  } catch (e) {
    out.warning = `hawl is installed at ${binPath} but PATH was not saved: ${(e as Error).message}`;
  }
  return out;
}
