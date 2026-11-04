import { fromB64url } from "@hawl/protocol/src/hash.ts";
import { jcsBytes } from "@hawl/protocol/src/jcs.ts";
import {
  importPublicJwk,
  type Jwk,
  verifyEd25519,
} from "@hawl/protocol/src/sign.ts";

/**
 * Pinned release public key (Ed25519 JWK), shipped in the binary (spec 16 section 3.7).
 * Empty until the release key ceremony: every manifest is then refused.
 */
declare const __HAWL_UPDATE_PUBKEY__: Jwk;
export const UPDATE_PUBKEY: Jwk =
  typeof __HAWL_UPDATE_PUBKEY__ === "undefined" ? {} : __HAWL_UPDATE_PUBKEY__;

export interface UpdateAsset {
  os: string;
  arch: string;
  url: string;
  sha256: string;
}

export type UpdateSeverity = "optional" | "recommended" | "required";

/** So npx installs can be checked against the registry tarball. */
export interface UpdateNpm {
  name: string;
  version: string;
  integrity: string;
}

/** Release-record fields. Signed by `meta_sig`, not `sig`, so 0.1.x verifiers still accept the manifest. */
export interface UpdateRecord {
  notes_url?: string;
  /** At most 3 lines. */
  summary?: string;
  /** What the agent or user should do. */
  action?: string;
  /** Absent means optional. */
  severity?: UpdateSeverity;
  /** ISO date; only with severity `required`. */
  required_after?: string;
  npm?: UpdateNpm;
}

export interface UpdateManifest extends UpdateRecord {
  version: string;
  channel: string;
  min_relay: string;
  assets: UpdateAsset[];
  sig: string;
  /** Signature over the core fields plus the record fields; required when any record field is set. */
  meta_sig?: string;
}

export type UpdateReject =
  | "schema"
  | "no_key"
  | "bad_sig"
  | "channel"
  | "downgrade"
  | "no_asset";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function parseVersion(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when a < b. Both must be plain `x.y.z`; anything else throws. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`bad version: ${a} / ${b}`);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const RECORD_KEYS = [
  "notes_url",
  "summary",
  "action",
  "severity",
  "required_after",
  "npm",
] as const;
const SEVERITIES = ["optional", "recommended", "required"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/;

function hasRecord(o: Record<string, unknown>): boolean {
  return RECORD_KEYS.some((k) => o[k] !== undefined);
}

function recordOk(o: Record<string, unknown>): boolean {
  if (!hasRecord(o)) return true;
  if (!isStr(o.meta_sig)) return false;
  if (o.notes_url !== undefined)
    if (!isStr(o.notes_url) || !o.notes_url.startsWith("https://"))
      return false;
  if (o.summary !== undefined)
    if (!isStr(o.summary) || o.summary.split("\n").length > 3) return false;
  if (o.action !== undefined && !isStr(o.action)) return false;
  if (o.severity !== undefined)
    if (!isStr(o.severity) || !SEVERITIES.includes(o.severity)) return false;
  if (o.required_after !== undefined) {
    if (o.severity !== "required") return false;
    if (!isStr(o.required_after) || !ISO_DATE.test(o.required_after))
      return false;
    if (Number.isNaN(Date.parse(o.required_after))) return false;
  }
  if (o.npm !== undefined) {
    const n = o.npm as Record<string, unknown> | null;
    if (typeof n !== "object" || n === null) return false;
    if (!isStr(n.name) || !isStr(n.version) || !parseVersion(n.version))
      return false;
    if (!isStr(n.integrity) || !/^sha512-[A-Za-z0-9+/]+=*$/.test(n.integrity))
      return false;
  }
  return true;
}

function shape(raw: unknown): UpdateManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isStr(o.version) || !parseVersion(o.version)) return null;
  if (!isStr(o.channel) || !isStr(o.min_relay) || !isStr(o.sig)) return null;
  if (!Array.isArray(o.assets) || o.assets.length === 0) return null;
  for (const a of o.assets) {
    if (typeof a !== "object" || a === null) return null;
    const x = a as Record<string, unknown>;
    if (!isStr(x.os) || !isStr(x.arch) || !isStr(x.url)) return null;
    if (typeof x.sha256 !== "string" || !HEX64.test(x.sha256)) return null;
    if (!x.url.startsWith("https://")) return null;
  }
  if (!recordOk(o)) return null;
  return raw as UpdateManifest;
}

/** The signed bytes: JCS of the manifest without `sig`. */
export function signedBytes(m: Omit<UpdateManifest, "sig">): Buffer {
  return jcsBytes({
    version: m.version,
    channel: m.channel,
    min_relay: m.min_relay,
    assets: m.assets,
  });
}

/** Bytes `meta_sig` covers: the core fields plus every record field that is set. */
export function recordSignedBytes(m: Omit<UpdateManifest, "sig">): Buffer {
  const rec: Record<string, unknown> = {};
  for (const k of RECORD_KEYS) if (m[k] !== undefined) rec[k] = m[k];
  return jcsBytes({
    version: m.version,
    channel: m.channel,
    min_relay: m.min_relay,
    assets: m.assets,
    ...rec,
  });
}

export type VerifyResult =
  | { ok: true; manifest: UpdateManifest }
  | { ok: false; reason: UpdateReject };

export function verifyUpdateManifest(
  raw: unknown,
  pubkey: Jwk = UPDATE_PUBKEY,
): VerifyResult {
  const m = shape(raw);
  if (!m) return { ok: false, reason: "schema" };
  if (!pubkey.x) return { ok: false, reason: "no_key" };
  let ok = false;
  try {
    ok = verifyEd25519(
      importPublicJwk(pubkey),
      signedBytes(m),
      fromB64url(m.sig),
    );
  } catch {
    ok = false;
  }
  if (ok && hasRecord(m as unknown as Record<string, unknown>)) {
    try {
      ok = verifyEd25519(
        importPublicJwk(pubkey),
        recordSignedBytes(m),
        fromB64url(m.meta_sig as string),
      );
    } catch {
      ok = false;
    }
  }
  return ok ? { ok: true, manifest: m } : { ok: false, reason: "bad_sig" };
}

export interface PlanInput {
  current: string;
  /** Configured update channel (`~/.hawl/config.json`); only `latest` updates. */
  channel: string;
  os: string;
  arch: string;
}

export type Plan =
  | { ok: true; version: string; asset: UpdateAsset }
  | { ok: false; reason: UpdateReject | "up_to_date" };

/** Decide on a manifest that already passed `verifyUpdateManifest`. */
export function planUpdate(m: UpdateManifest, p: PlanInput): Plan {
  // The manifest must be for the channel that was asked for. The latest-only rule belongs to
  // the automatic daily check (`checkAndStage` without `force`), not to a typed `hawl update`.
  if (m.channel !== p.channel) return { ok: false, reason: "channel" };
  const cmp = compareVersions(m.version, p.current);
  if (cmp < 0) return { ok: false, reason: "downgrade" };
  if (cmp === 0) return { ok: false, reason: "up_to_date" };
  const asset = m.assets.find((a) => a.os === p.os && a.arch === p.arch);
  if (!asset) return { ok: false, reason: "no_asset" };
  return { ok: true, version: m.version, asset };
}
