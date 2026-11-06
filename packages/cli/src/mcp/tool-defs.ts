import {
  DESCRIPTIONS,
  describeTool,
  GUIDE_DESCRIPTIONS,
  RAW_DESCRIPTIONS,
  toolInputJson,
  YARD_DESCRIPTIONS,
} from "@hawl/protocol/src/tool-docs.ts";
import {
  type AnyToolName,
  GUIDE_TOOL_NAMES,
  TOOL_NAMES,
  YARD_TOOL_NAMES,
} from "@hawl/protocol/src/validate.ts";

export { DESCRIPTIONS, GUIDE_DESCRIPTIONS, toolInputJson, YARD_DESCRIPTIONS };

type Json = Record<string, unknown>;

/**
 * One schema error in plain words for the agent ("deadline must be a date and time like
 * 2026-10-20T17:00:00Z"), instead of the raw validator object with its schema paths.
 */
export function plainArgError(e: unknown): string {
  if (typeof e === "string") return e;
  const x = (e ?? {}) as {
    instancePath?: string;
    keyword?: string;
    message?: string;
    params?: Record<string, unknown>;
  };
  const field =
    (x.instancePath ?? "").replace(/^\//, "").replace(/\//g, ".") || "";
  const p = x.params ?? {};
  switch (x.keyword) {
    case "format":
      if (p.format === "date-time")
        return `${field || "value"} must be a date and time like 2026-10-20T17:00:00Z`;
      break;
    case "required":
      return field
        ? `${field} is missing ${String(p.missingProperty)}`
        : `${String(p.missingProperty)} is required`;
    case "additionalProperties":
      return `${field ? `${field}: ` : ""}unknown field ${String(p.additionalProperty)}`;
    case "alias":
      return x.message ?? "alias fields disagree";
    case "enum":
      return `${field || "value"} must be one of: ${(Array.isArray(p.allowedValues) ? p.allowedValues : []).join(", ")}`;
  }
  return `${field || "arguments"} ${x.message ?? "is not valid"}`;
}

/** Guide tools this helper lists and runs: all of them, sent to the relay like role_get. */
export const CLI_GUIDE_TOOL_NAMES = GUIDE_TOOL_NAMES;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Json;
  /** Listed only when the site has a yard. */
  gated: boolean;
}

/** Shared fields this helper does not use: its mailbox reads the local spool, so the relay's `ack` does nothing here. */
const HELPER_OMIT: Partial<Record<(typeof TOOL_NAMES)[number], string[]>> = {
  mailbox: ["ack"],
};

/** Every tool this build knows, for the shim's tools/list (the helper's `tools_list` op serves it). */
export function toolDefs(): ToolDef[] {
  return [
    ...TOOL_NAMES.map((name) => {
      const omit = HELPER_OMIT[name] ?? [];
      if (omit.length === 0)
        return {
          name,
          description: DESCRIPTIONS[name],
          inputSchema: toolInputJson(name),
          gated: false,
        };
      const inputSchema = toolInputJson(
        name,
        (s) => {
          for (const f of omit) delete (s.properties as Json)[f];
        },
        omit,
      );
      return {
        name,
        description: describeTool(RAW_DESCRIPTIONS[name], inputSchema, omit),
        inputSchema,
        gated: false,
      };
    }),
    ...CLI_GUIDE_TOOL_NAMES.map((name) => ({
      name,
      description: GUIDE_DESCRIPTIONS[name],
      inputSchema: toolInputJson(name),
      gated: false,
    })),
    ...YARD_TOOL_NAMES.map((name) => ({
      name,
      description: YARD_DESCRIPTIONS[name],
      inputSchema: toolInputJson(name),
      gated: name !== "ask_human",
    })),
  ];
}
