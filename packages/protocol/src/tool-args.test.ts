import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AnyToolName,
  argsHint,
  checkToolArgs,
  TOOL_ALIASES,
} from "./validate.ts";

const HND = "hnd_01a16b9c-26d4-717a-b0d4-4a096544cedd";

// The exact calls that failed in the pilot (h1-r1 PM L63, QA handoff_get L71).
test("pilot calls: message and id are accepted and normalized", () => {
  const dm = checkToolArgs("dm_send", {
    to: "@other-ctl",
    message: "Owner request: Add CSV export",
  });
  assert.ok(dm.ok, JSON.stringify(dm));
  assert.deepEqual(dm.args, {
    to: "@other-ctl",
    text: "Owner request: Add CSV export",
  });
  for (const tool of ["handoff_get", "handoff_update"] as const) {
    const r = checkToolArgs(tool, {
      id: HND,
      ...(tool === "handoff_update" && { op: "accept" }),
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal((r.args as { handoff_id: string }).handoff_id, HND);
    assert.ok(!("id" in (r.args as object)));
  }
});

test("both given: equal is fine, different is an error naming both", () => {
  assert.ok(checkToolArgs("handoff_get", { id: HND, handoff_id: HND }).ok);
  const other = HND.replace("cedd", "cede");
  const r = checkToolArgs("handoff_get", { id: other, handoff_id: HND });
  assert.ok(!r.ok);
  assert.match(r.message, /id and handoff_id/);
  const d = checkToolArgs("dm_send", { to: "a", text: "x", message: "y" });
  assert.ok(!d.ok);
  assert.match(d.message, /message and text/);
});

test("an alias only works on its own tool", () => {
  for (const [tool, args] of [
    ["dm_send", { to: "a", text: "x", id: HND }],
    ["square_post", { message: "hi" }],
    ["thread_reply", { message_id: "msg_x", message: "hi" }],
    ["handoff_list", { id: HND }],
    ["ask_agent", { to: "a", message: "hi" }],
  ] as const) {
    const r = checkToolArgs(tool, args);
    assert.ok(!r.ok, `${tool} ${JSON.stringify(args)}`);
  }
});

test("other unknown fields are still rejected and the error names the expected fields", () => {
  const r = checkToolArgs("dm_send", { to: "a", text: "x", body: "y" });
  assert.ok(!r.ok);
  assert.match(r.message, /additional properties/);
  assert.match(
    r.message,
    /expected \{to, text, data\?, intent\?, files\?, reply_to\?\}/,
  );
  const m = checkToolArgs("handoff_get", {});
  assert.ok(!m.ok);
  assert.match(m.message, /expected \{handoff_id\}/);
});

test("type confusion: alias values are validated as the real field", () => {
  for (const v of [123, null, ["x"], { a: 1 }, "", true]) {
    assert.ok(!checkToolArgs("dm_send", { to: "a", message: v }).ok);
    assert.ok(!checkToolArgs("handoff_get", { id: v }).ok);
  }
  assert.ok(!checkToolArgs("handoff_get", { id: "hnd_nope" }).ok);
});

test("not-object args and prototype keys do not slip through", () => {
  for (const a of [null, "id", 5, [HND], undefined]) {
    assert.ok(!checkToolArgs("handoff_get", a).ok, String(a));
  }
  const evil = JSON.parse(`{"__proto__": {"id": "x"}, "handoff_id": "${HND}"}`);
  assert.ok(!checkToolArgs("handoff_get", evil).ok);
  assert.ok(
    !checkToolArgs("handoff_get", { constructor: 1, handoff_id: HND }).ok,
  );
});

test("the caller's args object is not changed", () => {
  const a = { to: "a", message: "x" };
  checkToolArgs("dm_send", a);
  assert.deepEqual(a, { to: "a", message: "x" });
});

test("alias table: each alias is not a schema field, and its target is", () => {
  for (const [tool, map] of Object.entries(TOOL_ALIASES)) {
    const hint = argsHint(tool as AnyToolName);
    for (const [alias, field] of Object.entries(map ?? {})) {
      assert.ok(hint.includes(field), `${tool}: ${field} in ${hint}`);
      assert.ok(
        !new RegExp(`[{ ]${alias}\??[,}]`).test(hint),
        `${tool}: ${alias} is a real field`,
      );
    }
  }
  assert.deepEqual(Object.keys(TOOL_ALIASES).sort(), [
    "dm_send",
    "handoff_get",
    "handoff_update",
  ]);
});

test("the 200 character reason limit is an error that names the field", () => {
  const r = checkToolArgs("handoff_update", {
    handoff_id: HND,
    op: "verify",
    evidence: {
      criteria: [{ id: "c1", result: "pass", reason: "x".repeat(201) }],
    },
  });
  assert.ok(!r.ok);
  assert.match(r.message, /reason must NOT have more than 200 characters/);
});
