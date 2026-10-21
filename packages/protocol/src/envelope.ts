import type { KeyObject } from "node:crypto";
import { b64url, fromB64url, requestHash, viewSha256 } from "./hash.ts";
import { jcsBytes } from "./jcs.ts";
import { signEd25519, signEs256, verifyDetached } from "./sign.ts";

/** Message envelope, 04 §4 with the tech spec 16 §2.4.1 deltas. */

export type Intent = "inform" | "ask" | "request_action" | "reply" | "status";

export type Part =
  | { kind: "text"; text: string }
  | { kind: "data"; data: unknown }
  | {
      kind: "file";
      file_id: string;
      name: string;
      mime: string;
      bytes: number;
      sha256: string;
    };

export type To =
  | { kind: "worker"; resident_id: string }
  | { kind: "channel"; channel_id: string; mentions: string[] };

export interface ClientRequest {
  v: 1;
  sender_resident_id: string;
  kid: string;
  idempotency_key: string;
  conversation_id: string | null;
  reply_to?: string | null;
  derived_from: string[];
  to: To;
  intent: Intent;
  requested_capabilities: string[];
  content: { parts: Part[] };
  created_at: string;
  requested_expires_in?: number;
}

export interface SenderSig {
  alg: "EdDSA";
  kid: string;
  covers: "client_request";
  sig: string;
}

export interface View {
  parts: Part[];
}

export interface RelayBlock {
  message_id: string;
  conversation_id: string;
  task_id: string | null;
  from: {
    resident_id: string;
    handle: string;
    town_id: string;
    town_slug: string;
    owner_user_id: string;
    platform: string;
    key_id: string;
    key_state: string;
  };
  origin: "agent" | "human" | "system";
  /** Set when a person typed the message on the dashboard: their name, sent through `from`. */
  typed_by?: { user_id: string; name: string };
  effective_intent: Intent;
  received_at: string;
  expires_at: string;
  request_hash: string;
  content_sha256: string;
  view_sha256: string;
  loop: {
    turn: number;
    turn_cap: number;
    hop: number;
    hop_cap: number;
    trace: string[];
    last_human_touch_at: string | null;
  };
  trust: {
    scope: "same_town";
    grant_id?: string | null;
    taint: string;
    taint_sources: string[];
  };
  scan: Record<string, unknown>;
  approval: {
    approval_id: string;
    approved_by: string;
    approved_at: string;
  } | null;
  handoff?: { handoff_id: string; state: string; op: string };
  delivery: {
    recipient_resident_id: string;
    inbox_seq: number;
    attempt: number;
  };
}

export const RELAY_SIG_COVERS =
  "jcs:v1:{v,sender_sig,view,relay-minus-delivery.attempt}" as const;

export interface RelaySig {
  alg: "ES256";
  kid: string;
  covers: typeof RELAY_SIG_COVERS;
  sig: string;
}

export interface Envelope {
  v: 1;
  /** b64url of the exact client_request bytes the sender signed. */
  client_request: string;
  sender_sig?: SenderSig;
  view: View;
  relay: RelayBlock;
  relay_sig: RelaySig;
}

type Signable = Pick<Envelope, "v" | "view" | "relay"> & {
  sender_sig?: SenderSig;
};

/** The exact bytes that get signed and stored: JCS of the client_request. */
export function clientRequestBytes(cr: ClientRequest): Buffer {
  return jcsBytes(cr);
}

export function signClientRequest(
  cr: ClientRequest,
  privateKey: KeyObject,
): { bytes: Buffer; client_request: string; sender_sig: SenderSig } {
  const bytes = clientRequestBytes(cr);
  return {
    bytes,
    client_request: b64url(bytes),
    sender_sig: {
      alg: "EdDSA",
      kid: cr.kid,
      covers: "client_request",
      sig: b64url(signEd25519(privateKey, bytes)),
    },
  };
}

/** sender_sig check over the carried bytes. */
export function verifySenderSig(
  clientRequestB64: string,
  senderSig: SenderSig,
  publicKey: KeyObject,
): boolean {
  if (senderSig.alg !== "EdDSA" || senderSig.covers !== "client_request")
    return false;
  let bytes: Buffer;
  try {
    bytes = fromB64url(clientRequestB64);
  } catch {
    return false;
  }
  return verifyDetached("EdDSA", publicKey, bytes, senderSig.sig);
}

/**
 * Bytes covered by relay_sig. `relay.delivery.attempt` is excluded so a
 * redelivery does not need a new signature; the rest of delivery is covered.
 */
export function relaySigInput(e: Signable): Buffer {
  const { attempt: _attempt, ...delivery } = e.relay.delivery;
  const payload: Record<string, unknown> = {
    v: e.v,
    view: e.view,
    relay: { ...e.relay, delivery },
  };
  if (e.sender_sig !== undefined) payload.sender_sig = e.sender_sig;
  return jcsBytes(payload);
}

export function signRelay(
  e: Signable,
  privateKey: KeyObject,
  kid: string,
): RelaySig {
  return {
    alg: "ES256",
    kid,
    covers: RELAY_SIG_COVERS,
    sig: b64url(signEs256(privateKey, relaySigInput(e))),
  };
}

export function verifyRelaySig(e: Envelope, publicKey: KeyObject): boolean {
  if (e.relay_sig.alg !== "ES256" || e.relay_sig.covers !== RELAY_SIG_COVERS)
    return false;
  return verifyDetached("ES256", publicKey, relaySigInput(e), e.relay_sig.sig);
}

export type VerifyFailure =
  | "relay_sig"
  | "sender_sig_missing"
  | "sender_sig"
  | "request_hash"
  | "view_sha256"
  | "recipient"
  | "client_request_encoding";

export interface VerifyKeys {
  relay: KeyObject;
  /** Sender key for `sender_sig.kid`, or null when unknown (fails if sender_sig is present). */
  sender: KeyObject | null;
}

/**
 * Recipient checks from 04 §4.2: relay_sig, sender_sig over the carried bytes,
 * request_hash, view_sha256, and that the delivery names this recipient.
 * Returns null when everything holds, else the first failing check.
 */
export function verifyDelivery(
  e: Envelope,
  keys: VerifyKeys,
  selfResidentId: string,
  opts: { requireSenderSig?: boolean } = {},
): VerifyFailure | null {
  if (!verifyRelaySig(e, keys.relay)) return "relay_sig";
  let bytes: Buffer;
  try {
    bytes = fromB64url(e.client_request);
  } catch {
    return "client_request_encoding";
  }
  if (e.sender_sig !== undefined) {
    if (
      keys.sender === null ||
      !verifySenderSig(e.client_request, e.sender_sig, keys.sender)
    ) {
      return "sender_sig";
    }
  } else if (opts.requireSenderSig) {
    return "sender_sig_missing";
  }
  if (requestHash(bytes) !== e.relay.request_hash) return "request_hash";
  if (viewSha256(e.view) !== e.relay.view_sha256) return "view_sha256";
  if (e.relay.delivery.recipient_resident_id !== selfResidentId)
    return "recipient";
  return null;
}

export function parseClientRequest(clientRequestB64: string): ClientRequest {
  return JSON.parse(
    fromB64url(clientRequestB64).toString("utf8"),
  ) as ClientRequest;
}
