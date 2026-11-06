import { createInterface } from "node:readline/promises";
import { openKeyStore } from "../daemon/keys.ts";
import { defaultStateDir } from "../daemon/main.ts";
import {
  confirmKeys,
  fingerprint,
  type KeyListing,
  type PinnedKey,
} from "../daemon/passkey.ts";
import { readTownFile } from "../town-file.ts";
import { clientAssertion, type JoinDeps, JoinError } from "./join.ts";

export interface PasskeysDeps extends JoinDeps {
  /** The owner's yes or no at this PC. Default: a y/N prompt on the terminal. */
  confirm?: (fresh: PinnedKey[], origin: string) => Promise<boolean>;
}

async function ask(fresh: PinnedKey[], origin: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await rl.question(
      `Trust ${fresh.length === 1 ? "this passkey" : "these passkeys"} of yours on ${origin} to approve sending files from this PC? (y/N) `,
    );
    return /^y(es)?$/i.test(a.trim());
  } finally {
    rl.close();
  }
}

/**
 * `hawl passkeys`: run on the PC that has the files. Lists the passkeys the relay says the owner
 * has, shows the ones this PC does not trust yet, and pins them only after the owner says yes
 * here. The relay alone can never add a key (daemon/passkey.ts).
 */
export async function passkeys(
  opts: { projectDir: string },
  deps: PasskeysDeps = {},
): Promise<{ added: number; removed: number }> {
  const print = deps.print ?? ((l) => process.stdout.write(`${l}\n`));
  const town = readTownFile(opts.projectDir);
  const m = town?.memberships[0];
  const w = m?.workers[0];
  if (!m || !w) throw new JoinError("this folder has no hawl membership");
  const doFetch = deps.fetch ?? fetch;
  const stateDir = deps.stateDir ?? defaultStateDir();
  const keyStore =
    deps.keyStore ??
    (await openKeyStore({ stateDir, passphrase: process.env.HAWL_PASSPHRASE }));
  const jwk = await keyStore.get(w.resident_id);
  if (!jwk) throw new JoinError("this PC has no key for this folder's agent");
  const tok = await doFetch(`${m.relay_url}/v1/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_assertion: clientAssertion(w.resident_id, w.kid, jwk, m.relay_url),
    }),
  });
  if (!tok.ok)
    throw new JoinError(`the relay refused this agent (${tok.status})`);
  const { access_token } = (await tok.json()) as { access_token: string };
  const r = await doFetch(`${m.relay_url}/v1/agent/passkeys`, {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!r.ok) throw new JoinError(`could not list your passkeys (${r.status})`);
  const l = (await r.json()) as KeyListing;
  const residents = town.memberships.flatMap((x) =>
    x.workers.map((y) => y.resident_id),
  );
  const out = await confirmKeys(
    stateDir,
    residents,
    l,
    deps.confirm ??
      (async (fresh, origin) => {
        print(
          "New passkeys on your account (check the names and dates in Settings, Security):",
        );
        for (const k of fresh)
          print(`  ${k.name || "Passkey"}  fingerprint ${fingerprint(k.cose)}`);
        return ask(fresh, origin);
      }),
  );
  print(
    out.added || out.removed
      ? `Trusted on this PC: ${out.added} added, ${out.removed} removed.`
      : "No change: this PC already trusts the passkeys it should.",
  );
  return out;
}
