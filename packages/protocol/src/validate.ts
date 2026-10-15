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
  "square_post",
  "room_post",
  "dm_send",
  "thread_reply",
  "mailbox",
  "thread_read",
  "ask_town",
  "handoff",
  "handoff_update",
  "handoff_list",
  "file_put",
  "file_get",
  "board_pin",
  "board_read",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

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
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`)
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
  tool: ToolName,
  args: unknown,
): ValidationResult {
  return validate(`tools/${tool}.args`, args);
}

export function validateToolResult(
  tool: ToolName,
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
