import type { KeyObject } from "node:crypto";
import { importPublicJwk, type Jwk } from "@hawl/protocol/src/sign.ts";

/**
 * Sender key lookup for `sender_sig` (04 §4.2): GET /v1/keys/{kid}. Retired keys still
 * verify; a key compromised at or before the message's receipt does not. Cached per kid.
 */
export function senderKeyFetcher(opts: {
  relayUrl: string;
  fetch?: typeof fetch;
  /** AgentToken headers; supplied once the daemon can mint them. */
  headers?: () => Promise<Record<string, string>>;
}): (kid: string, at: string) => Promise<KeyObject | null> {
  const doFetch = opts.fetch ?? fetch;
  const cache = new Map<
    string,
    { key: KeyObject; compromisedAt: number | null }
  >();
  return async (kid, at) => {
    let hit = cache.get(kid);
    if (!hit) {
      try {
        const res = await doFetch(new URL(`/v1/keys/${kid}`, opts.relayUrl), {
          headers: opts.headers ? await opts.headers() : {},
        });
        if (!res.ok) return null;
        // The relay answers `public_jwk` (GET /v1/keys/{kid}); `jwk` is the older spelling.
        const body = (await res.json()) as {
          public_jwk?: Jwk;
          jwk?: Jwk;
          compromised_at?: string | null;
        };
        const jwk = body.public_jwk ?? body.jwk;
        if (!jwk) return null;
        hit = {
          key: importPublicJwk(jwk),
          compromisedAt: body.compromised_at
            ? Date.parse(body.compromised_at)
            : null,
        };
        cache.set(kid, hit);
      } catch {
        return null;
      }
    }
    if (hit.compromisedAt !== null) {
      const t = Date.parse(at);
      if (Number.isNaN(t) || t >= hit.compromisedAt) return null;
    }
    return hit.key;
  };
}
