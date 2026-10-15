import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { fromB64url, sha256 } from "./hash.ts";
import { base32Crockford } from "./ids.ts";
import { jcs } from "./jcs.ts";

export type Jwk = Record<string, string>;
export type SigAlg = "EdDSA" | "ES256";

export function importPrivateJwk(jwk: Jwk): KeyObject {
  return createPrivateKey({ key: jwk, format: "jwk" });
}

export function importPublicJwk(jwk: Jwk): KeyObject {
  return createPublicKey({ key: jwk, format: "jwk" });
}

/** Ed25519 signature over `data`. Deterministic. Returns raw 64 bytes. */
export function signEd25519(privateKey: KeyObject, data: Uint8Array): Buffer {
  return nodeSign(null, data, privateKey);
}

/** Never throws on a bad key or signature; returns false. */
export function verifyEd25519(
  publicKey: KeyObject,
  data: Uint8Array,
  sig: Uint8Array,
): boolean {
  if (sig.length !== 64) return false;
  try {
    return nodeVerify(null, data, publicKey, sig);
  } catch {
    return false;
  }
}

/** ES256 (ECDSA P-256 + SHA-256), JWS format: raw r||s, 64 bytes (ieee-p1363). */
export function signEs256(privateKey: KeyObject, data: Uint8Array): Buffer {
  return nodeSign("sha256", data, {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
}

export function verifyEs256(
  publicKey: KeyObject,
  data: Uint8Array,
  sig: Uint8Array,
): boolean {
  if (sig.length !== 64) return false;
  try {
    return nodeVerify(
      "sha256",
      data,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      sig,
    );
  } catch {
    return false;
  }
}

export function verifyDetached(
  alg: SigAlg,
  publicKey: KeyObject,
  data: Uint8Array,
  sigB64url: string,
): boolean {
  let sig: Buffer;
  try {
    sig = fromB64url(sigB64url);
  } catch {
    return false;
  }
  if (alg === "EdDSA") return verifyEd25519(publicKey, data, sig);
  if (alg === "ES256") return verifyEs256(publicKey, data, sig);
  return false;
}

/** RFC 7638 JWK thumbprint (SHA-256) over the required members, JCS-ordered. */
export function jwkThumbprint(jwk: Jwk): Buffer {
  let members: Record<string, string | undefined>;
  if (jwk.kty === "OKP") members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  else if (jwk.kty === "EC")
    members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  else throw new TypeError(`unsupported kty ${jwk.kty}`);
  return sha256(jcs(members));
}

/** `key_` id: `key_` + base32(first 16 bytes of the RFC 7638 thumbprint). */
export function keyId(jwk: Jwk): string {
  return `key_${base32Crockford(jwkThumbprint(jwk).subarray(0, 16))}`;
}

/** Signed payload of the WS handshake `auth` frame (04 §5.2). */
export function handshakeSignInput(p: {
  nonce: string;
  clientNonce: string;
  residentId: string;
  serverTime: string;
}): Buffer {
  return Buffer.from(
    `relay.v1|${p.nonce}|${p.clientNonce}|${p.residentId}|${p.serverTime}`,
    "utf8",
  );
}

/** Signed payload of the WS handshake `ready.relay_sig` (04 §5.2): JCS of the transcript. */
export function readySignInput(p: {
  nonce: string;
  client_nonce: string;
  resident_id: string;
  session_id: string;
  server_time: string;
}): Buffer {
  return Buffer.from(
    jcs({
      nonce: p.nonce,
      client_nonce: p.client_nonce,
      resident_id: p.resident_id,
      session_id: p.session_id,
      server_time: p.server_time,
    }),
    "utf8",
  );
}
