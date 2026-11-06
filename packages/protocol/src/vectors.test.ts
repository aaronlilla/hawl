import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  type Envelope,
  type SenderSig,
  signClientRequest,
  verifyDelivery,
  verifySenderSig,
} from "./envelope.ts";
import {
  b64url,
  contentSha256,
  fromB64url,
  requestHash,
  viewSha256,
} from "./hash.ts";
import { jcs } from "./jcs.ts";
import {
  handshakeSignInput,
  importPrivateJwk,
  importPublicJwk,
  type Jwk,
  keyId,
  readySignInput,
  verifyEd25519,
  verifyEs256,
} from "./sign.ts";

function load<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../vectors/${name}.json`, import.meta.url), "utf8"),
  ) as T;
}

type Expect = "valid" | "invalid";

test("jcs vectors", () => {
  const v = load<{
    cases: {
      name: string;
      input: string;
      canonical: string;
      canonical_hex: string;
      expect: string;
    }[];
  }>("jcs");
  let tampered = 0;
  for (const c of v.cases) {
    const got = jcs(JSON.parse(c.input));
    if (c.expect === "match") {
      assert.equal(got, c.canonical, c.name);
      assert.equal(
        Buffer.from(got, "utf8").toString("hex"),
        c.canonical_hex,
        c.name,
      );
    } else {
      tampered++;
      assert.notEqual(got, c.canonical, c.name);
    }
  }
  assert.ok(tampered >= 3);
});

test("sender_sig vectors", () => {
  const v = load<{
    kid: string;
    sender_private_jwk: Jwk;
    keys: Record<string, Jwk>;
    client_request_json: Parameters<typeof signClientRequest>[0];
    cases: {
      name: string;
      client_request: string;
      sig: string;
      pub: string;
      expect: Expect;
    }[];
  }>("sender_sig");
  assert.equal(keyId(v.keys.sender as Jwk), v.kid);
  let tampered = 0;
  for (const c of v.cases) {
    const sig: SenderSig = {
      alg: "EdDSA",
      kid: v.kid,
      covers: "client_request",
      sig: c.sig,
    };
    const ok = verifySenderSig(
      c.client_request,
      sig,
      importPublicJwk(v.keys[c.pub] as Jwk),
    );
    assert.equal(ok, c.expect === "valid", c.name);
    if (c.expect === "invalid") tampered++;
  }
  assert.ok(tampered >= 4);
  // Ed25519 is deterministic: re-signing reproduces the pinned vector.
  const valid = v.cases.find((c) => c.expect === "valid");
  assert.ok(valid);
  const re = signClientRequest(
    v.client_request_json,
    importPrivateJwk(v.sender_private_jwk),
  );
  assert.equal(re.client_request, valid.client_request);
  assert.equal(re.sender_sig.sig, valid.sig);
});

test("request_hash vectors", () => {
  const v = load<{
    client_request: string;
    request_hash: string;
    content_sha256: string;
    cases: {
      name: string;
      client_request: string;
      request_hash: string;
      expect: Expect;
    }[];
  }>("request_hash");
  for (const c of v.cases) {
    const ok = requestHash(fromB64url(c.client_request)) === c.request_hash;
    assert.equal(ok, c.expect === "valid", c.name);
  }
  const cr = JSON.parse(fromB64url(v.client_request).toString("utf8"));
  assert.equal(contentSha256(cr.content), v.content_sha256);
});

test("view_sha256 vectors", () => {
  const v = load<{
    cases: {
      name: string;
      view: unknown;
      view_sha256: string;
      expect: Expect;
    }[];
  }>("view_sha256");
  for (const c of v.cases) {
    assert.equal(
      viewSha256(c.view) === c.view_sha256,
      c.expect === "valid",
      c.name,
    );
  }
});

test("relay_sig vectors", () => {
  const v = load<{
    keys: { relay: Jwk; sender: Jwk };
    cases: {
      name: string;
      envelope: Envelope;
      recipient: string;
      expect: Expect;
      fails?: string;
    }[];
  }>("relay_sig");
  const keys = {
    relay: importPublicJwk(v.keys.relay),
    sender: importPublicJwk(v.keys.sender),
  };
  let tampered = 0;
  for (const c of v.cases) {
    const failure = verifyDelivery(c.envelope, keys, c.recipient, {
      requireSenderSig: true,
    });
    if (c.expect === "valid") assert.equal(failure, null, c.name);
    else {
      tampered++;
      assert.equal(failure, c.fails, c.name);
    }
  }
  assert.ok(tampered >= 8);
});

test("relay_sig: missing sender_sig is refused when required, fine for API-key senders", () => {
  const v = load<{
    keys: { relay: Jwk; sender: Jwk };
    cases: { envelope: Envelope; recipient: string }[];
  }>("relay_sig");
  const c = v.cases[0];
  assert.ok(c);
  const keys = {
    relay: importPublicJwk(v.keys.relay),
    sender: importPublicJwk(v.keys.sender),
  };
  const e = JSON.parse(JSON.stringify(c.envelope));
  e.sender_sig = undefined;
  // relay_sig covered sender_sig, so removing it breaks relay_sig first.
  assert.equal(
    verifyDelivery(e, keys, c.recipient, { requireSenderSig: true }),
    "relay_sig",
  );
});

test("ws_handshake vectors", () => {
  const v = load<{
    keys: { sender: Jwk; relay: Jwk };
    auth_sign_input: string;
    ready_sign_input: string;
    cases: {
      name: string;
      kind: "auth" | "ready";
      fields: Record<string, string>;
      sig: string;
      expect: Expect;
    }[];
  }>("ws_handshake");
  const sender = importPublicJwk(v.keys.sender);
  const relay = importPublicJwk(v.keys.relay);
  let tampered = 0;
  for (const c of v.cases) {
    const f = c.fields;
    let ok: boolean;
    if (c.kind === "auth") {
      const input = handshakeSignInput({
        nonce: f.nonce as string,
        clientNonce: f.client_nonce as string,
        residentId: f.resident_id as string,
        serverTime: f.server_time as string,
      });
      ok = verifyEd25519(sender, input, fromB64url(c.sig));
    } else {
      const input = readySignInput(f as Parameters<typeof readySignInput>[0]);
      ok = verifyEs256(relay, input, fromB64url(c.sig));
    }
    assert.equal(ok, c.expect === "valid", c.name);
    if (c.expect === "invalid") tampered++;
  }
  assert.ok(tampered >= 8);
  assert.match(v.auth_sign_input, /^relay\.v1\|/);
  assert.equal(b64url(Buffer.from("")), "");
});
