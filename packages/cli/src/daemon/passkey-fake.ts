import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  type PcApprovalAssertion,
  type PcApprovalFields,
  pcApprovalText,
} from "@hawl/protocol/src/pc-approval.ts";

/**
 * Test support: a software passkey (P-256, like a platform authenticator) that makes real
 * WebAuthn assertions, so tests check signatures for real instead of stubbing the verifier.
 */
export function fakePasskey(id = "cred-1") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const xy = (s?: string) => Buffer.from(String(s), "base64url");
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y} in CBOR.
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    xy(jwk.x),
    Buffer.from([0x22, 0x58, 0x20]),
    xy(jwk.y),
  ]).toString("base64");
  const credential_id = Buffer.from(id).toString("base64url");
  let counter = 0;
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();
  return {
    credential_id,
    cose,
    /** For a browser's virtual authenticator (CDP WebAuthn.addCredential): standard base64. */
    cdp: {
      credentialId: Buffer.from(id).toString("base64"),
      privateKey: privateKey
        .export({ type: "pkcs8", format: "der" })
        .toString("base64"),
    },
    /** Sign `fields` as the browser would on `origin`. `counter: false` keeps the counter at 0. */
    approve(
      fields: PcApprovalFields,
      o: { origin: string; counter?: boolean; flags?: number },
    ): PcApprovalAssertion {
      const cd = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: sha(pcApprovalText(fields)).toString("base64url"),
          origin: o.origin,
          crossOrigin: false,
        }),
      );
      const n = Buffer.alloc(4);
      n.writeUInt32BE(o.counter === false ? 0 : ++counter);
      const auth = Buffer.concat([
        sha(new URL(o.origin).hostname),
        Buffer.from([o.flags ?? 0x05]),
        n,
      ]);
      const sig = sign("sha256", Buffer.concat([auth, sha(cd)]), privateKey);
      return {
        credential_id,
        client_data_json: cd.toString("base64url"),
        authenticator_data: auth.toString("base64url"),
        signature: sig.toString("base64url"),
        exp: fields.exp,
      };
    },
  };
}
