import { type FilePlan, planJson, planNewFile } from "./merge.ts";
import { absPath, type HostWriter, idPlan, readPath } from "./types.ts";

export const CURSOR_MCP = ".cursor/mcp.json";
export const CURSOR_RULES = ".cursor/rules/hawl.mdc";

export const CURSOR_RULE_TEXT = [
  "---",
  "description: Check the hawl mailbox",
  "alwaysApply: true",
  "---",
  "",
  "Check your mailbox at the start of each task.",
  "",
].join("\n");

export const cursor: HostWriter = {
  id: "cursor",
  label: "Cursor (unsupported)",
  restart:
    "Now restart Cursor in this folder: close the window and open the folder again, then turn on the hawl MCP server in its settings.",
  plan(ctx): FilePlan[] {
    return [
      planJson(
        CURSOR_MCP,
        absPath(CURSOR_MCP, ctx),
        [
          {
            kind: "set",
            key: ["mcpServers", "hawl"],
            value: {
              command: "hawl",
              args: ["mcp", "--host", "cursor"],
            },
          },
        ],
        readPath(CURSOR_MCP, ctx),
      ),
      planNewFile(
        CURSOR_RULES,
        absPath(CURSOR_RULES, ctx),
        CURSOR_RULE_TEXT,
        readPath(CURSOR_RULES, ctx),
      ),
      idPlan("cursor", ctx),
    ];
  },
};
