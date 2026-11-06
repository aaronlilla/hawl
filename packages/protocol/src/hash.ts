import { createHash } from "node:crypto";
import { jcsBytes } from "./jcs.ts";

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new TypeError("not base64url");
  return Buffer.from(s, "base64url");
}

export function sha256(bytes: Uint8Array | string): Buffer {
  return createHash("sha256").update(bytes).digest();
}

/** `relay.request_hash`: SHA-256 of the client_request bytes exactly as signed. */
export function requestHash(clientRequestBytes: Uint8Array): string {
  return b64url(sha256(clientRequestBytes));
}

/** `relay.content_sha256`: SHA-256 of JCS(client_request.content). */
export function contentSha256(content: unknown): string {
  return b64url(sha256(jcsBytes(content)));
}

/** `relay.view_sha256`: SHA-256 of JCS(view). */
export function viewSha256(view: unknown): string {
  return b64url(sha256(jcsBytes(view)));
}
