/**
 * Minimal JSON Schema (draft-07 subset) checker. It covers exactly the keywords the
 * gateway-contract schemas use, so the reference gateway has no extra dependency.
 * Keywords: type, const, enum, required, properties, additionalProperties:false, items,
 * minItems, maxItems, uniqueItems, minLength, maxLength, minimum, maximum, pattern,
 * format (date-time), oneOf, $ref (#/definitions/...).
 */
export type Schema = Record<string, unknown>;

const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    default:
      return false;
  }
}

function resolve(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  let cur: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur !== "object" || cur === null) {
    throw new Error(`unresolved $ref ${ref}`);
  }
  return cur as Schema;
}

function check(
  root: Schema,
  s: Schema,
  v: unknown,
  path: string,
  errs: string[],
): void {
  if (typeof s.$ref === "string") {
    check(root, resolve(root, s.$ref), v, path, errs);
    return;
  }
  if ("const" in s && v !== s.const)
    errs.push(`${path}: must equal ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.includes(v))
    errs.push(`${path}: not in enum`);
  if (typeof s.type === "string" && !typeOk(s.type, v)) {
    errs.push(`${path}: expected ${s.type}`);
    return;
  }
  if (typeof v === "string") {
    if (typeof s.minLength === "number" && v.length < s.minLength)
      errs.push(`${path}: too short`);
    if (typeof s.maxLength === "number" && v.length > s.maxLength)
      errs.push(`${path}: too long`);
    if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(v))
      errs.push(`${path}: pattern`);
    if (
      s.format === "date-time" &&
      (!DATE_TIME.test(v) || Number.isNaN(Date.parse(v)))
    ) {
      errs.push(`${path}: not a date-time`);
    }
  }
  if (typeof v === "number") {
    if (typeof s.minimum === "number" && v < s.minimum)
      errs.push(`${path}: below minimum`);
    if (typeof s.maximum === "number" && v > s.maximum)
      errs.push(`${path}: above maximum`);
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && v.length < s.minItems)
      errs.push(`${path}: too few items`);
    if (typeof s.maxItems === "number" && v.length > s.maxItems)
      errs.push(`${path}: too many items`);
    if (
      s.uniqueItems === true &&
      new Set(v.map((x) => JSON.stringify(x))).size !== v.length
    ) {
      errs.push(`${path}: items not unique`);
    }
    if (s.items)
      v.forEach((x, i) =>
        check(root, s.items as Schema, x, `${path}[${i}]`, errs),
      );
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const r of (s.required ?? []) as string[]) {
      if (!(r in obj) || obj[r] === undefined)
        errs.push(`${path}.${r}: required`);
    }
    for (const [k, val] of Object.entries(obj)) {
      const sub = props[k];
      if (sub) check(root, sub, val, `${path}.${k}`, errs);
      else if (s.additionalProperties === false)
        errs.push(`${path}.${k}: not allowed`);
    }
  }
  if (Array.isArray(s.oneOf)) {
    const matches = (s.oneOf as Schema[]).filter((alt) => {
      const e: string[] = [];
      check(root, alt, v, path, e);
      return e.length === 0;
    }).length;
    if (matches !== 1)
      errs.push(`${path}: must match exactly one variant (matched ${matches})`);
  }
}

/** Returns a list of error strings; empty means valid. */
export function checkSchema(schema: Schema, value: unknown): string[] {
  const errs: string[] = [];
  check(schema, schema, value, "$", errs);
  return errs;
}
