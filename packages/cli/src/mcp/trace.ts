import { randomBytes } from "node:crypto";
import type { DaemonLink } from "./server.ts";

/**
 * One trace id per tool call. The helper has no Sentry SDK: it takes the caller's W3C
 * `traceparent` from the MCP request `_meta` (converted to the `sentry-trace` shape the relay
 * continues), or mints a fresh id. Nothing is sent anywhere new; the id rides the daemon request,
 * the relay frame and the helper's own log line.
 */
export type Trace = { "sentry-trace": string };

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO = /^0+$/;

export function requestTrace(meta: unknown): Trace {
  const tp = (meta as { traceparent?: unknown } | null | undefined)
    ?.traceparent;
  const m = typeof tp === "string" ? TRACEPARENT.exec(tp) : null;
  if (m && !ZERO.test(m[1] as string) && !ZERO.test(m[2] as string))
    return { "sentry-trace": `${m[1]}-${m[2]}-${m[3] === "01" ? 1 : 0}` };
  return {
    "sentry-trace": `${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-1`,
  };
}

/** The ops whose request becomes a relay frame or call. */
const TRACED_OPS = new Set(["tool", "send", "send_tool"]);

export function tracedLink(daemon: DaemonLink, trace: Trace): DaemonLink {
  return {
    call: (op, args = {}) =>
      daemon.call(op, TRACED_OPS.has(op) ? { ...args, trace } : args),
  };
}
