import type { Link } from "./tool-call.ts";

/** What `hawl wait` and `GET /v1/wait` answer: counts, plus whether mail woke it. */
export interface WaitResult {
  woke: boolean;
  timeout?: true;
  unread: number;
  needs_action: number;
  aimed: number;
}

const num = (x: unknown) => (typeof x === "number" ? x : 0);

/**
 * Block until the worker has unread mail in its local spool, or `timeoutS` passes. The spool is
 * what the `mailbox` tool reads, so a wake means `mailbox` has something (the relay's own unread
 * count can run ahead of it). Counts come from the `notice` op the wake channel uses
 * (mcp/channel.ts). Mail already waiting wakes it at once.
 */
export async function waitForMail(
  link: Link,
  residentId: string,
  timeoutS: number,
  o: { pollMs?: number; stopped?: () => boolean } = {},
): Promise<WaitResult> {
  const until = Date.now() + timeoutS * 1000;
  for (;;) {
    const box = (await link.call("mailbox", {
      resident_id: residentId,
      unread_only: true,
    })) as { envelopes?: unknown[] };
    const n = (await link.call("notice", {
      resident_id: residentId,
    })) as Record<string, unknown>;
    const spooled = box.envelopes?.length ?? 0;
    const r = {
      unread: Math.max(spooled, num(n.unread)),
      needs_action: num(n.needs_action),
      aimed: num(n.aimed),
    };
    if (spooled > 0) return { woke: true, ...r };
    if (Date.now() >= until || o.stopped?.())
      return { woke: false, timeout: true, ...r };
    await new Promise((res) => setTimeout(res, o.pollMs ?? 1000));
  }
}
