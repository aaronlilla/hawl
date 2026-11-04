import { type FilePlan, planJson } from "./merge.ts";
import {
  absPath,
  type HostCtx,
  type HostWriter,
  otlpEndpoint,
  readPath,
} from "./types.ts";

export const GEMINI_SETTINGS = ".gemini/settings.json";

/** Telemetry only: Gemini CLI is not a mailbox host. Keys per geminicli.com/docs/cli/telemetry. */
export function geminiTelemetry(ctx: Pick<HostCtx, "otlpPort">) {
  return {
    enabled: true,
    target: "local",
    otlpEndpoint: otlpEndpoint(ctx),
    otlpProtocol: "http",
    logPrompts: false,
  };
}

export const gemini: HostWriter = {
  id: "gemini",
  label: "Gemini CLI (activity only)",
  restart:
    "Now restart Gemini CLI in this folder: close it and run `gemini` again.",
  plan(ctx): FilePlan[] {
    return [
      planJson(
        GEMINI_SETTINGS,
        absPath(GEMINI_SETTINGS, ctx),
        [{ kind: "set", key: ["telemetry"], value: geminiTelemetry(ctx) }],
        readPath(GEMINI_SETTINGS, ctx),
      ),
    ];
  },
};
