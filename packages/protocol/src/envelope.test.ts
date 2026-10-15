import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  type ClientRequest,
  type Envelope,
  parseClientRequest,
  type RelayBlock,
  signClientRequest,
  signRelay,
  verifyDelivery,
} from "./envelope.ts";
import { contentSha256, requestHash, viewSha256 } from "./hash.ts";
import { newId } from "./ids.ts";

function build() {
  const sender = generateKeyPairSync("ed25519");
  const relayKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const a = newId("res");
  const b = newId("res");
  const cr: ClientRequest = {
    v: 1,
    sender_resident_id: a,
    kid: "key_TEST",
    idempotency_key: "k1",
    conversation_id: null,
    derived_from: [],
    to: { kind: "channel", channel_id: newId("chn"), mentions: [b] },
    intent: "inform",
    requested_capabilities: [],
    content: {
      parts: [
        { kind: "text", text: "report attached" },
        {
          kind: "file",
          file_id: newId("fil"),
          name: "r.xml",
          mime: "text/xml",
          bytes: 10,
          sha256: "AA",
        },
      ],
    },
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
      handle: "bot",
      town_id: newId("twn"),
      town_slug: "acme",
      owner_user_id: newId("usr"),
      platform: "claude_code",
      key_id: "key_TEST",
      key_state: "current",
    },
    origin: "system",
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
    scan: { verdict: "clean", complete: true },
    approval: null,
    handoff: { handoff_id: newId("hnd"), state: "asked", op: "create" },
    delivery: { recipient_resident_id: b, inbox_seq: 1, attempt: 1 },
  };
  const body = { v: 1 as const, view, relay, sender_sig: s.sender_sig };
  const env: Envelope = {
    v: 1,
    client_request: s.client_request,
    sender_sig: s.sender_sig,
    view,
    relay,
    relay_sig: signRelay(body, relayKey.privateKey, "rk_test"),
  };
  return {
    env,
    keys: { relay: relayKey.publicKey, sender: sender.publicKey },
    a,
    b,
  };
}

test("delta fields (channel to, file part, system origin, handoff, same_town) round-trip and verify", () => {
  const { env, keys, b } = build();
  assert.equal(verifyDelivery(env, keys, b, { requireSenderSig: true }), null);
  const cr = parseClientRequest(env.client_request);
  assert.equal(cr.to.kind, "channel");
  assert.equal(cr.content.parts[1]?.kind, "file");
  assert.equal(env.relay.origin, "system");
  assert.equal(env.relay.trust.scope, "same_town");
});

test("redelivery with a new attempt count keeps relay_sig valid", () => {
  const { env, keys, b } = build();
  env.relay.delivery.attempt = 3;
  assert.equal(verifyDelivery(env, keys, b), null);
});

test("sender-less (API-key) envelope verifies unless a sender_sig is required", () => {
  const sender = generateKeyPairSync("ed25519");
  const relayKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { env, b } = build();
  const { sender_sig: _s, ...rest } = env;
  const e2: Envelope = {
    ...rest,
    relay_sig: signRelay(rest, relayKey.privateKey, "rk_test"),
  };
  const keys = { relay: relayKey.publicKey, sender: sender.publicKey };
  assert.equal(verifyDelivery(e2, keys, b), null);
  assert.equal(
    verifyDelivery(e2, keys, b, { requireSenderSig: true }),
    "sender_sig_missing",
  );
});

test("unknown sender key fails when sender_sig is present", () => {
  const { env, keys, b } = build();
  assert.equal(verifyDelivery(env, { ...keys, sender: null }, b), "sender_sig");
});

test("garbage base64url in client_request is rejected, not thrown", () => {
  const { env, keys, b } = build();
  const e: Envelope = { ...env, client_request: "not base64!" };
  // relay_sig does not cover client_request bytes directly, so it still verifies.
  assert.equal(verifyDelivery(e, keys, b), "client_request_encoding");
});
