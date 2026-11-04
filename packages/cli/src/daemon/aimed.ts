import type { Envelope } from "@hawl/protocol/src/envelope.ts";
import { fromB64url } from "@hawl/protocol/src/hash.ts";

/**
 * Is this mail aimed at the worker, as opposed to a site or room broadcast it merely received?
 * Aimed: sent straight to the worker (direct messages, ask_agent questions, handoffs and their
 * updates), a reply, or a room post that names it. A room post that does not name it is a
 * broadcast. Reads the sender-signed request already in the spool; nothing leaves the machine.
 */
export function isAimed(env: Envelope, residentId: string): boolean {
  if (env.relay.handoff || env.relay.effective_intent === "reply") return true;
  try {
    const cr = JSON.parse(fromB64url(env.client_request).toString("utf8")) as {
      to?: { kind?: string; resident_id?: string; mentions?: unknown };
    };
    if (cr.to?.kind === "worker") return true;
    return (
      cr.to?.kind === "channel" &&
      Array.isArray(cr.to.mentions) &&
      cr.to.mentions.includes(residentId)
    );
  } catch {
    return false;
  }
}

export function countAimed(envs: Envelope[], residentId: string): number {
  return envs.filter((e) => isAimed(e, residentId)).length;
}
