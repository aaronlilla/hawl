import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { writeFileDurable } from "../daemon/fsutil.ts";
import { openKeyStore } from "../daemon/keys.ts";
import { defaultStateDir } from "../daemon/main.ts";
import { planJson, planToml, sha256 } from "../hosts/merge.ts";
import { absPath } from "../hosts/types.ts";
import { readTownFile, type TownFile } from "../town-file.ts";
import {
  DEFAULT_OTLP_PORT,
  daemonLinkFor,
  type JoinDeps,
  spawnDaemon,
} from "./join.ts";
import { localMemberships } from "./join-local.ts";

function localConfigPresent(config: string, host: string): boolean {
  if (!existsSync(config)) return false;
  try {
    const text = readFileSync(config, "utf8");
    const doc = (host === "codex" ? parseToml(text) : JSON.parse(text)) as {
      mcp_servers?: Record<string, unknown>;
      mcpServers?: Record<string, unknown>;
    };
    return !!(host === "codex" ? doc.mcp_servers?.hawl : doc.mcpServers?.hawl);
  } catch {
    return false;
  }
}

function repairLocalConfig(config: string, host: string): void {
  const before = existsSync(config) ? readFileSync(config, "utf8") : null;
  const args = ["-y", "hawl.ai", "mcp", "--host", host, "--local"];
  const plan =
    host === "codex"
      ? planToml(
          config,
          config,
          [
            {
              key: "mcp_servers.hawl",
              table: ["mcp_servers", "hawl"],
              text: `[mcp_servers.hawl]\ncommand = "npx"\nargs = ${JSON.stringify(args)}`,
            },
          ],
          before,
        )
      : planJson(
          config,
          config,
          [
            {
              kind: "set",
              key: ["mcpServers", "hawl"],
              value: { command: "npx", args },
            },
          ],
          before,
        );
  if (plan.changed) writeFileDurable(config, plan.after);
}

export type CheckState = "ok" | "fail" | "warn" | "manual";

export interface Check {
  name: string;
  state: CheckState;
  detail: string;
}

/** Entry keys that mean a host reports live activity (spec 16 §3.9). */
const ACTIVITY_KEYS: Record<string, string[]> = {
  claude_code: [
    "env.CLAUDE_CODE_ENABLE_TELEMETRY",
    "env.OTEL_EXPORTER_OTLP_ENDPOINT",
  ],
  codex: [],
  gemini: ["telemetry"],
};
const HOOK_KEYS: Record<string, string[]> = {
  claude_code: ["hooks.SubagentStart[]", "hooks.PreToolUse[]"],
  codex: ["hooks.SessionStart", "hooks.PreToolUse", "hooks.PostToolUse"],
};
export const HOST_FILES: Record<string, string> = {
  claude_code: ".mcp.json",
  codex: ".codex/config.toml",
  cursor: ".cursor/mcp.json",
  devin: ".devin/mcp_config.local.json",
};

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

/** Codex keeps trust in `$CODEX_HOME/config.toml` under `[projects.'<path>']` (SPK-6 #5). */
export function codexTrusted(projectDir: string, codexHome: string): boolean {
  const f = join(codexHome, "config.toml");
  if (!existsSync(f)) return false;
  try {
    const doc = parseToml(readFileSync(f, "utf8")) as {
      projects?: Record<string, { trust_level?: string }>;
    };
    const want = normPath(projectDir);
    return Object.entries(doc.projects ?? {}).some(
      ([k, v]) => normPath(k) === want && v.trust_level === "trusted",
    );
  } catch {
    return false;
  }
}

export function entryPresent(
  town: TownFile,
  e: TownFile["written"][number],
  ctx: { projectDir: string; home: string },
): boolean {
  const f = absPath(e.path, ctx);
  if (!existsSync(f)) return false;
  const text = readFileSync(f, "utf8");
  if (e.key === "(file)") return sha256(text) === e.sha256;
  if (f.endsWith(".toml"))
    return text.includes(e.key.split(".").slice(-1)[0] as string);
  // JSON: the exact value hash is checked on leave; here, presence of the leaf name is enough.
  const leaf = e.key.replace(/\[\]$/, "").split(".").slice(-1)[0] as string;
  return text.includes(`"${leaf}"`);
}

