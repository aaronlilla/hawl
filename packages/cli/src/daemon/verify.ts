import type { KeyObject } from "node:crypto";
import {
  type Envelope,
  type VerifyFailure,
  verifyDelivery,
} from "@hawl/protocol/src/envelope.ts";
import { validate } from "@hawl/protocol/src/validate.ts";
import type { ManifestStore } from "./manifest.ts";

export type DropReason =
  | VerifyFailure
  | "schema"
  | "manifest_unusable"
  | "relay_key_unknown";

export interface VerifyContext {
  manifests: ManifestStore;
  residentId: string;
  /** Sender key for `sender_sig.kid` (GET /v1/keys/{kid}), or null if unknown. */
  senderKey?: (kid: string, at: string) => Promise<KeyObject | null>;
}

/**
 * Everything a recipient checks before it trusts a delivery (04 §4.2): schema, the relay
 * key from the root-signed manifest (not revoked at the signing time), relay_sig,
 * sender_sig, request_hash, view_sha256 and recipient. null = verified.
 */
export async function verifyEnvelope(
  env: Envelope,
  ctx: VerifyContext,
): Promise<DropReason | null> {
  if (!validate("envelope", env).ok) return "schema";
  if (!ctx.manifests.usable) return "manifest_unusable";
  const relay = ctx.manifests.relayKey(
    env.relay_sig.kid,
    env.relay.received_at,
  );
  if (!relay) return "relay_key_unknown";
  let sender: KeyObject | null = null;
  if (env.sender_sig) {
    sender =
      (await ctx.senderKey?.(env.sender_sig.kid, env.relay.received_at)) ??
      null;
  }
  return verifyDelivery(env, { relay, sender }, ctx.residentId);
}
