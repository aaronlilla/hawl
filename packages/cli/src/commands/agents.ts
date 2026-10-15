import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultStateDir } from "../daemon/main.ts";
import { readToken, request, socketPath } from "../daemon/socket.ts";
import { detectHosts, HOSTS } from "../hosts/index.ts";
import type { HostId } from "../hosts/types.ts";
import { localHubRunning } from "../local/server.ts";
import { readProjectId } from "../project-id.ts";
import { readTownFile, type TownFile, townPath } from "../town-file.ts";
import {
  codexTrusted,
  doctorChecks,
  entryPresent,
  HOST_FILES,
} from "./doctor.ts";
import { localMemberships } from "./join-local.ts";

export type AgentState =
  | "hooked"
  | "configured_not_seen"
  | "partial"
  | "broken"
  | "not_hooked";

export interface SessionRow {
  host: string;
  session_id?: string;
  resident_id?: string;
  root?: string;
  via: "hook" | "mcp";
  first_seen: string;
  last_seen: string;
}

export interface AgentRow {
  host: string;
  label: string;
  state: AgentState;
  detail: string;
}

export interface AgentsReport {
  joined: boolean;
  root?: string;
  route: { site: string; relay: string; workers: string[] }[];
  daemon: { running: boolean; detail?: string };
  hosts: AgentRow[];
  ok: boolean;
}

export interface AgentsDeps {
  home?: string;
  stateDir?: string;
  codexHome?: string;
  now?: () => Date;
  /** Ask the daemon. Default: the local socket with the token in the state dir. */
  request?: (req: { op: string; token?: string }) => Promise<unknown>;
  detect?: (o: { projectDir: string; home: string }) => HostId[];
  print?: (line: string) => void;
}

const SEEN_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** Files each host writes besides its MCP file. */
const EXTRA_FILES: Record<string, string[]> = {
  claude_code: [".claude/settings.local.json"],
};
const HOOK_HOSTS = new Set(["claude_code", "codex"]);

/** Nearest folder at or above `from` that holds `.hawl/hawl.json`. */
export function findJoinedRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(townPath(dir)) || localMemberships(dir).length > 0)
      return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const norm = (p: string) =>
  p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();

function hostFiles(h: string): string[] {
  const main = HOST_FILES[h];
  return [...(main ? [main] : []), ...(EXTRA_FILES[h] ?? [])];
}

