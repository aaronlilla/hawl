import { execSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Claude Code, Codex and git: what is missing or old on this machine, and the vendor's own
 * installer for each. Sources (read 2026-10-23):
 * - Claude Code https://code.claude.com/docs/en/setup (install.sh / install.ps1, `claude update`);
 *   newest version = plain text at https://downloads.claude.ai/claude-code-releases/latest.
 * - Codex https://github.com/openai/codex (chatgpt.com/codex/install.sh and install.ps1;
 *   CODEX_NON_INTERACTIVE=1 skips their prompts, read in the scripts);
 *   newest version = "tag_name": "rust-v<x.y.z>" in https://releases.openai.com/codex/channels/latest.
 * - git https://git-scm.com/install/windows (`winget install --id Git.Git -e --source winget`) and
 *   https://git-scm.com/download/linux (distro package manager). No cheap newest-version source,
 *   so git is only checked for presence.
 */
export type ToolId = "git" | "claude" | "codex";

export interface ToolState {
  /** Version found on this machine, null when the tool is not there. */
  installed: string | null;
  /** Newest version the vendor publishes; undefined when unknown (offline) or not checked. */
  latest?: string | null;
}

export interface ToolItem {
  id: ToolId;
  label: string;
  status: "missing" | "outdated";
  installed: string | null;
  latest: string | null;
  /** argv to run, or null when this machine has no automatic way (see `note`). */
  command: string[] | null;
  note?: string;
}

export interface PlanInput {
  os: NodeJS.Platform;
  states: Record<string, ToolState>;
  /** Running as root (Linux). */
  root?: boolean;
  sudo?: boolean;
  /** First package manager found: apt-get, dnf, yum, apk, pacman or zypper. */
  pm?: string;
  winget?: boolean;
}

const LABEL: Record<ToolId, string> = {
  git: "git",
  claude: "Claude Code",
  codex: "Codex",
};

/** Download page for each OS, shown when we cannot install git ourselves. */
const GIT_PAGE = {
  win32: "https://git-scm.com/download/win",
  linux: "https://git-scm.com/download/linux",
  darwin: "https://git-scm.com/download/mac",
} as const;

const PM_LINE: Record<string, string> = {
  "apt-get": "apt-get update && apt-get install -y git",
  dnf: "dnf install -y git",
  yum: "yum install -y git",
  apk: "apk add git",
  pacman: "pacman -S --noconfirm git",
  zypper: "zypper --non-interactive install git",
};

const PS = [
  "powershell",
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
];

export function parseToolVersion(text: string): string | null {
  return /\d+\.\d+\.\d+/.exec(text)?.[0] ?? null;
}

