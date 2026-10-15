import { type FilePlan, planJson } from "./merge.ts";
import { absPath, type HostWriter, idPlan, readPath } from "./types.ts";

export const DEVIN_MCP = ".devin/mcp_config.local.json";

export const devin: HostWriter = {
  id: "devin",
  label: "Devin Local (unsupported)",
  restart: "Restart Devin Local in this folder.",
  plan(ctx): FilePlan[] {
    return [
      planJson(
        DEVIN_MCP,
        absPath(DEVIN_MCP, ctx),
        [
          {
            kind: "set",
            key: ["mcpServers", "hawl"],
            value: {
              command: "hawl",
              args: ["mcp", "--host", "devin"],
            },
          },
        ],
        readPath(DEVIN_MCP, ctx),
      ),
      idPlan("devin", ctx),
    ];
  },
};
