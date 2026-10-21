import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClientRequest,
  type Envelope,
  type RelayBlock,
  signClientRequest,
  signRelay,
} from "@hawl/protocol/src/envelope.ts";
import {
  b64url,
  contentSha256,
  requestHash,
  viewSha256,
} from "@hawl/protocol/src/hash.ts";
import { newId } from "@hawl/protocol/src/ids.ts";
import { jcsBytes } from "@hawl/protocol/src/jcs.ts";
import { type Jwk, signEd25519 } from "@hawl/protocol/src/sign.ts";
import type { KeyManifest } from "@hawl/protocol/src/types.ts";

/** One sender key for every test envelope; tests serve it as the sender-key lookup. */
export const SENDER = generateKeyPairSync("ed25519");

export function tmpState(): string {
  return mkdtempSync(join(tmpdir(), "hawl-test-"));
}

export function makeRoot(kid = "root_1") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    kid,
    privateKey,
    roots: { [kid]: publicKey.export({ format: "jwk" }) as Jwk },
  };
}

export function makeRelayKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  return {
    privateKey,
    publicKey,
    jwk: publicKey.export({ format: "jwk" }) as Jwk,
  };
}

export function signManifest(
  root: { kid: string; privateKey: KeyObject },
  payload: KeyManifest["payload"],
): KeyManifest {
  return {
    payload,
    sig: {
      alg: "EdDSA",
      kid: root.kid,
      sig: b64url(signEd25519(root.privateKey, jcsBytes(payload))),
    },
  };
}

export function manifestPayload(
  relayJwk: Jwk,
  over: Partial<KeyManifest["payload"]> = {},
  kid = "rk_2026q4",
): KeyManifest["payload"] {
  return {
    v: 1,
    seq: 1,
    not_before: "2026-01-01T00:00:00Z",
    not_after: "2099-01-01T00:00:00Z",
    keys: [
      {
        kid,
        jwk: relayJwk as unknown as KeyManifest["payload"]["keys"][0]["jwk"],
        status: "current",
      },
    ],
    revoked: [],
    ...over,
  };
}

/** A fully signed delivery to `recipient`. */
export function makeEnvelope(
  relayPrivate: KeyObject,
  recipient: string,
  opts: {
    seq?: number;
    kid?: string;
    text?: string;
    to?: ClientRequest["to"];
    intent?: ClientRequest["intent"];
  } = {},
) {
  const sender = SENDER;
  const a = newId("res");
  const cr: ClientRequest = {
    v: 1,
    sender_resident_id: a,
    kid: "key_TEST",
    idempotency_key: newId("msg"),
    conversation_id: null,
    derived_from: [],
    to: opts.to ?? { kind: "worker", resident_id: recipient },
    intent: opts.intent ?? "inform",
    requested_capabilities: [],
    content: { parts: [{ kind: "text", text: opts.text ?? "hello" }] },
    created_at: "2026-10-10T14:03:11.204Z",
  };
  const s = signClientRequest(cr, sender.privateKey);
  const view = { parts: cr.content.parts };
  const relay: RelayBlock = {
    message_id: newId("msg"),
    conversation_id: newId("cnv"),
    task_id: null,
    from: {
      resident_id: a,
      handle: "@bot",
      town_id: newId("twn"),
      town_slug: "acme",
      owner_user_id: newId("usr"),
      platform: "claude_code",
      key_id: "key_TEST",
      key_state: "current",
    },
    origin: "agent",
    effective_intent: "inform",
    received_at: "2026-10-10T14:03:11.391Z",
    expires_at: "2026-10-24T14:03:11.391Z",
    request_hash: requestHash(s.bytes),
    content_sha256: contentSha256(cr.content),
    view_sha256: viewSha256(view),
    loop: {
      turn: 1,
      turn_cap: 10,
      hop: 0,
      hop_cap: 3,
      trace: [a],
      last_human_touch_at: null,
    },
    trust: { scope: "same_town", taint: "none", taint_sources: [] },
    scan: {
      verdict: "clean",
      complete: true,
      views: ["original", "normalized", "json_keys"],
      detectors: [{ id: "l1.secrets", result: "pass" }],
      intent_mismatch: false,
      scanner_version: "scan-1.0.0",
      policy_version: 7,
      scanned_at: "2026-10-10T14:03:11.452Z",
    },
    approval: null,
    delivery: {
      recipient_resident_id: recipient,
      inbox_seq: opts.seq ?? 1,
      attempt: 1,
    },
  };
  const body = { v: 1 as const, view, relay, sender_sig: s.sender_sig };
  const env: Envelope = {
    v: 1,
    client_request: s.client_request,
    sender_sig: s.sender_sig,
    view,
    relay,
    relay_sig: signRelay(body, relayPrivate, opts.kid ?? "rk_2026q4"),
  };
  return { env, senderPublic: sender.publicKey };
}
