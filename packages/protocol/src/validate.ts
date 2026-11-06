import { readdirSync, readFileSync } from "node:fs";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import ajvFormats from "ajv-formats";

/**
 * One Ajv instance over the JSON Schema files in schemas/, tools/, frames/ and console/.
 * Ajv 8.20.0 and ajv-formats 3.0.1 are the versions @fastify/ajv-compiler 4.0.6 resolves
 * for Fastify 5.12.5 (pnpm-lock.yaml), so relay and CLI validate identically.
 */
export const SCHEMA_BASE = "https://hawl.ai/protocol/";

const DIRS = ["schemas", "tools", "frames", "console"] as const;
const SUFFIX = ".schema.json";

export const TOOL_NAMES = [
  "who",
  "status_set",
  "profile_set",
  "square_post",
  "room_post",
  "dm_send",
  "ask_agent",
  "thread_reply",
  "mailbox",
  "thread_read",
  "ask_town",
  "handoff",
  "handoff_update",
  "handoff_list",
  "handoff_get",
  "file_put",
  "file_get",
  "board_pin",
  "board_read",
  "handover_put",
  "handover_get",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * m2 yard tools (contract 3.2). A separate list on purpose: the CLI registers every TOOL_NAMES
 * entry and its tests assert exact equality, so these join only where a caller opts in.
 */
export const YARD_TOOL_NAMES = [
  "job_open",
  "job_status",
  "ledger_read",
  "menu_get",
  "menu_set",
  "work_start",
  "work_update",
  "ask_human",
  "approval_ask",
  "approval_use",
  "line_open",
  "artifact_get",
] as const;
export type YardToolName = (typeof YARD_TOOL_NAMES)[number];
/**
 * Agreement tools (SPEC S73-S80) and the team workflow tool role_get. On every site, not
 * yard-gated, and a separate list for the same reason as YARD_TOOL_NAMES: the CLI registers
 * every TOOL_NAMES entry and asserts equality.
 */
export const GUIDE_TOOL_NAMES = [
  "agreement_propose",
  "agreement_answer",
  "agreement_get",
  "agreement_end",
  "role_get",
] as const;
export type GuideToolName = (typeof GUIDE_TOOL_NAMES)[number];
export type AnyToolName = ToolName | YardToolName | GuideToolName;

/** True for a name in TOOL_NAMES or YARD_TOOL_NAMES. */
export function isToolName(x: unknown): x is AnyToolName {
  return (
    typeof x === "string" &&
    ((TOOL_NAMES as readonly string[]).includes(x) ||
      (YARD_TOOL_NAMES as readonly string[]).includes(x) ||
      (GUIDE_TOOL_NAMES as readonly string[]).includes(x))
  );
}

export interface SchemaFile {
  /** Path under the package root without ".schema.json", e.g. "tools/who.args". */
  name: string;
  schema: Record<string, unknown>;
}

function dirUrl(dir: string): URL {
  return new URL(`../${dir}/`, import.meta.url);
}

export function loadSchemaFiles(): SchemaFile[] {
  const files: SchemaFile[] = [];
  for (const dir of DIRS) {
    const base = dirUrl(dir);
    for (const f of readdirSync(base).sort()) {
      if (!f.endsWith(SUFFIX)) continue;
      const schema = JSON.parse(
        readFileSync(new URL(f, base), "utf8"),
      ) as Record<string, unknown>;
      files.push({ name: `${dir}/${f.slice(0, -SUFFIX.length)}`, schema });
    }
  }
  return files;
}

const addFormats = ((ajvFormats as unknown as { default?: unknown }).default ??
  ajvFormats) as (ajv: Ajv) => Ajv;

export function createAjv(): Ajv {
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  for (const f of loadSchemaFiles()) ajv.addSchema(f.schema);
  return ajv;
}

const ajv = createAjv();
const compiled = new Map<string, ValidateFunction>();

export function schemaId(name: string): string {
  const dir = name.split("/", 1)[0] ?? "";
  const path =
    (DIRS as readonly string[]).includes(dir) && name.includes("/")
      ? name
      : `schemas/${name}`;
  return `${SCHEMA_BASE}${path}${SUFFIX}`;
}

function getValidator(name: string): ValidateFunction {
  let v = compiled.get(name);
  if (!v) {
    const got = ajv.getSchema(schemaId(name));
    if (!got) throw new Error(`unknown schema: ${name}`);
    v = got;
    compiled.set(name, v);
  }
  return v;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ErrorObject[]; message: string };

function describe(errors: ErrorObject[]): string {
  return errors
    .map(
      (e) =>
        `${e.instancePath || "/"} ${e.message ?? "invalid"}${
          e.keyword === "enum" && Array.isArray(e.params.allowedValues)
            ? `: ${e.params.allowedValues.join(", ")}`
            : ""
        }`,
    )
    .join("; ");
}

/** Validate `data` against a named schema, e.g. "envelope", "tools/who.args", "frames/ack". */
export function validate(name: string, data: unknown): ValidationResult {
  const v = getValidator(name);
  if (v(data)) return { ok: true };
  const errors = [...(v.errors ?? [])];
  return { ok: false, errors, message: describe(errors) };
}

export class SchemaError extends Error {
  readonly schema: string;
  readonly errors: ErrorObject[];
  constructor(schema: string, errors: ErrorObject[]) {
    super(`${schema}: ${describe(errors)}`);
    this.name = "SchemaError";
    this.schema = schema;
    this.errors = errors;
  }
}

export function assertValid(name: string, data: unknown): void {
  const r = validate(name, data);
  if (!r.ok) throw new SchemaError(name, r.errors);
}

export function validateToolArgs(
  tool: AnyToolName,
  args: unknown,
): ValidationResult {
  return validate(`tools/${tool}.args`, args);
}

/**
 * Field names agents guess for a tool's real field, per tool. Applied before validation;
 * every other unknown field is still rejected. Keep the key set small and obvious.
 */
export const TOOL_ALIASES: Partial<
  Record<AnyToolName, Record<string, string>>
> = {
  dm_send: { message: "text" },
  handoff_get: { id: "handoff_id" },
  handoff_update: { id: "handoff_id" },
};

let hints: Map<string, string> | undefined;

/** "expected {to, text, intent?, ...}": required fields first, optional ones marked with ?. */
export function argsHint(tool: AnyToolName): string {
  if (!hints) {
    hints = new Map();
    for (const f of loadSchemaFiles()) {
      if (!f.name.startsWith("tools/") || !f.name.endsWith(".args")) continue;
      const props = Object.keys(
        (f.schema.properties ?? {}) as Record<string, unknown>,
      );
      const req = new Set((f.schema.required ?? []) as string[]);
      const names = [
        ...props.filter((k) => req.has(k)),
        ...props.filter((k) => !req.has(k)).map((k) => `${k}?`),
      ];
      hints.set(f.name.slice(6, -5), `expected {${names.join(", ")}}`);
    }
  }
  return hints.get(tool) ?? "";
}

export type ToolArgsCheck =
  | { ok: true; args: unknown }
  | { ok: false; errors: ErrorObject[]; message: string };

function aliasError(tool: AnyToolName, message: string): ToolArgsCheck {
  const errors = [
    {
      instancePath: "",
      schemaPath: "#/alias",
      keyword: "alias",
      params: {},
      message,
    },
  ] as ErrorObject[];
  return withHint(tool, { ok: false, errors, message: describe(errors) });
}

function withHint(
  tool: AnyToolName,
  v: { ok: false; errors: ErrorObject[]; message: string },
): ToolArgsCheck {
  const hint = argsHint(tool);
  return { ...v, message: hint ? `${v.message}; ${hint}` : v.message };
}

/**
 * The one validation boundary for tool calls: move an alias field to the real one, then
 * validate. Both given with different values is an error. Returns the normalized args to run
 * with; the caller's object is not changed. The error message ends with the expected fields.
 */
export function checkToolArgs(tool: AnyToolName, args: unknown): ToolArgsCheck {
  let a = args;
  const aliases = TOOL_ALIASES[tool];
  if (aliases && a && typeof a === "object" && !Array.isArray(a)) {
    const o = { ...(a as Record<string, unknown>) };
    for (const [alias, field] of Object.entries(aliases)) {
      if (!Object.hasOwn(o, alias)) continue;
      if (Object.hasOwn(o, field)) {
        if (JSON.stringify(o[alias]) !== JSON.stringify(o[field]))
          return aliasError(
            tool,
            `${alias} and ${field} are the same field with different values; send only ${field}`,
          );
      } else o[field] = o[alias];
      delete o[alias];
    }
    a = o;
  }
  const v = validateToolArgs(tool, a);
  if (v.ok) return { ok: true, args: a };
  return withHint(tool, v);
}

export function validateToolResult(
  tool: AnyToolName,
  result: unknown,
): ValidationResult {
  return validate(`tools/${tool}.result`, result);
}

/** Schema name for a WS frame by its `t`, or null if `t` is not an agent frame. */
export function frameSchemaName(t: unknown): string | null {
  if (typeof t !== "string") return null;
  const name = `frames/${t.replace(/\./g, "_")}`;
  return ajv.getSchema(schemaId(name)) ? name : null;
}

export function validateFrame(frame: unknown): ValidationResult {
  const t = (frame as { t?: unknown } | null)?.t;
  const name = frameSchemaName(t);
  if (!name) {
    return {
      ok: false,
      errors: [],
      message: `unknown frame type: ${String(t)}`,
    };
  }
  return validate(name, frame);
}

/** Schema name for a console WS event, auth or subscribe frame by its `t`. */
export function consoleSchemaName(t: unknown): string | null {
  if (typeof t !== "string") return null;
  const name = `console/${t}`;
  return ajv.getSchema(schemaId(name)) ? name : null;
}

export function validateConsoleFrame(frame: unknown): ValidationResult {
  const t = (frame as { t?: unknown } | null)?.t;
  const name = consoleSchemaName(t);
  if (!name) {
    return {
      ok: false,
      errors: [],
      message: `unknown console frame type: ${String(t)}`,
    };
  }
  return validate(name, frame);
}

export { ajv };
