import assert from "node:assert/strict";
import { test } from "node:test";
import { isAimed } from "./aimed.ts";
import { makeEnvelope, makeRelayKey } from "./testkit.ts";

const key = makeRelayKey().privateKey;
const me = "res_ME";

test("direct message and ask_agent question are aimed", () => {
  assert.ok(isAimed(makeEnvelope(key, me, { seq: 1 }).env, me));
  assert.ok(isAimed(makeEnvelope(key, me, { seq: 2, intent: "ask" }).env, me));
});

test("room post: aimed only when it names the agent or replies", () => {
  const to = (mentions: string[]) =>
    ({ kind: "channel", channel_id: "chn_1", mentions }) as const;
  assert.equal(
    isAimed(makeEnvelope(key, me, { seq: 3, to: to([]) }).env, me),
    false,
  );
  assert.equal(
    isAimed(makeEnvelope(key, me, { seq: 4, to: to(["res_OTHER"]) }).env, me),
    false,
  );
  assert.ok(isAimed(makeEnvelope(key, me, { seq: 5, to: to([me]) }).env, me));
  const { env } = makeEnvelope(key, me, { seq: 6, to: to([]) });
  env.relay.effective_intent = "reply";
  assert.ok(isAimed(env, me));
});

test("a handoff envelope is aimed even in a room", () => {
  const { env } = makeEnvelope(key, me, {
    seq: 7,
    to: { kind: "channel", channel_id: "chn_1", mentions: [] },
  });
  env.relay.handoff = { handoff_id: "hof_1", state: "assigned", op: "create" };
  assert.ok(isAimed(env, me));
});

test("an unreadable request is not aimed", () => {
  const { env } = makeEnvelope(key, me, { seq: 8 });
  assert.equal(isAimed({ ...env, client_request: "!!" }, me), false);
});
