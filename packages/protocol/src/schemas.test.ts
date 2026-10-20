import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ERROR_CODES, ERROR_STATUS, isErrorCode } from "./errors.ts";
import type { SchemaName, SchemaTypes } from "./types.ts";
import {
  frameSchemaName,
  loadSchemaFiles,
  TOOL_NAMES,
  validate,
  validateConsoleFrame,
  validateFrame,
  validateToolArgs,
  validateToolResult,
} from "./validate.ts";

const FIXTURES = new URL("../fixtures/", import.meta.url);

function jsonFiles(dir: URL): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

/** Fixture dirs: fixtures/<schema>/{valid,invalid}, where <schema> may be "tools/who.args". */
function fixtureSchemas(): string[] {
  const out: string[] = [];
  for (const top of readdirSync(FIXTURES)) {
    const kids = readdirSync(new URL(`${top}/`, FIXTURES));
    if (kids.includes("valid") || kids.includes("invalid")) out.push(top);
    else for (const k of kids) out.push(`${top}/${k}`);
  }
  return out.sort();
}

function load(dir: URL, file: string): unknown {
  return JSON.parse(readFileSync(new URL(file, dir), "utf8")) as unknown;
}

/** Typed loader: a valid fixture of schema K must have the hand-written type SchemaTypes[K]. */
function validFixtures<K extends SchemaName>(
  name: K,
): { file: string; value: SchemaTypes[K] }[] {
  const dir = new URL(`${name}/valid/`, FIXTURES);
  return jsonFiles(dir).map((file) => ({
    file,
    value: load(dir, file) as SchemaTypes[K],
  }));
}

function invalidFixtures(name: string): { file: string; value: unknown }[] {
  const dir = new URL(`${name}/invalid/`, FIXTURES);
  return jsonFiles(dir).map((file) => ({ file, value: load(dir, file) }));
}

const schemaKeys = loadSchemaFiles()
  .map((f) => f.name.replace(/^schemas\//, ""))
  .filter((n) => n !== "common")
  .sort();

test("every schema has a fixture dir with valid and invalid cases", () => {
  assert.deepEqual(fixtureSchemas(), schemaKeys);
  for (const key of schemaKeys) {
    assert.ok(
      jsonFiles(new URL(`${key}/valid/`, FIXTURES)).length > 0,
      `${key}: no valid fixtures`,
    );
    assert.ok(
      jsonFiles(new URL(`${key}/invalid/`, FIXTURES)).length > 0,
      `${key}: no invalid fixtures`,
    );
  }
});

for (const name of fixtureSchemas()) {
  test(`fixtures: ${name}`, () => {
    for (const { file, value } of validFixtures(name as SchemaName)) {
      const r = validate(name, value);
      assert.ok(
        r.ok,
        `${name}/valid/${file} should validate: ${r.ok ? "" : r.message}`,
      );
    }
    for (const { file, value } of invalidFixtures(name)) {
      assert.equal(
        validate(name, value).ok,
        false,
        `${name}/invalid/${file} should fail`,
      );
    }
  });
}

test("every tool in spec 2.4 has args and result schemas", () => {
  assert.equal(TOOL_NAMES.length, 19);
  const names = new Set(schemaKeys);
  for (const t of TOOL_NAMES) {
    assert.ok(names.has(`tools/${t}.args`), `${t}.args`);
    assert.ok(names.has(`tools/${t}.result`), `${t}.result`);
  }
  assert.equal(schemaKeys.filter((n) => n.startsWith("tools/")).length, 38);
});

test("tool helpers", () => {
  assert.ok(validateToolArgs("who", {}).ok);
  assert.ok(!validateToolArgs("who", { zzz: 1 }).ok);
  assert.ok(validateToolResult("status_set", { ok: true }).ok);
});

test("frame dispatch by t", () => {
  assert.equal(frameSchemaName("presence.set"), "frames/presence_set");
  assert.equal(frameSchemaName("nope"), null);
  assert.ok(validateFrame({ t: "ping", ts: "2026-10-10T14:03:11.204Z" }).ok);
  assert.ok(!validateFrame({ t: "ping" }).ok);
  assert.ok(!validateFrame({ t: "hello" }).ok);
  assert.ok(validateConsoleFrame({ t: "subscribe", streams: ["feed"] }).ok);
  assert.ok(!validateConsoleFrame({ t: "traffic" }).ok);
});

test("error schema enum equals ERROR_CODES, named codes exist", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL("../schemas/error.schema.json", import.meta.url),
      "utf8",
    ),
  ) as { properties: { error: { properties: { code: { enum: string[] } } } } };
  assert.deepEqual(schema.properties.error.properties.code.enum, [
    ...ERROR_CODES,
  ]);
  for (const c of [
    "plan_limit",
    "too_many_mentions",
    "scan_budget_exceeded",
    "handoff_limit",
    "fresh_auth_required",
  ]) {
    assert.ok(isErrorCode(c), c);
  }
  assert.equal(ERROR_STATUS.not_found, 404);
  assert.equal(isErrorCode("no_grant"), false);
});
