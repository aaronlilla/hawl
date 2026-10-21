import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileDurable } from "../daemon/fsutil.ts";
import { type KeyStore, openKeyStore } from "../daemon/keys.ts";
import { defaultStateDir } from "../daemon/main.ts";
import { readWorkers } from "../daemon/workers.ts";
import { removeExclude } from "../hosts/exclude.ts";
import { removeEntries } from "../hosts/merge.ts";
import { absPath } from "../hosts/types.ts";
import { removeUserScope } from "../hosts/user-scope.ts";
import {
  dropWorker,
  readTownFile,
  removeTownDir,
  type TownFile,
  writeTownFile,
} from "../town-file.ts";
import {
  clientAssertion,
  daemonLinkFor,
  type JoinDeps,
  JoinError,
} from "./join.ts";
import { leaveLocal } from "./join-local.ts";

export interface LeaveOpts {
  projectDir?: string;
  site?: string;
  all?: boolean;
}

export interface LeaveResult {
  left: string[];
  removed: number;
  kept: string[];
}

/** The relay could not be reached (no network, or a 5xx). The revoke can wait. */
export class OfflineError extends Error {}

/** A revoke that could not reach the relay. Holds no secret: the key stays in the key store. */
export interface QueuedRevoke {
  relay_url: string;
  resident_id: string;
  kid: string;
  queued_at: string;
}

const queuePath = (stateDir: string) => join(stateDir, "revoke-queue.json");

export function readRevokeQueue(stateDir: string): QueuedRevoke[] {
  const f = queuePath(stateDir);
  if (!existsSync(f)) return [];
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as unknown;
    return Array.isArray(j) ? (j as QueuedRevoke[]) : [];
  } catch {
    return [];
  }
}

function writeRevokeQueue(stateDir: string, q: QueuedRevoke[]): void {
  writeFileDurable(
    queuePath(stateDir),
    `${JSON.stringify(q, null, 2)}
`,
  );
}

