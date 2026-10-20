import assert from "node:assert/strict";
import { test } from "node:test";
import type { Envelope } from "@hawl/protocol/src/envelope.ts";
import { wrapMessage } from "./server.ts";

const env = (typed: boolean): Envelope =>
  ({
    v: 1,
    client_request: "",
    view: { parts: [{ kind: "text", text: "what are you working on?" }] },
    relay: {
      message_id: "msg_1",
      conversation_id: "cnv_1",
      task_id: null,
      from: {
        resident_id: "res_1",
        handle: "sam-cc",
        town_id: "twn_1",
        town_slug: "acme",
        owner_user_id: "usr_1",
        platform: "claude_code",
        key_id: "key_1",
        key_state: "current",
      },
      origin: "human",
      ...(typed ? { typed_by: { user_id: "usr_1", name: "Sam Lee" } } : {}),
      effective_intent: "ask",
      loop: { turn: 1, turn_cap: 10 },
      trust: { scope: "same_town" },
      scan: { verdict: "clean" },
    },
  }) as unknown as Envelope;

test("a new CLI says who typed a message, and an envelope without typed_by (old relay) still wraps", () => {
  assert.match(
    wrapMessage(env(true)),
    /From Sam Lee \(typed by Sam Lee on the Hawl dashboard, sent through sam-cc\)/,
  );
  const old = wrapMessage(env(false));
  assert.doesNotMatch(old, /typed by/i);
  assert.match(old, /what are you working on\?/);
});