async function receiverLive(
  doFetch: typeof fetch,
  port: number,
): Promise<boolean> {
  try {
    const r = await doFetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** `hawl doctor`: host config, Codex trust, keychain, daemon, relay, clock skew, live activity. */
export async function doctorChecks(
  o: { projectDir?: string; codexHome?: string; fix?: boolean },
  deps: JoinDeps = {},
): Promise<Check[]> {
  const doFetch = deps.fetch ?? fetch;
  const stateDir = deps.stateDir ?? defaultStateDir();
  const home = deps.home ?? homedir();
  const projectDir = resolve(o.projectDir ?? process.cwd());
  const codexHome =
    o.codexHome ?? process.env.CODEX_HOME ?? join(home, ".codex");
  const otlpPort = deps.otlpPort ?? DEFAULT_OTLP_PORT;
  const checks: Check[] = [];
  const town = readTownFile(projectDir);
  if (!town || town.memberships.length === 0) {
    const local = localMemberships(projectDir);
    if (local.length > 0)
      return local.map<Check>((m) => {
        if (o.fix && !localConfigPresent(m.config, m.host)) {
          try {
            repairLocalConfig(m.config, m.host);
          } catch {
            // Keep unreadable config for the person to repair.
          }
        }
        const present = localConfigPresent(m.config, m.host);
        return {
          name: `local ${m.host}`,
          state: present ? "ok" : "fail",
          detail: present
            ? `joined in local mode as ${m.resident_id}`
            : `${m.config} is missing or has no readable hawl entry; run \`hawl join --local\` again`,
        };
      });
    return [
      {
        name: "membership",
        state: "fail",
        detail: "this folder has not joined a site; run `hawl join <site>`",
      },
    ];
  }
  const ctx = { projectDir, home };

  // Host config presence, per host file we wrote.
  const paths = [...new Set(town.written.map((e) => e.path))];
  const hostsHere = new Set<string>();
  for (const [h, f] of Object.entries(HOST_FILES))
    if (paths.includes(f)) hostsHere.add(h);
  for (const h of hostsHere) {
    const mine = town.written.filter((e) => e.path === HOST_FILES[h]);
    const missing = mine.filter((e) => !entryPresent(town, e, ctx));
    checks.push({
      name: `${h} config`,
      state: missing.length ? "fail" : "ok",
      detail: missing.length
        ? `missing ${missing.map((m) => m.key).join(", ")}; run \`hawl join\` again`
        : `${HOST_FILES[h]} has the hawl entry`,
    });
  }
  if (hostsHere.has("codex")) {
    checks.push(
      codexTrusted(projectDir, codexHome)
        ? { name: "codex trust", state: "ok", detail: "folder is trusted" }
        : {
            name: "codex trust",
            state: "manual",
            detail:
              "Codex loads project config only for trusted folders; trust this folder in Codex",
          },
    );
    checks.push({
      name: "codex hook trust",
      state: "manual",
      detail:
        "manual check only: approve the hawl hook in Codex /hooks (folder trust is not enough)",
    });
  }
  if (hostsHere.has("claude_code")) {
    checks.push({
      name: "claude_code approval",
      state: "manual",
      detail:
        "manual check only: Claude Code asks once to approve the project server; run `claude mcp list` to see it",
    });
  }

  // Keychain: a key for every worker.
  try {
    const ks =
      deps.keyStore ??
      (await openKeyStore({
        stateDir,
        passphrase: process.env.HAWL_PASSPHRASE,
      }));
    for (const m of town.memberships)
      for (const w of m.workers) {
        const k = await ks.get(w.resident_id);
        checks.push({
          name: `key ${w.resident_id}`,
          state: k ? "ok" : "fail",
          detail: k
            ? `in ${ks.kind}`
            : "no key in the store; leave and join again",
        });
      }
  } catch (e) {
    checks.push({
      name: "keychain",
      state: "fail",
      detail: (e as Error).message,
    });
  }

  // Daemon.
  let daemonUp = false;
  try {
    const s = (await (deps.daemon ?? daemonLinkFor)(stateDir).call(
      "status",
    )) as {
      pid: number;
      version: string;
      workers?: { resident_id: string; refused?: string }[];
    };
    daemonUp = true;
    checks.push({
      name: "daemon",
      state: "ok",
      detail: `pid ${s.pid} v${s.version}`,
    });
    // The relay turned one of this folder's agents away (removed or suspended): say so plainly.
    const mine = new Set(
      town.memberships.flatMap((m) => m.workers.map((w) => w.resident_id)),
    );
    for (const w of s.workers ?? [])
      if (w.refused && mine.has(w.resident_id))
        checks.push({ name: "agent access", state: "fail", detail: w.refused });
  } catch {
    // `hawl doctor --fix` starts the stopped helper; it reattaches the agents it remembers.
    let started: { pid: number; version: string } | null = null;
    if (o.fix) {
      try {
        await (deps.ensureDaemon ?? spawnDaemon)(stateDir);
        started = (await (deps.daemon ?? daemonLinkFor)(stateDir).call(
          "status",
        )) as { pid: number; version: string };
      } catch {
        started = null;
      }
    }
    daemonUp = started !== null;
    checks.push(
      started
        ? {
            name: "daemon",
            state: "ok",
            detail: `was not running; started it (pid ${started.pid} v${started.version})`,
          }
        : {
            name: "daemon",
            state: "fail",
            detail: o.fix
              ? "not running and it would not start; run `hawl daemon` in a terminal to see why"
              : "not running; run `hawl doctor --fix` to start it",
          },
    );
  }

  // Relay reachability and clock skew from the response Date header.
  for (const m of town.memberships) {
    try {
      const t0 = Date.now();
      const r = await doFetch(`${m.relay_url}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      checks.push({
        name: `relay ${m.town_slug}`,
        state: r.ok ? "ok" : "fail",
        detail: `${r.status} in ${Date.now() - t0} ms`,
      });
      const date = r.headers.get("date");
      if (date) {
        const skew = Math.abs(Date.now() - new Date(date).getTime()) / 1000;
        checks.push({
          name: "clock skew",
          state: skew > 30 ? "fail" : skew > 5 ? "warn" : "ok",
          detail: `${skew.toFixed(1)} s from the relay${skew > 30 ? "; sign-in assertions live 60 s, fix the system clock" : ""}`,
        });
      }
    } catch (e) {
      checks.push({
        name: `relay ${m.town_slug}`,
        state: "fail",
        detail: `unreachable: ${(e as Error).message}`,
      });
    }
  }

  // Live activity per host (spec 16 §3.9).
  const live = daemonUp && (await receiverLive(doFetch, otlpPort));
  for (const h of [...hostsHere, "gemini"]) {
    const wrote = (keys: string[] | undefined) =>
      !!keys && keys.every((k) => town.written.some((e) => e.key === k));
    const otel = wrote(ACTIVITY_KEYS[h]);
    if (
      h === "gemini" &&
      !town.written.some((e) => e.path === ".gemini/settings.json")
    )
      continue;
    const hooks = HOOK_KEYS[h] ? wrote(HOOK_KEYS[h]) : h === "codex";
    if (otel && live && (hooks || h === "gemini"))
      checks.push({
        name: `activity ${h}`,
        state: "ok",
        detail: "activity: live",
      });
    else if (!HOOK_KEYS[h] && !ACTIVITY_KEYS[h])
      checks.push({
        name: `activity ${h}`,
        state: "warn",
        detail: "activity: none (this host has no hooks or telemetry here)",
      });
    else
      checks.push({
        name: `activity ${h}`,
        state: "warn",
        detail: `activity: not live (${[!otel && "telemetry config missing or skipped", !live && `receiver on 127.0.0.1:${otlpPort} not answering`, !hooks && "hooks missing"].filter(Boolean).join("; ")})`,
      });
  }
  return checks;
}

export function renderChecks(cs: Check[]): string {
  const mark: Record<CheckState, string> = {
    ok: "ok  ",
    fail: "FAIL",
    warn: "warn",
    manual: "man ",
  };
  const lines = cs.map((c) => `${mark[c.state]} ${c.name}: ${c.detail}`);
  if (cs.some((c) => c.state === "fail" || c.state === "warn"))
    lines.push("Fix: hawl doctor --fix");
  return lines.join("\n");
}

export interface DoctorDeps extends JoinDeps {
  /** The coach's tips per agent, newest first. No source means the Agents block is left out. */
  agentTips?: () => Promise<AgentTips[]>;
}

/** `hawl doctor`. Exit code 1 when any check fails. */
export async function doctor(
  o: { projectDir?: string; codexHome?: string; fix?: boolean },
  deps: DoctorDeps = {},
): Promise<{ checks: Check[]; exitCode: number }> {
  const checks = await doctorChecks(o, deps);
  const print = deps.print ?? ((l) => process.stdout.write(`${l}\n`));
  print(renderChecks(checks));
  if (deps.agentTips) {
    let lines: string[];
    try {
      lines = agentSection(await deps.agentTips());
    } catch (e) {
      lines = [
        "Agents",
        `  Tips are not available right now: ${(e as Error).message}`,
      ];
    }
    print(lines.join("\n"));
  }
  return { checks, exitCode: checks.some((c) => c.state === "fail") ? 1 : 0 };
}

/** Agent section of `hawl doctor` (RLY-20): the coach's tips for each agent, in plain words. */

export type AgentTip = { text: string; shown: boolean };
export type AgentTips = { handle: string; tips: AgentTip[] };

export const TIP_PREFIX = "Hawl tip:";

/** Lines for the doctor output. An agent with no tips gets one calm line. */
export function agentSection(agents: AgentTips[]): string[] {
  const out = ["Agents"];
  if (agents.length === 0) return [...out, "  No agents yet."];
  for (const a of agents) {
    if (a.tips.length === 0) {
      out.push(`  ${a.handle}: nothing to fix.`);
      continue;
    }
    out.push(`  ${a.handle}:`);
    for (const t of a.tips)
      out.push(
        `    ${TIP_PREFIX} ${t.text}${t.shown ? "" : " (not shown yet)"}`,
      );
  }
  return out;
}
