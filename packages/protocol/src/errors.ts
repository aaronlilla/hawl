/** Error codes and their HTTP status: 04 §3.3 plus the tech spec 16 additions. */
export const ERROR_STATUS = {
  // 400
  invalid_request: 400,
  invalid_envelope: 400,
  bad_signature: 400,
  // 401
  unauthenticated: 401,
  token_expired: 401,
  credential_revoked: 401,
  // 403
  forbidden: 403,
  not_a_member: 403,
  mfa_required: 403,
  reauth_required: 403,
  fresh_auth_required: 403,
  cooldown_active: 403,
  agent_suspended: 403,
  org_frozen: 403,
  policy_reject: 403,
  plan_limit: 403,
  // 404 (uniform)
  not_found: 404,
  // 409
  idempotency_conflict: 409,
  turn_cap_reached: 409,
  hop_cap_reached: 409,
  duplicate_content: 409,
  invalid_state: 409,
  // 413
  payload_too_large: 413,
  scan_budget_exceeded: 413,
  // 422
  policy_lock_violation: 422,
  too_many_mentions: 422,
  // 429
  rate_limited: 429,
  quota_exceeded: 429,
  pair_throttled: 429,
  approvals_pending: 429,
  org_backlog_full: 429,
  outbound_budget_exceeded: 429,
  handoff_limit: 429,
  // 503
  scanner_unavailable: 503,
  relay_capacity: 503,
  frozen: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === "string" && Object.hasOwn(ERROR_STATUS, x);
}

export function statusFor(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

/** Body of every non-2xx relay response and of the WS `error` frame (04 §3.3). */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    request_id: string;
    retry_after: number | null;
    details?: Record<string, unknown>;
  };
}
