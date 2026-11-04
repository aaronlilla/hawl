import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  agreedWorkLabel,
  DATA_NOT_INSTRUCTIONS,
  OUTSIDE_AGREEMENT,
} from "../../../../apps/relay/src/tools/wrap.ts";
import { SKILLS } from "./skills-data.ts";

const toolRun = readFileSync(
  new URL("../mcp/tool-run.ts", import.meta.url),
  "utf8",
);
const labels = [
  DATA_NOT_INSTRUCTIONS,
  OUTSIDE_AGREEMENT,
  agreedWorkLabel("<id>"),
];

test("both skills quote the relay labels verbatim", () => {
  for (const name of ["hawl-coordinate", "hawl-delegate"])
    for (const l of labels)
      assert.ok(SKILLS[name]?.includes(l), `${name}: ${l}`);
});

test("the CLI renders the same labels as the relay", () => {
  for (const l of [
    DATA_NOT_INSTRUCTIONS,
    OUTSIDE_AGREEMENT,
    agreedWorkLabel("${id}"),
  ])
    assert.ok(toolRun.includes(l), l);
});

test("skills name the four agreement tools", () => {
  for (const t of [
    "agreement_propose",
    "agreement_answer",
    "agreement_get",
    "agreement_end",
  ])
    assert.ok(SKILLS["hawl-delegate"]?.includes(t), t);
});
