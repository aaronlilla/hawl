import { join } from "node:path";
import { idFilePath, idFileText } from "../project-id.ts";
import { type FilePlan, planNewFile, readIfExists } from "./merge.ts";

export type HostId =
  | "claude_code"
  | "codex"
  | "cursor"
  | "devin"
  | "gemini"
  | "other";

export interface HostCtx {
  projectDir: string;
  /** Home directory, for `~/` user-scope files. */
  home: string;
  residentId: string;
  /** Daemon OTLP receiver port on 127.0.0.1 (spec 16 §3.9). */
  otlpPort: number;
}

export interface HostWriter {
  id: HostId;
  label: string;
  /** Printed after a successful join. */
  restart: string;
  plan(ctx: HostCtx): FilePlan[];
}

/** Resolve a recorded path: relative to the folder, or `~/...` under home. */
export function absPath(
  path: string,
  ctx: { projectDir: string; home: string },
): string {
  return path.startsWith("~/")
    ? join(ctx.home, path.slice(2))
    : join(ctx.projectDir, path);
}

export function readPath(path: string, ctx: HostCtx): string | null {
  return readIfExists(absPath(path, ctx));
}

export const otlpEndpoint = (ctx: Pick<HostCtx, "otlpPort">) =>
  `http://127.0.0.1:${ctx.otlpPort}`;

/** `.hawl/<tool>.json`: this folder's id for the tool. Kept out of the shared MCP config. */
export function idPlan(tool: HostId, ctx: HostCtx): FilePlan {
  const path = idFilePath(tool);
  return planNewFile(
    path,
    absPath(path, ctx),
    idFileText(ctx.residentId),
    readPath(path, ctx),
  );
}
