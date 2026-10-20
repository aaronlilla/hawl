import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileDurable } from "../daemon/fsutil.ts";
import { winCommandLine } from "../shell.ts";
import {
  claudeHookOps,
  claudeMcpEntry,
  planWakeUpgrade,
} from "./claude-code.ts";
import { codexBlocks } from "./codex.ts";
import { onPath } from "./index.ts";
import {
  applyPlan,
  type FilePlan,
  type JsonOp,
  planJson,
  planToml,
  type RestoreRecord,
  readIfExists,
  removeEntries,
  sha256,
  type WrittenEntry,
} from "./merge.ts";

/**
 * Machine-level install (user scope): Claude Code hooks and MCP server, Codex hooks and MCP
 * server. Both tools read these from the user's home no matter which folder a session starts in,
 * so a session in a subfolder of a joined folder is still covered. The hook and the MCP server
 * find their folder themselves and stay silent in folders that have not joined.
 *
 * What we wrote is recorded in `<stateDir>/user-scope.json` (path, key, sha256), like
 * `town.written` per folder, so removal takes out only our entries.
 */

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface UserScopeDeps {
  home: string;
  stateDir: string;
  /** Environment for CLAUDE_CONFIG_DIR / CODEX_HOME. Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Is this program on PATH? Default: PATH lookup. */
  has?: (name: string) => boolean;
  /** Run the `claude` CLI. Default: the real one. Tests inject a fake. */
  runClaude?: (args: string[]) => RunResult;
}

export type McpOutcome = "added" | "exists" | "no-cli" | "failed";

export interface UserScopeResult {
  /** Entries now in place (new or already there). */
  entries: number;
  skipped: { path: string; key: string; reason: string }[];
  /** Files we changed. */
  files: string[];
  mcp: McpOutcome;
  notes: string[];
}

interface UserScopeState {
  v: 1;
  written: WrittenEntry[];
  restore: RestoreRecord[];
  /** True when we ran `claude mcp add` and it succeeded. */
  claude_mcp: boolean;
}

export const CLAUDE_MCP_ADD_ARGS = [
  "mcp",
  "add",
  "--scope",
  "user",
  "hawl",
  "--",
  ...(() => {
    const e = claudeMcpEntry();
    return [e.command, ...e.args];
  })(),
];
export const CLAUDE_MCP_REMOVE_ARGS = [
  "mcp",
  "remove",
  "--scope",
  "user",
  "hawl",
];

/** The `claude mcp get` line that says whether any scope already defines `hawl`. */
const CLAUDE_MCP_GET_ARGS = ["mcp", "get", "hawl"];

export const statePath = (stateDir: string) =>
  join(stateDir, "user-scope.json");

export function readUserScope(stateDir: string): UserScopeState | null {
  const f = statePath(stateDir);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as Partial<UserScopeState>;
    return {
      v: 1,
      written: Array.isArray(j.written) ? j.written : [],
      restore: Array.isArray(j.restore) ? j.restore : [],
      claude_mcp: j.claude_mcp === true,
    };
  } catch {
    return null;
  }
}

function writeState(stateDir: string, st: UserScopeState): void {
  writeFileDurable(statePath(stateDir), `${JSON.stringify(st, null, 2)}\n`);
}

export function claudeDir(d: Pick<UserScopeDeps, "home" | "env">): string {
  const c = (d.env ?? process.env).CLAUDE_CONFIG_DIR;
  return c ? c : join(d.home, ".claude");
}

export function codexDir(d: Pick<UserScopeDeps, "home" | "env">): string {
  const c = (d.env ?? process.env).CODEX_HOME;
  return c ? c : join(d.home, ".codex");
}

function realClaude(cwd: string): (args: string[]) => RunResult {
  return (args) => {
    const win = process.platform === "win32";
    // `claude` is a .cmd shim on Windows, so it runs from one command string (no DEP0190).
    const r = win
      ? spawnSync(winCommandLine("claude", args), [], {
          cwd,
          encoding: "utf8",
          timeout: 30_000,
          shell: true,
        })
      : spawnSync("claude", args, { cwd, encoding: "utf8", timeout: 30_000 });
    return {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? (r.error ? r.error.message : ""),
    };
  };
}

/** Backups for these files live under the state dir whatever their location. */
const BACKUP_KEY = "~/user-scope";

/** Write a plan; keep the earliest restore point when nobody edited the file since our last write. */
function applyKeepingRestore(
  p: FilePlan,
  dirs: { projectDir: string; stateDir: string },
  restore: RestoreRecord[],
): void {
  if (!p.changed) return;
  const prev = restore.find((r) => r.path === p.abs);
  const rec = applyPlan({ ...p, path: BACKUP_KEY }, dirs);
  if (!rec) return;
  const next: RestoreRecord = { ...rec, path: p.abs };
  const i = restore.findIndex((r) => r.path === p.abs);
  const untouched =
    prev && p.before !== null && sha256(p.before) === prev.after;
  if (prev && untouched) {
    // The file is still what we left it: its true original is the one we saved first.
    restore[i] = { ...prev, after: next.after };
  } else if (i >= 0) restore[i] = next;
  else restore.push(next);
}

/**
 * Install hooks and MCP servers for Claude Code and Codex in the user's home. Idempotent, merges
 * into existing files, never overwrites a differing value. Never throws for a host problem: the
 * result says what happened.
 */