/** Exchange the worker's key for a short AgentToken, then revoke the worker. 401 = already revoked. */
async function revoke(
  doFetch: typeof fetch,
  relayUrl: string,
  rid: string,
  kid: string,
  privateJwk: Record<string, string>,
): Promise<void> {
  const send = async (url: string, init: RequestInit): Promise<Response> => {
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (e) {
      throw new OfflineError((e as Error).message);
    }
    if (res.status >= 500)
      throw new OfflineError(`relay answered ${res.status}`);
    return res;
  };
  const tokRes = await send(`${relayUrl}/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_assertion: clientAssertion(rid, kid, privateJwk, relayUrl),
    }),
  });
  if (tokRes.status === 401) return;
  if (!tokRes.ok)
    throw new JoinError(`token exchange failed: ${tokRes.status}`);
  const { access_token } = (await tokRes.json()) as { access_token: string };
  const del = await send(`${relayUrl}/v1/residents/me`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!del.ok && del.status !== 401 && del.status !== 404)
    throw new JoinError(`revoke failed: ${del.status}`);
}

/**
 * Retry the revokes that `hawl leave` queued while offline. Each one that goes through loses its
 * key; the ones still offline stay queued. Never throws.
 */
export async function flushRevokes(deps: JoinDeps = {}): Promise<number> {
  const stateDir = deps.stateDir ?? defaultStateDir();
  const queue = readRevokeQueue(stateDir);
  if (queue.length === 0) return 0;
  const doFetch = deps.fetch ?? fetch;
  const keyStore: KeyStore =
    deps.keyStore ??
    (await openKeyStore({ stateDir, passphrase: process.env.HAWL_PASSPHRASE }));
  const left: QueuedRevoke[] = [];
  let done = 0;
  for (const q of queue) {
    try {
      const jwk = await keyStore.get(q.resident_id);
      if (jwk) await revoke(doFetch, q.relay_url, q.resident_id, q.kid, jwk);
      await keyStore.delete(q.resident_id);
      done++;
    } catch {
      left.push(q);
    }
  }
  writeRevokeQueue(stateDir, left);
  return done;
}

/**
 * `hawl leave`: revoke the worker(s), remove only our config entries (by recorded hash), delete
 * the keychain entry and the spool (spec 16 §3.1).
 */
export async function leave(
  opts: LeaveOpts,
  deps: JoinDeps = {},
): Promise<LeaveResult> {
  const print = deps.print ?? ((l) => process.stdout.write(`${l}\n`));
  const doFetch = deps.fetch ?? fetch;
  const stateDir = deps.stateDir ?? defaultStateDir();
  const home = deps.home ?? homedir();
  const projectDir = resolve(opts.projectDir ?? process.cwd());
  const dirs = { projectDir, stateDir };
  const town: TownFile | null = readTownFile(projectDir);
  // Revokes queued by an earlier offline leave go first, even when this folder has no
  // membership left (the last offline leave removes the town file).
  await flushRevokes({ ...deps, stateDir });
  if (!town || town.memberships.length === 0) {
    // A folder that joined with `hawl join --local` has no site: undo that instead.
    const local = leaveLocal(projectDir);
    if (local.length > 0) {
      print(`Left local mode (${local.map((m) => m.host).join(", ")})`);
      return {
        left: [...new Set(local.map((m) => m.resident_id))],
        removed: local.length,
        kept: [],
      };
    }
    throw new JoinError("this folder has no hawl membership");
  }

  const picked = town.memberships.filter(
    (m) =>
      opts.all ||
      (opts.site ? m.town_slug === opts.site : town.memberships.length === 1),
  );
  if (picked.length === 0)
    throw new JoinError(
      opts.site
        ? `no membership for site ${opts.site} in this folder`
        : "this folder is in several sites; pass --site <slug> or --all",
    );

  const keyStore: KeyStore =
    deps.keyStore ??
    (await openKeyStore({ stateDir, passphrase: process.env.HAWL_PASSPHRASE }));
  const result: LeaveResult = { left: [], removed: 0, kept: [] };
  const link = (deps.daemon ?? daemonLinkFor)(stateDir);

  for (const m of picked) {
    for (const w of [...m.workers]) {
      const jwk = await keyStore.get(w.resident_id);
      let queued = false;
      if (jwk) {
        try {
          await revoke(doFetch, m.relay_url, w.resident_id, w.kid, jwk);
        } catch (e) {
          if (!(e instanceof OfflineError)) throw e;
          // Offline: clean up here, revoke later. The key stays so the retry can sign.
          const q = readRevokeQueue(stateDir).filter(
            (x) => x.resident_id !== w.resident_id,
          );
          q.push({
            relay_url: m.relay_url,
            resident_id: w.resident_id,
            kid: w.kid,
            queued_at: new Date().toISOString(),
          });
          writeRevokeQueue(stateDir, q);
          queued = true;
        }
      }
      try {
        await link.call("detach", {
          resident_id: w.resident_id,
          destroy_spool: true,
        });
      } catch {
        // daemon not running: nothing attached
      }
      // Also when the daemon is down, so its next start does not reconnect a worker that left.
      const { forgetWorker } = await import("../daemon/workers.ts");
      forgetWorker(stateDir, w.resident_id);

      // Entries another remaining worker also owns stay: the file still serves it.
      const mine = town.written.filter((e) => e.resident_id === w.resident_id);
      const shared = (e: (typeof mine)[number]) =>
        town.written.some(
          (o) =>
            o.resident_id !== w.resident_id &&
            o.path === e.path &&
            o.key === e.key &&
            o.sha256 === e.sha256,
        );
      const byPath = new Map<string, typeof mine>();
      for (const e of mine) {
        if (shared(e)) continue;
        byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
      }
      for (const [path, entries] of byPath) {
        const restore = town.restore.find(
          (r) => r.resident_id === w.resident_id && r.path === path,
        );
        const r = removeEntries(
          absPath(path, { projectDir, home }),
          path,
          entries,
          restore,
          dirs,
        );
        result.removed += r.removed.length;
        result.kept.push(...r.kept.map((k) => `${path} ${k}`));
      }
      if (!queued) await keyStore.delete(w.resident_id);
      dropWorker(town, w.resident_id);
      result.left.push(w.resident_id);
      print(`Left ${m.town_slug}: ${w.resident_id}`);
      if (queued)
        print(
          "Offline: removed everything on this machine. The site will be told when you are back online.",
        );
    }
  }
  for (const k of result.kept) print(`Kept ${k}: changed since we wrote it`);
  // Last worker on this machine gone: take the machine-wide hooks and MCP back out.
  if (readWorkers(stateDir).length === 0) {
    try {
      const u = removeUserScope({ home, stateDir, ...deps.userScope });
      for (const k of u.kept) print(`Kept ${k}: changed since we wrote it`);
      if (u.mcp === "failed")
        print(
          "Warning: could not remove the machine-wide `hawl` MCP server; run `claude mcp remove --scope user hawl`.",
        );
    } catch (e) {
      print(
        `Warning: could not remove machine-wide hooks (${(e as Error).message}).`,
      );
    }
  }
  if (town.memberships.length === 0) {
    removeTownDir(projectDir);
    if (town.exclude) removeExclude(projectDir);
  } else writeTownFile(projectDir, town);
  return result;
}
