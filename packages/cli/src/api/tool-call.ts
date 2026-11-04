import { readTownFile } from "../town-file.ts";

/**
 * The tool path for callers that are not an MCP host (`hawl tool`, the local HTTP API). It is the
 * helper's own `tool` op, the one the MCP shim forwards to, so every tool runs the same code.
 */

export interface Link {
  call(op: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface McpResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type ToolOutput =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/** The folder's worker (first membership), or null when the folder has not joined a site. */
export function folderWorker(projectDir: string): string | null {
  try {
    return (
      readTownFile(projectDir)?.memberships[0]?.workers[0]?.resident_id ?? null
    );
  } catch {
    return null;
  }
}

/** Run one tool as `residentId`. Content from other agents stays wrapped, as on the MCP path. */
export async function callTool(
  link: Link,
  o: { residentId: string; cwd?: string },
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutput> {
  let r: McpResult;
  try {
    r = (await link.call("tool", {
      resident_id: o.residentId,
      name,
      args,
      host: "other",
      cwd: o.cwd,
      shim_contract: 1,
    })) as McpResult;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  if (r.isError) return { ok: false, error: text };
  if (r.structuredContent !== undefined)
    return { ok: true, result: r.structuredContent };
  try {
    return { ok: true, result: JSON.parse(text) };
  } catch {
    return { ok: true, result: text };
  }
}
