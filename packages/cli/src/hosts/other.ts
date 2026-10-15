import type { FilePlan } from "./merge.ts";
import { type HostWriter, idPlan } from "./types.ts";

/** What a person pastes into any MCP tool hawl has no writer for. */
export const OTHER_SNIPPET =
  '{"mcpServers":{"hawl":{"command":"hawl","args":["mcp","--host","other"]}}}';

export const OTHER_NOTE =
  "This tool has no mail notice. It reads mail only when you ask it to call the mailbox tool.";

/** `--host other`: writes only `.hawl/other.json`; the person pastes the snippet. */
export const other: HostWriter = {
  id: "other",
  label: "a custom MCP tool",
  restart:
    "Paste the snippet above into your tool's MCP settings, then restart it.",
  plan(ctx): FilePlan[] {
    return [idPlan("other", ctx)];
  },
};