/** True when `latest` is a higher x.y.z than `installed`. */
export function isOutdated(installed: string, latest: string): boolean {
  const a = installed.split(".").map(Number);
  const b = latest.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((b[i] ?? 0) !== (a[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0);
  }
  return false;
}

function install(
  id: ToolId,
  p: PlanInput,
): { command: string[] | null; note?: string } {
  const win = p.os === "win32";
  if (id === "claude")
    return {
      command: win
        ? [...PS, "irm https://claude.ai/install.ps1 | iex"]
        : ["sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"],
    };
  if (id === "codex")
    return {
      command: win
        ? [
            ...PS,
            "$env:CODEX_NON_INTERACTIVE='1'; irm https://chatgpt.com/codex/install.ps1 | iex",
          ]
        : [
            "sh",
            "-c",
            "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
          ],
    };
  const page = GIT_PAGE[p.os as keyof typeof GIT_PAGE];
  if (win) {
    if (p.winget)
      return {
        command: [
          "winget",
          "install",
          "--id",
          "Git.Git",
          "-e",
          "--source",
          "winget",
          "--silent",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ],
      };
    return { command: null, note: `install it from ${page}` };
  }
  if (p.os === "linux") {
    const line = p.pm ? PM_LINE[p.pm] : undefined;
    if (!line) return { command: null, note: `install it from ${page}` };
    if (p.root) return { command: ["sh", "-c", line] };
    if (p.sudo) return { command: ["sh", "-c", `sudo ${line}`] };
    return { command: null, note: `needs root: install it from ${page}` };
  }
  return { command: null, note: "run: xcode-select --install" };
}

/** What to install or update, in the order to do it (git first, Claude Code uses it on Windows). */
export function planTools(p: PlanInput): ToolItem[] {
  const out: ToolItem[] = [];
  for (const id of ["git", "claude", "codex"] as ToolId[]) {
    const s = p.states[id];
    if (!s) continue;
    const latest = s.latest ?? null;
    const base = { id, label: LABEL[id], installed: s.installed, latest };
    if (s.installed === null) {
      out.push({ ...base, status: "missing", ...install(id, p) });
    } else if (id !== "git" && latest && isOutdated(s.installed, latest)) {
      // shortcut: git is only checked for presence; no cheap latest-version source.
      out.push({
        ...base,
        status: "outdated",
        ...(id === "claude"
          ? { command: ["claude", "update"] }
          : install(id, p)),
      });
    }
  }
  return out;
}

/** `all`, `none`, or names and/or 1-based numbers from the list shown, e.g. `claude,codex` or `1,3`. */
export function pickTools(plan: ToolItem[], spec: string): ToolItem[] {
  const s = spec.trim().toLowerCase();
  if (s === "all") return plan;
  if (s === "none" || s === "") return [];
  const out: ToolItem[] = [];
  for (const t of s.split(/[\s,]+/).filter(Boolean)) {
    if (!/^\d+$/.test(t) && !["git", "claude", "codex"].includes(t))
      throw new Error(
        `unknown tool: ${t} (use claude, codex, git, all or none)`,
      );
    const hit = /^\d+$/.test(t)
      ? plan[Number(t) - 1]
      : plan.find((i) => i.id === t);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Where the vendors' installers put things, which are not on PATH until a new terminal. */
export function toolBinDirs(
  os: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dirs = [join(home, ".local", "bin")];
  if (os === "win32") {
    if (env.LOCALAPPDATA)
      dirs.push(join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin"));
    dirs.push(join(env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd"));
  }
  return dirs;
}

function findExe(name: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of ["", ".exe", ".cmd"]) {
      const f = join(dir, name + ext);
      if (existsSync(f)) return f;
    }
  }
  return null;
}

const pathDirs = (env: NodeJS.ProcessEnv) =>
  (env.PATH ?? env.Path ?? "").split(delimiter);

/** Put the installers' folders on this process's PATH so the rest of the join sees the new tools. */
export function addToolDirsToPath(
  os: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const have = pathDirs(env);
  const add = toolBinDirs(os, home, env).filter(
    (d) => existsSync(d) && !have.includes(d),
  );
  if (add.length) env.PATH = [...have, ...add].join(delimiter);
}

/** Look at this machine: versions found, and the vendors' newest versions for the ones found. */
export async function detectTools(o: {
  os?: NodeJS.Platform;
  home: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}): Promise<{ plan: PlanInput }> {
  const os = o.os ?? process.platform;
  const env = o.env ?? process.env;
  const dirs = [...pathDirs(env), ...toolBinDirs(os, o.home, env)];
  const doFetch = o.fetch ?? fetch;
  const text = async (url: string): Promise<string | null> => {
    try {
      const r = await doFetch(url, { signal: AbortSignal.timeout(5000) });
      return r.ok ? await r.text() : null;
    } catch {
      return null; // offline: "outdated" is simply not reported
    }
  };
  const states: Record<string, ToolState> = {};
  for (const id of ["git", "claude", "codex"] as ToolId[]) {
    const exe = findExe(id, dirs);
    let installed: string | null = null;
    if (exe) {
      try {
        installed = parseToolVersion(
          execSync(`"${exe}" --version`, {
            encoding: "utf8",
            timeout: 15000,
            stdio: "pipe",
          }),
        );
      } catch {
        installed = null; // present but broken: offered as missing
      }
    }
    states[id] = { installed };
  }
  // Latest: Claude Code publishes a plain version file; Codex a release record with tag_name.
  if (states.claude?.installed) {
    const t = await text(
      "https://downloads.claude.ai/claude-code-releases/latest",
    );
    states.claude.latest = t ? parseToolVersion(t) : null;
  }
  if (states.codex?.installed) {
    const t = await text("https://releases.openai.com/codex/channels/latest");
    states.codex.latest = t
      ? (/"tag_name":\s*"rust-v([\d.]+)"/.exec(t)?.[1] ?? null)
      : null;
  }
  return {
    plan: {
      os,
      states,
      root: process.getuid?.() === 0,
      sudo: findExe("sudo", dirs) !== null,
      pm: ["apt-get", "dnf", "yum", "apk", "pacman", "zypper"].find((m) =>
        findExe(m, dirs),
      ),
      winget: findExe("winget", dirs) !== null,
    },
  };
}

const PS_ADD_TOOL_BIN =
  "$d=$env:HAWL_TOOL_BIN;$p=[Environment]::GetEnvironmentVariable('Path','User');" +
  "if(-not (($p -split ';') -contains $d)){[Environment]::SetEnvironmentVariable('Path',(($p.TrimEnd(';'),$d) -join ';'),'User');Write-Output changed}";

/**
 * Claude Code's installer puts claude in ~/.local/bin and, on Windows, only tells the person to add
 * that folder to PATH by hand. Do it for them so `claude` works in the next terminal.
 * Windows: the user PATH. Linux/macOS: ~/.profile. HAWL_NO_PERSIST_PATH=1 skips it (proofs).
 * Returns what was changed, or null.
 */
export function persistToolPath(
  os: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  run: typeof spawnSync = spawnSync,
): string | null {
  const dir = join(home, ".local", "bin");
  if (env.HAWL_NO_PERSIST_PATH === "1" || !existsSync(dir)) return null;
  if (os === "win32") {
    const r = run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", PS_ADD_TOOL_BIN],
      { env: { ...process.env, HAWL_TOOL_BIN: dir }, encoding: "utf8" },
    );
    return r.status === 0 && /changed/.test(String(r.stdout))
      ? "user PATH"
      : null;
  }
  const profile = join(home, ".profile");
  const cur = existsSync(profile) ? readFileSync(profile, "utf8") : "";
  if (cur.includes(".local/bin")) return null;
  const sep = cur === "" || cur.endsWith("\n") ? "" : "\n";
  appendFileSync(profile, `${sep}export PATH="$HOME/.local/bin:$PATH"\n`);
  return profile;
}

/** Run one item's installer with its output on screen. True when it exited 0. */
export function runTool(item: ToolItem): boolean {
  if (!item.command) return false;
  const [cmd, ...args] = item.command;
  return spawnSync(cmd as string, args, { stdio: "inherit" }).status === 0;
}
