import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptPurpose, PURPOSE_MAX } from "./guide-tree.ts";

// Longer than PURPOSE_MAX whatever its value: numbered words, so a half word would show.
const LONG = Array.from(
  { length: Math.ceil(PURPOSE_MAX / 4) + 40 },
  (_, i) => `w${i}`,
).join(" ");

describe("acceptPurpose cut", () => {
  it("cuts a long purpose on a word boundary and ends with an ellipsis", () => {
    const r = acceptPurpose(LONG);
    assert.ok(r.ok);
    assert.ok([...r.value].length <= PURPOSE_MAX);
    assert.ok(r.value.endsWith("…"));
    assert.ok(!r.value.endsWith(" …"));
    assert.ok(LONG.startsWith(r.value.slice(0, -1)));
    // The source char after the kept text is a space: no half word kept.
    assert.equal(LONG[r.value.length - 1], " ");
  });
  it("leaves a purpose within the limit alone", () => {
    assert.deepEqual(acceptPurpose("Check the login page"), {
      ok: true,
      value: "Check the login page",
    });
  });
  it("one long word is hard cut, still with the ellipsis", () => {
    const r = acceptPurpose("z".repeat(PURPOSE_MAX + 50));
    assert.ok(r.ok);
    assert.equal([...r.value].length, PURPOSE_MAX);
    assert.ok(r.value.endsWith("…"));
  });
});