async function loadSessions(
  deps: AgentsDeps,
  stateDir: string,
): Promise<{ sessions: SessionRow[] } | { error: string }> {
  const token = readToken(stateDir) ?? undefined;
  const ask =
    deps.request ??
    (async (req) => {
      const r = await request(socketPath(stateDir), req as never);
      if (!r.ok) throw new Error(r.error);
      return r.result;
    });
  try {
    if (!deps.request && !token) throw new Error("no daemon token");
    const res = (await ask({ op: "sessions", token })) as {
      sessions?: SessionRow[];
    };
    if (!res || !Array.isArray(res.sessions)) throw new Error("bad reply");
    return { sessions: res.sessions };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function classify(
  h: string,
  town: TownFile,
  ctx: { projectDir: string; home: string },
  codexHome: string,
  live: SessionRow[] | null,
  now: number,
): AgentRow | null {
  const label = HOSTS[h as HostId]?.label ?? h;
  const files = hostFiles(h);
  const mine = town.written.filter((e) => files.includes(e.path));
  if (mine.length === 0) return null;
  const missing = mine.filter((e) => !entryPresent(town, e, ctx));
  if (missing.length)
    return {
      host: h,
      label,
      state: "broken",
      detail: `missing ${missing.map((m) => m.key).join(", ")}: run \`hawl join\` again`,
    };
  const hookHost = HOOK_HOSTS.has(h);
  if (live === null)
    return {
      host: h,
      label,
      state: "configured_not_seen",
      detail: "config ok, live check skipped (daemon not running)",
    };
  const root = norm(ctx.projectDir);
  const seen = live.filter(
    (s) =>
      s.host === h &&
      s.root !== undefined &&
      norm(s.root) === root &&
      now - new Date(s.last_seen).getTime() <= SEEN_WINDOW_MS,
  );
  const viaHook = seen.some((s) => s.via === "hook");
  const viaMcp = seen.some((s) => s.via === "mcp");
  const lacks = [
    ...(hookHost && !viaHook ? ["hook events"] : []),
    ...(!viaMcp ? ["MCP connection"] : []),
  ];
  if (seen.length === 0) {
    const trust =
      h === "codex" && !codexTrusted(ctx.projectDir, codexHome)
        ? "; trust this folder in Codex first"
        : "";
    return {
      host: h,
      label,
      state: "configured_not_seen",
      detail: `config ok. Start ${label} in this folder to verify${trust}`,
    };
  }
  if (lacks.length)
    return {
      host: h,
      label,
      state: "partial",
      detail: `seen, but no ${lacks.join(" or ")} in the last 7 days. Restart ${label} here and check \`hawl doctor\``,
    };
  return {
    host: h,
    label,
    state: "hooked",
    detail: `${seen.length} session${seen.length === 1 ? "" : "s"} seen live${hookHost ? " via hook and MCP" : " via MCP"}`,
  };
}

export async function agentsReport(
  o: { cwd: string },
  deps: AgentsDeps = {},
): Promise<AgentsReport> {
  const home = deps.home ?? homedir();
  const stateDir = deps.stateDir ?? defaultStateDir();
  const codexHome =
    deps.codexHome ?? process.env.CODEX_HOME ?? join(home, ".codex");
  const now = (deps.now ?? (() => new Date()))().getTime();
  const root = findJoinedRoot(o.cwd);
  const town = root ? readTownFile(root) : null;
  if (root && (!town || town.memberships.length === 0)) {
    const local = localMemberships(root);
    if (local.length > 0) {
      const checks = await doctorChecks({ projectDir: root });
      const hosts: AgentRow[] = local.map((m, i) => ({
        host: m.host,
        label: HOSTS[m.host as HostId]?.label ?? m.host,
        state: checks[i]?.state === "ok" ? "configured_not_seen" : "broken",
        detail: checks[i]?.detail ?? "local config unavailable",
      }));
      const running = (
        await Promise.all(
          local.map((m) => {
            const dir = readProjectId(m.host, root)?.hawl_home;
            return dir ? localHubRunning(dir) : false;
          }),
        )
      ).some(Boolean);
      return {
        joined: true,
        root,
        route: [
          {
            site: "local",
            relay: "this machine",
            workers: local.map((m) => `${m.host}:${m.resident_id}`),
          },
        ],
        daemon: { running },
        hosts,
        ok: !hosts.some((h) => h.state === "broken"),
      };
    }
  }
  if (!root || !town || town.memberships.length === 0)
    return {
      joined: false,
      route: [],
      daemon: { running: false },
      hosts: [],
      ok: false,
    };
  const ctx = { projectDir: root, home };
  const route = town.memberships.map((m) => {
    let relay = m.relay_url;
    try {
      relay = new URL(m.relay_url).host;
    } catch {
      // keep the raw value
    }
    return {
      site: m.town_slug,
      relay,
      workers: m.workers.map((w) => `${w.platform}:${w.resident_id}`),
    };
  });
  const got = await loadSessions(deps, stateDir);
  const live = "sessions" in got ? got.sessions : null;
  const hosts: AgentRow[] = [];
  for (const h of Object.keys(HOST_FILES)) {
    const row = classify(h, town, ctx, codexHome, live, now);
    if (row) hosts.push(row);
  }
  const configured = new Set(hosts.map((r) => r.host));
  for (const h of (deps.detect ?? detectHosts)(ctx))
    if (!configured.has(h) && HOST_FILES[h])
      hosts.push({
        host: h,
        label: HOSTS[h].label,
        state: "not_hooked",
        detail: `not hooked: run \`hawl join --host ${h}\``,
      });
  return {
    joined: true,
    root,
    route,
    daemon:
      "error" in got
        ? { running: false, detail: got.error }
        : { running: true },
    hosts,
    ok: !hosts.some((r) => r.state === "broken" || r.state === "partial"),
  };
}

const MARK: Record<AgentState, string> = {
  hooked: "ok  ",
  configured_not_seen: "wait",
  partial: "FAIL",
  broken: "FAIL",
  not_hooked: "warn",
};

export function renderAgents(r: AgentsReport): string {
  if (!r.joined)
    return "This folder has not joined a site; run `hawl join <site>`";
  const lines = [`Folder: ${r.root}`];
  for (const x of r.route)
    lines.push(`Site ${x.site} via ${x.relay}: ${x.workers.join(", ")}`);
  if (!r.daemon.running)
    lines.push("daemon not running: start any agent here or run `hawl daemon`");
  if (r.hosts.length === 0)
    lines.push("No agent tools found here; run `hawl join --host <tool>`");
  for (const h of r.hosts)
    lines.push(
      `${MARK[h.state]} ${h.label}: ${h.state.replace(/_/g, " ")}. ${h.detail}`,
    );
  return lines.join("\n");
}

/** `hawl agents [--json]`. Exit 1 when not joined, or any agent is broken or partial. */
export async function agents(
  o: { cwd: string; json?: boolean },
  deps: AgentsDeps = {},
): Promise<{ report: AgentsReport; exitCode: number }> {
  const report = await agentsReport(o, deps);
  const print = deps.print ?? ((l) => process.stdout.write(`${l}\n`));
  print(o.json ? JSON.stringify(report, null, 2) : renderAgents(report));
  return { report, exitCode: report.joined && report.ok ? 0 : 1 };
}
