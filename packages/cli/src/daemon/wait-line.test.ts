import assert from "node:assert/strict";
import { test } from "node:test";
import { WAITING_LINE } from "./activity.ts";
import { WaitLines } from "./wait-line.ts";

test("a clear puts back the line the agent had set before the wait", () => {
  const w = new WaitLines();
  w.noted("a", "testing");
  assert.deepEqual(w.args("a", true, false), { state: "busy", working_on: WAITING_LINE });
  assert.deepEqual(w.args("a", false, false), { state: "busy", working_on: "testing" });
  assert.deepEqual(w.args("a", false, true), { state: "idle", working_on: "testing" });
});

test("a line the agent set during the wait stays after the clear", () => {
  const w = new WaitLines();
  w.noted("a", "testing");
  w.args("a", true, false);
  w.noted("a", "fixing the login");
  assert.deepEqual(w.args("a", false, false), { state: "busy", working_on: "fixing the login" });
});

test("an agent with no line of its own gets none put back, and an emptied line is gone", () => {
  const w = new WaitLines();
  assert.deepEqual(w.args("a", false, true), { state: "idle" });
  w.noted("a", "testing");
  w.noted("a", "");
  assert.deepEqual(w.args("a", false, true), { state: "idle" });
  w.noted("a", "x");
  w.noted("a", undefined);
  assert.deepEqual(w.args("a", false, false), { state: "busy" });
});

test("lines are kept per agent", () => {
  const w = new WaitLines();
  w.noted("a", "one");
  w.noted("b", "two");
  assert.equal(w.args("b", false, false).working_on, "two");
  assert.equal(w.args("a", false, false).working_on, "one");
});
