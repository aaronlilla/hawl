import { type FilePlan, type JsonOp, planJson } from "./merge.ts";
import {
  absPath,
  type HostCtx,
  type HostWriter,
  idPlan,
  otlpEndpoint,
  readPath,
} from "./types.ts";

export const CLAUDE_MCP = ".mcp.json";
export const CLAUDE_LOCAL = ".claude/settings.local.json";
/** Events the hook handles: notice on prompt/session start, activity lines on the rest. */
export const CLAUDE_HOOK_EVENTS = [
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "PreToolUse",
  "PostToolUse",
] as const;

export function claudeMcpEntry() {
  return {
    command: "hawl",
    args: ["mcp", "--host", "claude_code"],
  };
}

/** `scope: "user"` is the machine-level copy: the hook finds its folder itself. */
export function claudeHookGroup(event: string, scope?: "user") {
  const flag = scope ? ` --scope ${scope}` : "";
  return {
    hooks: [
      { type: "command", command: `hawl hook claude_code ${event}${flag}` },
    ],
  };
}

/** OTel env pointed at the daemon's loopback receiver; prompt logging off. */
export function claudeTelemetryEnv(
  ctx: Pick<HostCtx, "otlpPort">,
): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: otlpEndpoint(ctx),
    OTEL_LOG_USER_PROMPTS: "0",
  };
}

export const claudeCode: HostWriter = {
  id: "claude_code",
  label: "Claude Code",
  restart:
    "Restart Claude Code in this folder, then approve the hawl project server when it asks (once).",
  plan(ctx): FilePlan[] {
    const mcp: JsonOp[] = [
      {
        kind: "set",
        key: ["mcpServers", "hawl"],
        value: claudeMcpEntry(),
      },
    ];
    const hooks: JsonOp[] = CLAUDE_HOOK_EVENTS.map((e) => ({
      kind: "append",
      key: ["hooks", e],
      value: claudeHookGroup(e),
    }));
    const env: JsonOp[] = Object.entries(claudeTelemetryEnv(ctx)).map(
      ([k, v]) => ({ kind: "set", key: ["env", k], value: v }),
    );
    // Hooks and env both go in the project-local file; nothing is written under home.
    return [
      planJson(
        CLAUDE_MCP,
        absPath(CLAUDE_MCP, ctx),
        mcp,
        readPath(CLAUDE_MCP, ctx),
      ),
      planJson(
        CLAUDE_LOCAL,
        absPath(CLAUDE_LOCAL, ctx),
        [...hooks, ...env],
        readPath(CLAUDE_LOCAL, ctx),
      ),
      idPlan("claude_code", ctx),
    ];
  },
};
