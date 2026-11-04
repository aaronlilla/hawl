import { join } from "node:path";
import { WAKE_HOOK_TIMEOUT_S } from "../hook/wake-wait.ts";
import { readTownFile, writeTownFile } from "../town-file.ts";
import {
  applyPlan,
  type FilePlan,
  type JsonOp,
  planJson,
  readIfExists,
  sha256,
} from "./merge.ts";
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
/**
 * Events the hook handles: notice on prompt/session start, a mid-task notice on PostToolUse
 * when new mail arrived, a bounded continue on Stop while mail waits, activity lines on all.
 */
export const CLAUDE_HOOK_EVENTS = [
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "PreToolUse",
  "PostToolUse",
  "Stop",
] as const;

/**
 * Events that also start the background waiter (`hawl hook claude_code Wake`, hook/wake-wait.ts):
 * an `asyncRewake` hook that wakes an idle session when aimed mail lands. Plain `claude` gets
 * idle wake this way, with no flag (code.claude.com/docs/en/hooks, "Run hooks in the background").
 */
export const CLAUDE_WAKE_EVENTS = ["SessionStart", "Stop"] as const;

/** The waiter's hook group. `timeout` bounds it: Claude Code enforces it on `asyncRewake`. */
export function claudeWakeGroup(scope?: "user") {
  const flag = scope ? ` --scope ${scope}` : "";
  return {
    hooks: [
      {
        type: "command",
        command: `hawl hook claude_code Wake${flag}`,
        asyncRewake: true,
        timeout: WAKE_HOOK_TIMEOUT_S,
      },
    ],
  };
}

/** Append ops for the hook groups and the waiter, for one settings file. */
export function claudeHookOps(scope?: "user"): JsonOp[] {
  return [
    ...CLAUDE_HOOK_EVENTS.map(
      (e): JsonOp => ({
        kind: "append",
        key: ["hooks", e],
        value: claudeHookGroup(e, scope),
      }),
    ),
    ...CLAUDE_WAKE_EVENTS.map(
      (e): JsonOp => ({
        kind: "append",
        key: ["hooks", e],
        value: claudeWakeGroup(scope),
      }),
    ),
  ];
}

/**
 * Also: start Claude Code so Hawl can wake an idle session over Channels (research preview). Hawl is
 * not on Anthropic's channel allowlist, so the server is named in the development flag; plain
 * `--channels server:hawl` would not register it (code.claude.com/docs/en/channels). Interactive
 * only: `-p` and the Agent SDK ignore the flag.
 */
export const CLAUDE_WAKE_COMMAND =
  "claude --dangerously-load-development-channels server:hawl";
/** The same for the Hawl plugin (marketplace `hawl`, plugin `hawl`). */
export const CLAUDE_WAKE_COMMAND_PLUGIN =
  "claude --dangerously-load-development-channels plugin:hawl@hawl";

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
    "Now restart Claude Code in this folder: close it and run `claude` again. Messages for this agent then wake it even while it sits idle.",
  plan(ctx): FilePlan[] {
    const mcp: JsonOp[] = [
      {
        kind: "set",
        key: ["mcpServers", "hawl"],
        value: claudeMcpEntry(),
      },
    ];
    const hooks = claudeHookOps();
    // Pre-approves our own .mcp.json server, so plain `claude` does not stop on "New MCP server
    // found" (its default is to continue without). Claude Code reads this from the untracked
    // local file once the folder is trusted; a person's disabledMcpjsonServers still wins
    // (code.claude.com/docs/en/mcp, "Project server approvals and workspace trust").
    const approve: JsonOp = {
      kind: "append",
      key: ["enabledMcpjsonServers"],
      value: "hawl",
    };
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
        [...hooks, approve, ...env],
        readPath(CLAUDE_LOCAL, ctx),
      ),
      idPlan("claude_code", ctx),
    ];
  },
};

const WAKE_CMD = "hawl hook claude_code Wake";

/** Append ops for the waiter only (folders and machines set up before it existed). */
export function claudeWakeOps(scope?: "user"): JsonOp[] {
  return CLAUDE_WAKE_EVENTS.map((e) => ({
    kind: "append",
    key: ["hooks", e],
    value: claudeWakeGroup(scope),
  }));
}

/**
 * A settings file that has our hooks but not the waiter gets the waiter, so folders joined
 * before it existed wake too. Returns the plan written, or null. Claude Code picks up the change
 * in the open session. `hawl config wake off` turns the wake itself off; the entry stays.
 */
export function planWakeUpgrade(
  path: string,
  abs: string,
  scope?: "user",
): FilePlan | null {
  const before = readIfExists(abs);
  if (before === null) return null;
  const stopCmd = `hawl hook claude_code Stop${scope ? ` --scope ${scope}` : ""}`;
  if (!before.includes(stopCmd) || before.includes(WAKE_CMD)) return null;
  const plan = planJson(path, abs, claudeWakeOps(scope), before);
  return plan.changed && plan.skipped.length === 0 ? plan : null;
}

/** The folder half of the upgrade: write, then record the entries for `hawl leave`. */
export function upgradeFolderWake(
  root: string,
  residentId: string,
  stateDir: string,
): boolean {
  const plan = planWakeUpgrade(CLAUDE_LOCAL, join(root, CLAUDE_LOCAL));
  if (!plan) return false;
  const town = readTownFile(root);
  if (!town) return false;
  applyPlan(plan, { projectDir: root, stateDir });
  for (const e of plan.entries) {
    if (
      !town.written.some(
        (w) =>
          w.resident_id === residentId &&
          w.path === e.path &&
          w.key === e.key &&
          w.sha256 === e.sha256,
      )
    )
      town.written.push({ ...e, resident_id: residentId });
  }
  // The file is still ours: its restore point moves to the new bytes.
  const was = sha256(plan.before ?? "");
  for (const r of town.restore)
    if (r.path === CLAUDE_LOCAL && r.after === was)
      r.after = sha256(plan.after);
  writeTownFile(root, town);
  return true;
}
