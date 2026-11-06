/**
 * file_from_pc owner approval: the exact request an owner's passkey signs. The WebAuthn challenge
 * is SHA-256 of the UTF-8 bytes of `pcApprovalText(fields)`. The web computes it from the fields it
 * shows the owner; the helper recomputes it from the fields it was asked to read, so a signature
 * for any other request, helper, file or recipient does not verify. No imports: runs in the
 * browser too.
 */
export type PcApprovalFields = {
  /** pcf_ wire id of the request. */
  request_id: string;
  /** res_ wire id of the helper (the PC's agent) that reads the file. */
  helper_id: string;
  path: string;
  bytes: number;
  mtime_ms: number;
  ino: string;
  /** res_ wire id of the recipient. */
  to_id: string;
  /** Unix ms after which the approval is void. */
  exp: number;
};

/** Longest an owner's signed approval may live. */
export const PC_APPROVAL_TTL_MS = 10 * 60_000;

export function pcApprovalText(f: PcApprovalFields): string {
  return JSON.stringify([
    "hawl.send_file.v1",
    f.request_id,
    f.helper_id,
    f.path,
    f.bytes,
    f.mtime_ms,
    f.ino,
    f.to_id,
    f.exp,
  ]);
}

/** What the browser hands the relay and the relay forwards to the helper unchanged. All base64url. */
export type PcApprovalAssertion = {
  credential_id: string;
  client_data_json: string;
  authenticator_data: string;
  signature: string;
  exp: number;
};
