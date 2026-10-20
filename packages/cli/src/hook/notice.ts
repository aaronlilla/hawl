/**
 * The fixed notice (spec 16 §3.5, decisions #6). Only the relay's integer `unread` ever reaches
 * the template. Anything else, including a sender, a subject or `meta`, has no path in.
 * `SessionStart` prints the longer fixed brief instead (../brief.ts): same rule, plus local
 * town-file values that pass strict patterns.
 */
export function formatNotice(unread: unknown): string {
  if (typeof unread !== "number" || !Number.isSafeInteger(unread) || unread < 1)
    return "";
  return `\u{1F4EC} Hawl: ${unread} waiting. Call the mailbox tool.`;
}

export type HookHost = "claude_code" | "codex";

/** Claude Code `additionalContext` form (UserPromptSubmit, SessionStart). Empty for no notice. */
export function claudeContextOutput(event: string, notice: string): string {
  if (!notice) return "";
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: notice },
  });
}

/** `Stop` continuation form, both hosts. Empty for no notice. */
export function stopOutput(notice: string): string {
  if (!notice) return "";
  return JSON.stringify({ decision: "block", reason: notice });
}
