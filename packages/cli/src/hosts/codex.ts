import { type FilePlan, planToml, type TomlBlock } from "./merge.ts";
import {
  absPath,
  type HostCtx,
  type HostWriter,
  idPlan,
  readPath,
} from "./types.ts";

export const CODEX_CONFIG = ".codex/config.toml";

/** Codex activity comes from hooks (Codex ignores `[otel]` in project config). */
export const CODEX_HOOK_EVENTS = [
  "UserPromptSubmit",
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
] as const;

export function hookBlock(event: string, scope?: "user"): TomlBlock {
  const flag = scope ? ` --scope ${scope}` : "";
  return {
    key: `hooks.${event}`,
    table: ["hooks", event],
    array: true,
    text: [
      `[[hooks.${event}]]`,
      "",
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      `command = "hawl hook codex ${event}${flag}"`,
    ].join("\n"),
  };
}

export function codexBlocks(
  _ctx?: Pick<HostCtx, "otlpPort">,
  scope?: "user",
): TomlBlock[] {
  return [
    {
      key: "mcp_servers.hawl",
      table: ["mcp_servers", "hawl"],
      text: [
        "[mcp_servers.hawl]",
        'command = "hawl"',
        'args = ["mcp", "--host", "codex"]',
      ].join("\n"),
    },
    ...CODEX_HOOK_EVENTS.map((e) => hookBlock(e, scope)),
  ];
}

export const codex: HostWriter = {
  id: "codex",
  label: "Codex CLI",
  restart:
    "Trust this folder in Codex, approve the hawl hook in /hooks, then restart Codex here.",
  plan(ctx): FilePlan[] {
    return [
      planToml(
        CODEX_CONFIG,
        absPath(CODEX_CONFIG, ctx),
        codexBlocks(ctx),
        readPath(CODEX_CONFIG, ctx),
      ),
      idPlan("codex", ctx),
    ];
  },
};
