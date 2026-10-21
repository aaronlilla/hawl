import { type KeyStore, openKeyStore } from "../daemon/keys.ts";
import { defaultStateDir } from "../daemon/main.ts";
import { type Membership, readTownFile, writeTownFile } from "../town-file.ts";
import { clientAssertion, type JoinDeps, JoinError } from "./join.ts";

export interface WakeOpts {
  projectDir: string;
  on: boolean;
}

export interface WakeDeps extends JoinDeps {
  /** Does the site allow wake? `undefined` means the relay would not say. */
  siteWake?: (m: Membership) => Promise<boolean | undefined>;
}

/**
 * Ask the relay whether the site owner left wake on. A worker token cannot always read the
 * switches (they are for owners and admins), so anything but a clear `false` counts as allowed;
 * the relay itself still suppresses every push while the switch is off.
 */
async function siteWakeFromRelay(
  m: Membership,
  doFetch: typeof fetch,
  keyStore: KeyStore,
): Promise<boolean | undefined> {
  const w = m.workers[0];
  if (!w) return undefined;
  try {
    const jwk = await keyStore.get(w.resident_id);
    if (!jwk) return undefined;
    const tok = await doFetch(`${m.relay_url}/v1/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_assertion: clientAssertion(
          w.resident_id,
          w.kid,
          jwk,
          m.relay_url,
        ),
      }),
    });
    if (!tok.ok) return undefined;
    const { access_token } = (await tok.json()) as { access_token: string };
    const r = await doFetch(
      `${m.relay_url}/v1/towns/${m.town_id}/settings/switches`,
      { headers: { authorization: `Bearer ${access_token}` } },
    );
    if (!r.ok) return undefined;
    const sw = (await r.json()) as { wake_enabled?: unknown };
    return typeof sw.wake_enabled === "boolean" ? sw.wake_enabled : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `hawl wake on|off` and `hawl config wake on|off` (S-440): the agent's owner opts this folder in
 * or out of idle wake (the fixed notice starts an idle Claude Code or Codex session; on by
 * default). Turning it on is refused, with the reason, when the site owner turned wake off.
 */
export async function wake(
  opts: WakeOpts,
  deps: WakeDeps = {},
): Promise<{ on: boolean }> {
  const print = deps.print ?? ((l) => process.stdout.write(`${l}\n`));
  const town = readTownFile(opts.projectDir);
  if (!town || town.memberships.length === 0)
    throw new JoinError("this folder has no hawl membership");

  if (opts.on) {
    const doFetch = deps.fetch ?? fetch;
    const keyStore =
      deps.keyStore ??
      (await openKeyStore({
        stateDir: deps.stateDir ?? defaultStateDir(),
        passphrase: process.env.HAWL_PASSPHRASE,
      }));
    for (const m of town.memberships) {
      const allowed = await (deps.siteWake
        ? deps.siteWake(m)
        : siteWakeFromRelay(m, doFetch, keyStore));
      if (allowed === false)
        throw new JoinError(
          `the owner of ${m.town_slug} turned wake off for the whole site. Ask them to turn it on in Settings, Safety.`,
        );
    }
  }
  town.wake = opts.on;
  writeTownFile(opts.projectDir, town);
  print(`wake ${opts.on ? "on" : "off"}`);
  return { on: opts.on };
}
