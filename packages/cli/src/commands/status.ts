import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type Wiring, wiring } from "../api/wiring.ts";
import { debugUntil } from "../daemon/log.ts";
import { defaultStateDir } from "../daemon/main.ts";
import { makeStyle, type Style } from "../style.ts";
import { readTownFile } from "../town-file.ts";
import { fmtTime } from "./debug.ts";
import { daemonLinkFor, type JoinDeps } from "./join.ts";
import { localMemberships } from "./join-local.ts";
import { stdStyle } from "./team-cmds.ts";

interface DaemonStatus {
  pid: number;
  version: string;
  workers: {
    resident_id: string;
    platform: string;
    state: string;
    queued: number;
    unread: number;
    refused?: string;
  }[];
}

const QUEUED_HINT =
  "queued: messages received and saved on this PC, waiting for your agent. It reads them with the mailbox tool; nothing is stuck.";

export interface StatusSite {
  slug: string;
  resident_id: string;
  platform: string;
  state: string;
  queued: number;
  unread: number;
  /** Why the relay turned this agent away (removed, helper too old); absent when it did not. */
  refused?: string;
}

export interface StatusReport {
  folder: string;
  yard: string | null;
  sites: StatusSite[];
  /** Hosts this folder joined with `--local` (no site). */
  local?: { host: string; resident_id: string }[];
  /** `workers`/`connected` count every worker on this machine, not just this folder's (tray). */
  daemon: {
    running: boolean;
    pid?: number;
    version?: string;
    workers?: number;
    connected?: number;
  };
  update_channel: string;
  /** Plain words on what "queued" means; only when something is queued. */
  hint?: string;
  /** How any agent or script uses Hawl in this folder (MCP, CLI verbs, local HTTP API). */
  wiring?: Wiring;
  /** ISO time verbose logging ends; absent when it is off. */
  debug_until?: string;
}

/** `~/.hawl/config.json` `update.channel`, default `latest` (spec 16 §3.7). */
export function updateChannel(stateDir: string): string {
  try {
    const f = join(stateDir, "config.json");
    if (!existsSync(f)) return "latest";
    const c = JSON.parse(readFileSync(f, "utf8")) as {
      update?: { channel?: string };
    };
    return c.update?.channel ?? "latest";
  } catch {
    return "latest";
  }
}

export async function statusReport(
  o: { projectDir?: string },
  deps: JoinDeps = {},
): Promise<StatusReport> {
  const stateDir = deps.stateDir ?? defaultStateDir();
  const projectDir = resolve(o.projectDir ?? process.cwd());
  const town = readTownFile(projectDir);
  let ds: DaemonStatus | null = null;
  try {
    ds = (await (deps.daemon ?? daemonLinkFor)(stateDir).call(
      "status",
    )) as DaemonStatus;
  } catch {
    ds = null;
  }
  const sites: StatusSite[] = [];
  for (const m of town?.memberships ?? []) {
    for (const w of m.workers) {
      const live = ds?.workers.find((x) => x.resident_id === w.resident_id);
      sites.push({
        slug: m.town_slug,
        resident_id: w.resident_id,
        platform: w.platform,
        state: live?.state ?? "not attached",
        queued: live?.queued ?? 0,
        unread: live?.unread ?? 0,
        ...(live?.refused && { refused: live.refused }),
      });
    }
  }
  const until = debugUntil(stateDir);
  const local = localMemberships(projectDir).map((m) => ({
    host: m.host,
    resident_id: m.resident_id,
  }));
  return {
    folder: projectDir,
    yard: town?.folder_label ?? null,
    sites,
    ...(local.length > 0 && { local }),
    daemon: ds
      ? {
          running: true,
          pid: ds.pid,
          version: ds.version,
          workers: ds.workers.length,
          connected: ds.workers.filter((w) => w.state === "connected").length,
        }
      : { running: false },
    update_channel: updateChannel(stateDir),
    ...(sites.some((s) => s.queued > 0) && { hint: QUEUED_HINT }),
    ...(sites.length > 0 && { wiring: wiring(stateDir, projectDir) }),
    ...(until !== null && { debug_until: new Date(until).toISOString() }),
  };
}

export function renderStatus(
  r: StatusReport,
  st: Style = makeStyle(false, true),
): string {
  const row = (k: string, v: string) => `${st.dim(k.padEnd(9))}${v}`;
  const siteLine = (s: StatusSite) =>
    `${st.bold(s.slug)}: ${s.state === "connected" ? st.green(s.state) : st.yellow(s.state)}, ${s.queued} queued, ${s.unread} unread`;
  const sites = r.sites.length
    ? r.sites.flatMap((s) => [
        row("Site", siteLine(s)),
        ...(s.refused ? [row("", st.red(s.refused))] : []),
      ])
    : [
        row(
          "Site",
          r.local?.length
            ? `local mode (${r.local.map((l) => `${l.resident_id}, ${l.host}`).join(", ")})`
            : "none (join one: hawl join <site>)",
        ),
      ];
  const verbose = r.debug_until
    ? [
        row(
          "Logging",
          `verbose logging on until ${fmtTime(Date.parse(r.debug_until))}`,
        ),
      ]
    : [];
  return [
    row("Folder", r.yard ?? basename(r.folder)),
    ...sites,
    row(
      "Helper",
      r.daemon.running
        ? `${st.green("running")} (v${r.daemon.version})`
        : st.red("not running"),
    ),
    ...verbose,
    ...(r.daemon.running ? [] : [`Start it: ${st.bold("hawl service start")}`]),
    ...(r.hint ? [st.dim(r.hint)] : []),
  ].join("\n");
}

/** The `--json` shape (C-CMD-11): path, folder, sites, service. */
export function statusJson(r: StatusReport) {
  return {
    path: r.folder,
    folder: r.yard ?? basename(r.folder),
    sites: r.sites.map(
      ({ slug, platform, state, queued, unread, refused }) => ({
        slug,
        platform,
        state,
        queued,
        unread,
        ...(refused && { refused }),
      }),
    ),
    service: r.daemon,
    update_channel: r.update_channel,
  };
}

/** `hawl status [--json]` */
export async function status(
  o: { projectDir?: string; json?: boolean },
  deps: JoinDeps = {},
): Promise<StatusReport> {
  const r = await statusReport(o, deps);
  const print = deps.print ?? ((l) => process.stdout.write(`${l}\n`));
  print(
    o.json
      ? JSON.stringify(statusJson(r), null, 2)
      : renderStatus(r, stdStyle()),
  );
  return r;
}
