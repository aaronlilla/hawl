import assert from "node:assert/strict";
import test from "node:test";
import { noWaitArgs } from "./join.ts";

test("noWaitArgs: forwards --specialties to the detached child", () => {
  assert.deepEqual(noWaitArgs("acme", ["claude_code"], "a,b"), [
    "join",
    "acme",
    "--host",
    "claude_code",
    "--yes",
    "--specialties",
    "a,b",
  ]);
});

test("noWaitArgs: no flag, nothing extra", () => {
  assert.deepEqual(noWaitArgs("acme", ["claude_code"]), [
    "join",
    "acme",
    "--host",
    "claude_code",
    "--yes",
  ]);
});
