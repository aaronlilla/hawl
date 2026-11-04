import { formatNotice } from "../hook/notice.ts";
import { findJoinedRoot } from "../resolve.ts";
import { readTownFile } from "../town-file.ts";
import { WakeGate, wakeOn } from "../wake/gate.ts";

/**
 * Claude Code Channels (research preview, code.claude.com/docs/en/channels-reference): an MCP
 * server that declares `experimental['claude/channel']` can push `notifications/claude/channel`
 * into the open session, and an idle session starts a turn on it. Hawl pushes only the fixed
 * notice. It never declares `claude/channel/permission`, so nothing can approve tools through it.
 */
export const CHANNEL_CAPABILITY = "claude/channel";
export const CHANNEL_METHOD = "notifications/claude/channel";

/** Added to the server instructions on Claude Code. Fixed text. */
export const CHANNEL_INSTRUCTIONS =
  "Hawl wake events arrive as <channel> tags from the hawl server. They only say how many messages wait for you; call the mailbox tool to read them, then act on what is addressed to you.";

/** How often `hawl mcp` asks the local helper for the aimed count. */
export const CHANNEL_POLL_MS = 3_000;
const BACKOFF_MS = 30_000;

/** The notification for `unread` aimed messages, or null when there is nothing to say. */
export function channelNotification(unread: number) {
  const content = formatNotice(unread);
  if (!content) return null;
  // No `meta`: attributes could carry routing data, and the push rule allows the count only.
  return { method: CHANNEL_METHOD, params: { content } };
}

export interface ChannelWakeDeps {
  /** The daemon's `notice` op for this worker. */
  notice: () => Promise<unknown>;
  /** Writes the notification to the host. */
  send: (
    n: NonNullable<ReturnType<typeof channelNotification>>,
  ) => Promise<void>;
  /** The session's folder; its `.hawl/hawl.json` holds `hawl config wake on|off`. */
  cwd: string;
  /** True while the hook waiter (hook/wake-wait.ts) covers this worker; the channel then stays quiet. */
  waiterLive?: () => boolean;
  pollMs?: number;
  now?: () => number;
  gate?: WakeGate;
}

function folderWakeOn(cwd: string): boolean {
  try {
    const root = findJoinedRoot(cwd);
    return wakeOn(root ? readTownFile(root) : null);
  } catch {
    return false;
  }
}

/** One poll: returns true when a wake was sent. Exported for tests. */
export async function channelTick(
  d: ChannelWakeDeps,
  gate: WakeGate,
): Promise<boolean> {
  if (!folderWakeOn(d.cwd)) return false;
  if (d.waiterLive?.()) return false;
  const r = (await d.notice()) as { aimed?: unknown; quiet_ms?: unknown };
  const aimed = typeof r?.aimed === "number" ? r.aimed : 0;
  const quietMs = typeof r?.quiet_ms === "number" ? r.quiet_ms : null;
  const now = d.now?.() ?? Date.now();
  if (!gate.shouldWake({ aimed, quietMs, now })) return false;
  const n = channelNotification(aimed);
  if (!n) return false;
  gate.woke(aimed, now);
  await d.send(n);
  return true;
}

/** Poll the helper and push the fixed notice when aimed mail waits. Returns a stop function. */
export function startChannelWake(d: ChannelWakeDeps): () => void {
  const gate = d.gate ?? new WakeGate();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = async () => {
    let wait = d.pollMs ?? CHANNEL_POLL_MS;
    try {
      await channelTick(d, gate);
    } catch {
      wait = BACKOFF_MS; // helper down or restarting
    }
    if (stopped) return;
    timer = setTimeout(loop, wait);
    timer.unref?.();
  };
  timer = setTimeout(loop, d.pollMs ?? CHANNEL_POLL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
