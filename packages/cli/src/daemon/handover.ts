import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileDurable } from "./fsutil.ts";

/** The relay's acknowledgement of the last handover this helper stored for a worker. Never its text. */
export interface HandoverAck {
  handover_id: string;
  revision: number;
  stored_at: string;
}

const RESIDENT = /^res_[A-Za-z0-9_-]{1,64}$/;
const HOV =
  /^hov_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ackFile = (stateDir: string, rid: string) =>
  join(stateDir, "handover-acks", `${rid}.json`);

function valid(a: unknown): a is HandoverAck {
  const o = a as Partial<HandoverAck> | null;
  return (
    typeof o?.handover_id === "string" &&
    HOV.test(o.handover_id) &&
    Number.isSafeInteger(o.revision) &&
    (o.revision as number) >= 1
  );
}

/**
 * After a `handover_put` through the helper: keep the relay's own `stored` answer (id, revision,
 * time) for `hawl handover status`. Anything else (a refusal, another state, a bad shape) records
 * nothing and leaves the last acknowledgement as it was.
 */
export function recordAck(
  stateDir: string,
  rid: string,
  out: unknown,
  now = new Date(),
): HandoverAck | undefined {
  const o = out as { state?: unknown } | null;
  if (!RESIDENT.test(rid) || o?.state !== "stored" || !valid(o)) return;
  const ack: HandoverAck = {
    handover_id: o.handover_id,
    revision: o.revision,
    stored_at: now.toISOString(),
  };
  writeFileDurable(ackFile(stateDir, rid), JSON.stringify(ack));
  return ack;
}

/** The last recorded acknowledgement for a worker, or null. */
export function readAck(stateDir: string, rid: string): HandoverAck | null {
  if (!RESIDENT.test(rid)) return null;
  try {
    const a = JSON.parse(readFileSync(ackFile(stateDir, rid), "utf8"));
    return valid(a) && typeof a.stored_at === "string"
      ? {
          handover_id: a.handover_id,
          revision: a.revision,
          stored_at: a.stored_at,
        }
      : null;
  } catch {
    return null;
  }
}
