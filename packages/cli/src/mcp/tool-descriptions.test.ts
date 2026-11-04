import assert from "node:assert/strict";
import { test } from "node:test";
import { examplesIn } from "@hawl/protocol/src/tool-docs.ts";
import {
  checkToolArgs,
  createAjv,
  GUIDE_TOOL_NAMES,
  TOOL_NAMES,
  YARD_TOOL_NAMES,
} from "@hawl/protocol/src/validate.ts";
import { toolDefs } from "./tool-defs.ts";

type Json = Record<string, unknown>;

/** Every property under a schema (objects, array items, oneOf/anyOf branches) with its path. */
function* props(node: unknown, path: string): Generator<[string, Json]> {
  if (!node || typeof node !== "object") return;
  const n = node as Json;
  for (const [k, v] of Object.entries((n.properties ?? {}) as Json)) {
    yield [`${path}${k}`, v as Json];
    yield* props(v, `${path}${k}.`);
  }
  yield* props(n.items, `${path}[].`);
  for (const key of ["oneOf", "anyOf", "allOf"])
    for (const b of (n[key] ?? []) as unknown[]) yield* props(b, path);
}

const defs = toolDefs();

test("the helper lists every tool the protocol knows, agreement tools included", () => {
  assert.deepEqual(
    defs.map((d) => d.name).sort(),
    [...TOOL_NAMES, ...GUIDE_TOOL_NAMES, ...YARD_TOOL_NAMES].sort(),
  );
  for (const n of [
    "agreement_propose",
    "agreement_answer",
    "agreement_get",
    "agreement_end",
  ])
    assert.ok(
      defs.some((d) => d.name === n && !d.gated),
      n,
    );
});

test("every tool has a description that names its required fields", () => {
  const missing: string[] = [];
  for (const d of defs) {
    assert.ok(d.description.length > 20, `${d.name} has no description`);
    for (const f of (d.inputSchema.required ?? []) as string[])
      if (!d.description.includes(f)) missing.push(`${d.name}.${f}`);
  }
  assert.deepEqual(missing, []);
});

test("every schema property has a description", () => {
  const bare: string[] = [];
  for (const d of defs)
    for (const [path, p] of props(d.inputSchema, ""))
      if (typeof p.description !== "string" || p.description.length < 8)
        bare.push(`${d.name}.${path}`);
  assert.deepEqual(bare, []);
});

test("every limit and enum in a schema is in the rendered description, and every leaf has an example", () => {
  const miss: string[] = [];
  for (const d of defs)
    for (const [path, p] of props(d.inputSchema, "")) {
      const desc = String(p.description ?? "");
      const name = `${d.name}.${path}`;
      const nums = [
        p.minLength,
        p.maxLength,
        p.maximum,
        p.minItems,
        p.maxItems,
        typeof p.minimum === "number" && p.minimum > 0 ? p.minimum : undefined,
      ].filter(
        (x) => x !== undefined && x !== 0 && !(x === 1 && p.type !== "string"),
      );
      for (const n of nums)
        if (!new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(desc))
          miss.push(`${name} lacks ${n}`);
      for (const v of (p.enum ?? []) as unknown[])
        if (!desc.includes(String(v))) miss.push(`${name} lacks enum ${v}`);
      if (!/Example/i.test(desc)) miss.push(`${name} has no example`);
    }
  assert.deepEqual(miss, []);
});

test("every structured property's example is valid against its own schema", () => {
  const ajv = createAjv();
  const bad: string[] = [];
  let checked = 0;
  for (const d of defs)
    for (const [path, p] of props(d.inputSchema, "")) {
      if (p.type !== "object" && p.type !== "array") continue;
      if (p.type === "object" && !p.properties) continue;
      const ex = examplesIn(String(p.description))[0];
      if (ex === undefined) {
        bad.push(`${d.name}.${path} has no JSON example`);
        continue;
      }
      checked++;
      const v = ajv.compile(p as never);
      if (!v(ex)) bad.push(`${d.name}.${path}: ${ajv.errorsText(v.errors)}`);
    }
  assert.deepEqual(bad, []);
  assert.ok(checked >= 16, `only ${checked} structured examples checked`);
});

test("every example in a tool description is a valid call of that tool", () => {
  const bad: string[] = [];
  let n = 0;
  for (const d of defs)
    for (const ex of examplesIn(d.description)) {
      n++;
      const r = checkToolArgs(d.name as never, ex);
      if (!r.ok) bad.push(`${d.name} ${JSON.stringify(ex)}: ${r.message}`);
    }
  assert.deepEqual(bad, []);
  assert.ok(n >= 30, `only ${n} examples checked`);
});

test("a default stated in a schema is what the helper sends when the field is left out", () => {
  for (const tool of ["dm_send", "square_post", "room_post"] as const) {
    const intent = defs.find((d) => d.name === tool)?.inputSchema as {
      properties: { intent: { default: string } };
    };
    assert.equal(intent.properties.intent.default, "inform", tool);
  }
});

test("descriptions stay short: listings load into every agent's context", () => {
  for (const d of defs) assert.ok(d.description.length <= 1000, d.name);
  let total = 0;
  for (const d of defs) total += JSON.stringify(d).length;
  assert.ok(total < 60_000, `tool listing is ${total} characters`);
});

test("the 200 character limit of a criterion reason is stated where the agent sees it", () => {
  const hu = defs.find((d) => d.name === "handoff_update");
  const reason = JSON.stringify(hu?.inputSchema);
  assert.match(reason, /1 to 200 characters/);
});
