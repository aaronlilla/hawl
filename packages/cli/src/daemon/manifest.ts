import type { KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jcsBytes } from "@hawl/protocol/src/jcs.ts";
import {
  importPublicJwk,
  type Jwk,
  verifyDetached,
} from "@hawl/protocol/src/sign.ts";
import type { KeyManifest } from "@hawl/protocol/src/types.ts";
import { validate } from "@hawl/protocol/src/validate.ts";
import { writeFileDurable } from "./fsutil.ts";

/**
 * Pinned offline root public keys (Ed25519 JWK by `root_<n>` id), shipped in the binary.
 * Pinned 2026-10-14 (root key ceremony). The private half is offline; the prod relay manifest is
 * signed with it at the first prod deploy (`relay-admin keys init`).
 */
export const PINNED_ROOTS: Record<string, Jwk> = {
  root_1: {
    kty: "OKP",
    crv: "Ed25519",
    x: "xMF_I_Fs57p7Hsu4ksrGA_OPkJoMnVKqKjahxdi2byg",
  },
};

/** Hosts HAWL_DEV_PINNED_ROOTS may vouch for: this machine, and our own staging relay. */
export const DEV_ROOT_HOSTS = [
  "localhost",
  "127.0.0.1",
  "[::1]",
  "relay-staging.hawl.ai",
] as const;

/**
 * The pinned roots, plus a dev root: HAWL_DEV_PINNED_ROOTS (JSON `{root_id: jwk}`) counts only
 * while HAWL_RELAY_URL points at loopback or at relay-staging (its own root `root_staging`,
 * spec 16 section 1.5), so it can never vouch for the prod relay or anyone else's. The local
 * e2e stack signs its manifest with a throwaway root; CI e2e pins root_staging.
 */
export function pinnedRoots(
  env: Record<string, string | undefined> = process.env,
): Record<string, Jwk> {
  const dev = env.HAWL_DEV_PINNED_ROOTS;
  if (!dev || !env.HAWL_RELAY_URL) return PINNED_ROOTS;
  try {
    const host = new URL(env.HAWL_RELAY_URL).hostname;
    if (!(DEV_ROOT_HOSTS as readonly string[]).includes(host))
      return PINNED_ROOTS;
    return { ...(JSON.parse(dev) as Record<string, Jwk>), ...PINNED_ROOTS };
  } catch {
    return PINNED_ROOTS;
  }
}

export type ManifestReject =
  | "schema"
  | "unknown_root"
  | "root_sig"
  | "rollback"
  | "not_yet_valid"
  | "expired";

export type AcceptResult =
  | { ok: true; seq: number; changed: boolean }
  | { ok: false; reason: ManifestReject };

/**
 * Holds the highest accepted root-signed relay key manifest (04 §6) in
 * `<stateDir>/manifest.json`. Lower `seq`, or equal `seq` with different content, is refused.
 */
export class ManifestStore {
  private manifest: KeyManifest | null = null;
  private readonly file: string;

  private readonly roots: Record<string, Jwk>;
  private readonly clock: () => number;

  constructor(
    stateDir: string,
    roots: Record<string, Jwk>,
    clock: () => number = Date.now,
  ) {
    this.roots = roots;
    this.clock = clock;
    this.file = join(stateDir, "manifest.json");
    if (existsSync(this.file)) {
      try {
        const m = JSON.parse(readFileSync(this.file, "utf8")) as KeyManifest;
        // Re-verify what is on disk: a planted file must not become the trust anchor.
        if (this.check(m).ok) this.manifest = m;
      } catch {
        this.manifest = null;
      }
    }
  }

  /** Stateless checks: schema and root signature. */
  private check(
    m: unknown,
  ): { ok: true } | { ok: false; reason: ManifestReject } {
    if (!validate("key-manifest", m).ok) return { ok: false, reason: "schema" };
    const mm = m as KeyManifest;
    const rootJwk = this.roots[mm.sig.kid];
    if (!rootJwk) return { ok: false, reason: "unknown_root" };
    let rootKey: KeyObject;
    try {
      rootKey = importPublicJwk(rootJwk);
    } catch {
      return { ok: false, reason: "unknown_root" };
    }
    if (!verifyDetached("EdDSA", rootKey, jcsBytes(mm.payload), mm.sig.sig)) {
      return { ok: false, reason: "root_sig" };
    }
    return { ok: true };
  }

  get current(): KeyManifest | null {
    return this.manifest;
  }

  get seq(): number {
    return this.manifest?.payload.seq ?? -1;
  }

  /** True while the held manifest is inside its not_before..not_after window. */
  get usable(): boolean {
    const m = this.manifest;
    if (!m) return false;
    const now = this.clock();
    return (
      now >= Date.parse(m.payload.not_before) &&
      now <= Date.parse(m.payload.not_after)
    );
  }

  accept(candidate: unknown): AcceptResult {
    const c = this.check(candidate);
    if (!c.ok) return c;
    const m = candidate as KeyManifest;
    const now = this.clock();
    if (now < Date.parse(m.payload.not_before))
      return { ok: false, reason: "not_yet_valid" };
    if (now > Date.parse(m.payload.not_after))
      return { ok: false, reason: "expired" };
    const held = this.manifest;
    if (held) {
      if (m.payload.seq < held.payload.seq)
        return { ok: false, reason: "rollback" };
      if (m.payload.seq === held.payload.seq) {
        const same =
          Buffer.compare(jcsBytes(m.payload), jcsBytes(held.payload)) === 0;
        return same
          ? { ok: true, seq: m.payload.seq, changed: false }
          : { ok: false, reason: "rollback" };
      }
    }
    writeFileDurable(this.file, JSON.stringify(m));
    this.manifest = m;
    return { ok: true, seq: m.payload.seq, changed: true };
  }

  /**
   * Relay signing key `kid` as a verifier, or null. `at` is the time the signature claims
   * (ISO): a key revoked at or before `at` is refused. Fails closed when the manifest is
   * missing or outside its window.
   */
  relayKey(kid: string, at: string): KeyObject | null {
    const m = this.manifest;
    if (!m || !this.usable) return null;
    const k = m.payload.keys.find((x) => x.kid === kid);
    if (!k) return null;
    const rev = m.payload.revoked.find((x) => x.kid === kid);
    const atMs = Date.parse(at);
    if (rev && !(atMs < Date.parse(rev.at))) return null;
    if (rev && Number.isNaN(atMs)) return null;
    try {
      return importPublicJwk(k.jwk as unknown as Jwk);
    } catch {
      return null;
    }
  }
}

/** GET `/.well-known/relay-key-manifest.json` and offer it to the store. */
export async function refreshManifest(
  store: ManifestStore,
  relayUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AcceptResult | { ok: false; reason: "fetch" }> {
  try {
    const res = await fetchImpl(
      new URL("/.well-known/relay-key-manifest.json", relayUrl),
    );
    if (!res.ok) return { ok: false, reason: "fetch" };
    return store.accept(await res.json());
  } catch {
    return { ok: false, reason: "fetch" };
  }
}
