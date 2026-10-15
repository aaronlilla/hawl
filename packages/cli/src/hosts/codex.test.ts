import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { codexBlocks } from "./codex.ts";

test("codex writes no [otel] and hooks cover session and tool events", () => {
  const text = codexBlocks()
    .map((b) => b.text)
    .join("\n\n");
  const doc = parseToml(text) as Record<string, any>;
  assert.equal(doc.otel, undefined);
  assert.ok(!text.includes("otel"));
  for (const e of [
    "UserPromptSubmit",
    "SessionStart",
    "PreToolUse",
    "PostToolUse",
  ])
    assert.equal(doc.hooks[e][0].hooks[0].command, `hawl hook codex ${e}`);
});
