import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { idFilePath } from "./project-id.ts";
import { readTownFile, type TownFile } from "./town-file.ts";

/**
 * Which folder, site and worker a session belongs to (machine-service routing).
 *
 * Rules:
 * - Walk up from the session's working directory to the nearest `.hawl/hawl.json`. The nearest
 *   joined folder wins, so a folder joined inside another joined folder routes to its own sites.
 * - No `.hawl/hawl.json` on the way up: the folder is not mapped. Hooks stay silent, the MCP
 *   server offers no tools, nothing is sent.
 * - Inside the folder: `HAWL_RESIDENT_ID` (a worker id) beats `HAWL_SITE` (a site slug), which
 *   beats the folder's own `.hawl/<host>.json`, which beats the only worker of that platform.
 *   Several candidates left: the first membership in the file, and `ambiguous` is set.
 */
export interface Route {
  /** The joined folder (the one holding `.hawl/`). */
  root: string;
  town: TownFile;
  site_slug: string;
  town_id: string;
  relay_url: string;
  resident_id: string;
  platform: string;
  /** What picked the worker. */
  source: "env_resident" | "env_site" | "id_file" | "platform" | "first";
  /** True when more than one worker could have served and the rule picked the first. */
  ambiguous: boolean;
}

export interface ResolveOpts {
  /** Host id (claude_code, codex, ...): prefers that platform's worker. */
  host?: string;
  env?: NodeJS.ProcessEnv;
}

/** Nearest folder at or above `start` that holds `.hawl/hawl.json`. */
export function findJoinedRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".hawl", "hawl.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function readIdFile(root: string, host: string): string | null {
  try {
    const j = JSON.parse(readFileSync(join(root, idFilePath(host)), "utf8"));
    return typeof j?.resident_id === "string" ? j.resident_id : null;
  } catch {
    return null;
  }
}

export function resolveRoute(cwd: string, o: ResolveOpts = {}): Route | null {
  const env = o.env ?? process.env;
  const root = findJoinedRoot(cwd);
  if (!root) return null;
  let town: TownFile | null;
  try {
    town = readTownFile(root);
  } catch {
    return null; // unreadable or a newer version: treat as not mapped rather than guess
  }
  if (!town) return null;
  const all = town.memberships.flatMap((m) => m.workers.map((w) => ({ m, w })));
  if (all.length === 0) return null;
  const pick = (
    list: typeof all,
    source: Route["source"],
    ambiguous = false,
  ): Route | null => {
    const hit = list[0];
    if (!hit) return null;
    return {
      root,
      town: town as TownFile,
      site_slug: hit.m.town_slug,
      town_id: hit.m.town_id,
      relay_url: hit.m.relay_url,
      resident_id: hit.w.resident_id,
      platform: hit.w.platform,
      source,
      ambiguous,
    };
  };
  const wantRid = env.HAWL_RESIDENT_ID;
  if (wantRid) {
    // An id that is not one of this folder's workers is ignored, not trusted.
    const r = pick(
      all.filter((p) => p.w.resident_id === wantRid),
      "env_resident",
    );
    if (r) return r;
  }
  const forHost = (list: typeof all) =>
    o.host ? list.filter((p) => p.w.platform === o.host) : list;
  const wantSite = env.HAWL_SITE;
  if (wantSite) {
    const inSite = all.filter((p) => p.m.town_slug === wantSite);
    const hosted = forHost(inSite);
    const r = pick(hosted.length ? hosted : inSite, "env_site");
    if (r) return r;
  }
  if (o.host) {
    // Only the joined root's own id file: an id file further up belongs to another folder.
    const id = readIdFile(root, o.host);
    const r =
      id &&
      pick(
        all.filter((p) => p.w.resident_id === id),
        "id_file",
      );
    if (r) return r;
  }
  const hosted = forHost(all);
  if (hosted.length >= 1)
    return pick(
      hosted,
      hosted.length === 1 ? "platform" : "first",
      hosted.length > 1,
    );
  return pick(all, "first", all.length > 1);
}
