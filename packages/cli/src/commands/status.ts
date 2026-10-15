import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { defaultStateDir } from "../daemon/main.ts";
import { readTownFile } from "../town-file.ts";
import { daemonLinkFor, type JoinDeps } from "./join.ts";
import { localMemberships } from "./join-local.ts";

interface DaemonStatus {
  pid: number;
  version: string;
  workers: {
    resident_id: string;
    platform: string;
    state: string;
    queued: number;
    unread: number;
  }[];
}

export interface StatusSite {
  slug: string;
  resident_id: string;
  platform: string;
  state: string;
  queued: number;
  unread: number;
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
      });
    }
  }
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
  };
}

export function renderStatus(r: StatusReport): string {
  const sites = r.sites.length
    ? r.sites
        .map(
          (s) =>
            `${s.slug}(${s.resident_id}, ${s.platform}, ${s.state}/queued ${s.queued}, unread ${s.unread})`,
        )
        .join(", ")
    : r.local?.length
      ? `local mode (${r.local.map((l) => `${l.resident_id}, ${l.host}`).join(", ")})`
      : "none";
  const yard = r.yard ?? basename(r.folder);
  const d = r.daemon.running
    ? `daemon pid ${r.daemon.pid} v${r.daemon.version}`
    : "daemon not running";
  return `${r.folder} -> yard ${yard} -> sites: ${sites}\n${d}, update channel ${r.update_channel}`;
}

/** `hawl status [--json]` */
export async function status(
  o: { projectDir?: string; json?: boolean },
  deps: JoinDeps = {},
): Promise<StatusReport> {
  const r = await statusReport(o, deps);
  const print = deps.print ?? ((l) => process.stdout.write(`${l}\n`));
  print(o.json ? JSON.stringify(r) : renderStatus(r));
  return r;
}