export function installUserScope(d: UserScopeDeps): UserScopeResult {
  const has = d.has ?? ((n) => onPath(n));
  const cDir = claudeDir(d);
  const xDir = codexDir(d);
  const dirs = { projectDir: d.home, stateDir: d.stateDir };
  const prior = readUserScope(d.stateDir);
  const restore: RestoreRecord[] = [...(prior?.restore ?? [])];
  const entries: WrittenEntry[] = [];
  const res: UserScopeResult = {
    entries: 0,
    skipped: [],
    files: [],
    mcp: "no-cli",
    notes: [],
  };
  const plans: FilePlan[] = [];

  const hasClaude = has("claude");
  const hasCodex = has("codex");
  const claudeFile = join(cDir, "settings.json");
  const codexFile = join(xDir, "config.toml");

  if (hasClaude || existsSync(cDir)) {
    const ops: JsonOp[] = claudeHookOps("user");
    plans.push(planJson(claudeFile, claudeFile, ops, readIfExists(claudeFile)));
  }
  if (hasCodex || existsSync(xDir)) {
    plans.push(
      planToml(
        codexFile,
        codexFile,
        codexBlocks(undefined, "user"),
        readIfExists(codexFile),
      ),
    );
  }
  if (plans.length === 0)
    res.notes.push(
      "Neither Claude Code nor Codex found on this machine; no user-level files written.",
    );

  for (const p of plans) {
    try {
      applyKeepingRestore(p, dirs, restore);
    } catch (e) {
      res.skipped.push({
        path: p.path,
        key: "(file)",
        reason: `could not write: ${(e as Error).message}`,
      });
      continue;
    }
    if (p.changed) res.files.push(p.path);
    entries.push(...p.entries);
    for (const s of p.skipped) res.skipped.push({ path: p.path, ...s });
  }
  res.entries = entries.length;

  // Claude Code keeps user-scope MCP servers in its own config, so go through its CLI.
  let claudeMcp = prior?.claude_mcp === true;
  if (!hasClaude) {
    res.mcp = "no-cli";
    res.notes.push(
      "`claude` is not on PATH: Claude Code MCP server not added at user scope.",
    );
  } else {
    const run = d.runClaude ?? realClaude(d.home);
    try {
      const got = run(CLAUDE_MCP_GET_ARGS);
      if (got.status === 0) {
        res.mcp = "exists";
        res.notes.push("A `hawl` MCP server already exists; left as is.");
      } else {
        const add = run(CLAUDE_MCP_ADD_ARGS);
        if (add.status === 0) {
          res.mcp = "added";
          claudeMcp = true;
        } else {
          res.mcp = "failed";
          res.notes.push(
            `\`claude mcp add\` failed${add.stderr ? `: ${add.stderr.trim().split("\n")[0]}` : ""}`,
          );
        }
      }
    } catch (e) {
      res.mcp = "failed";
      res.notes.push(`\`claude mcp\` could not run: ${(e as Error).message}`);
    }
  }

  // Entries from a file we no longer cover (e.g. CLAUDE_CONFIG_DIR changed) stay recorded so
  // removal still finds them.
  const touched = new Set(plans.map((p) => p.path));
  const keep = (prior?.written ?? []).filter((e) => !touched.has(e.path));
  writeState(d.stateDir, {
    v: 1,
    written: [...keep, ...entries],
    restore,
    claude_mcp: claudeMcp,
  });
  return res;
}

export interface UserScopeRemoval {
  removed: number;
  kept: string[];
  mcp: "removed" | "none" | "failed";
}

/** Take back only what the state file says we wrote. Foreign entries and edited entries stay. */
export function removeUserScope(d: UserScopeDeps): UserScopeRemoval {
  const out: UserScopeRemoval = { removed: 0, kept: [], mcp: "none" };
  const st = readUserScope(d.stateDir);
  if (!st) return out;
  const dirs = { projectDir: d.home, stateDir: d.stateDir };
  const byPath = new Map<string, WrittenEntry[]>();
  for (const e of st.written)
    byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
  for (const [path, entries] of byPath) {
    try {
      const r = removeEntries(
        path,
        BACKUP_KEY,
        entries,
        st.restore.find((x) => x.path === path),
        dirs,
      );
      out.removed += r.removed.length;
      out.kept.push(...r.kept.map((k) => `${path} ${k}`));
    } catch (e) {
      out.kept.push(...entries.map((x) => `${path} ${x.key}`));
      void e;
    }
  }
  if (st.claude_mcp) {
    try {
      const run = (d.runClaude ?? realClaude(d.home))(CLAUDE_MCP_REMOVE_ARGS);
      out.mcp = run.status === 0 ? "removed" : "failed";
    } catch {
      out.mcp = "failed";
    }
  }
  if (out.mcp === "failed") {
    // Keep a record so the next leave retries the removal.
    writeState(d.stateDir, {
      v: 1,
      written: [],
      restore: [],
      claude_mcp: true,
    });
  } else rmSync(statePath(d.stateDir), { force: true });
  return out;
}

/** The machine-wide half of the waiter upgrade (see `planWakeUpgrade`). */
export function upgradeUserScopeWake(stateDir: string): boolean {
  const st = readUserScope(stateDir);
  const file = st?.written.find((w) => w.key === "hooks.Stop[]")?.path;
  if (!st || !file) return false;
  const plan = planWakeUpgrade(file, file, "user");
  if (!plan) return false;
  applyKeepingRestore(
    plan,
    { projectDir: dirname(file), stateDir },
    st.restore,
  );
  for (const e of plan.entries)
    if (
      !st.written.some(
        (w) => w.path === e.path && w.key === e.key && w.sha256 === e.sha256,
      )
    )
      st.written.push(e);
  writeState(stateDir, st);
  return true;
}
