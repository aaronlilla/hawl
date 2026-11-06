import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRequest,
  checkSentence,
  DRAFT_MAX_TOKENS,
  DRAFT_SCHEMA,
  DRAFT_SYSTEM,
  type DraftClient,
  type DraftRequest,
  type DraftResult,
  draftWorkOrder,
  fallbackNote,
  MAX_DETAILS,
  MAX_SENTENCE,
  parseDraft,
} from "./draft-work-order.ts";

function fake(res: DraftResult | (() => never)) {
  const calls: DraftRequest[] = [];
  const client: DraftClient = {
    async call(req) {
      calls.push(req);
      return typeof res === "function" ? res() : res;
    },
  };
  return { client, calls };
}

const GOOD = JSON.stringify({
  title: "Fix the signup form",
  doneMeans: ["Empty email is rejected", "A test covers it"],
  risk: "medium",
});

describe("draftWorkOrder", () => {
  it("returns a draft from the model's JSON", async () => {
    const { client, calls } = fake({ status: "ok", text: GOOD });
    const r = await draftWorkOrder(client, "t1", "  fix   the signup form ");
    assert.deepEqual(r, {
      status: "ok",
      draft: {
        title: "Fix the signup form",
        doneMeans: ["Empty email is rejected", "A test covers it"],
        risk: "medium",
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.feature, "draft");
    assert.equal(calls[0]?.user, "Sentence: fix the signup form");
    assert.equal(calls[0]?.maxTokens, DRAFT_MAX_TOKENS);
  });

  it("over-cap sentence makes no call", async () => {
    const { client, calls } = fake({ status: "ok", text: GOOD });
    const r = await draftWorkOrder(client, "t1", "x".repeat(MAX_SENTENCE + 1));
    assert.deepEqual(r, { status: "fallback", reason: "over_cap" });
    assert.equal(calls.length, 0);
  });

  it("exactly 300 characters is allowed", () => {
    assert.equal(checkSentence("x".repeat(MAX_SENTENCE)).ok, true);
  });

  it("empty sentence makes no call", async () => {
    const { client, calls } = fake({ status: "ok", text: GOOD });
    const r = await draftWorkOrder(client, "t1", "   ");
    assert.deepEqual(r, { status: "fallback", reason: "empty" });
    assert.equal(calls.length, 0);
  });

  it("no client falls back without a call", async () => {
    assert.deepEqual(await draftWorkOrder(undefined, "t1", "do a thing"), {
      status: "fallback",
      reason: "disabled",
    });
  });

  for (const reason of ["disabled", "budget", "daily_cap"] as const) {
    it(`skipped ${reason} falls back`, async () => {
      const { client } = fake({ status: "skipped", reason });
      assert.deepEqual(await draftWorkOrder(client, "t1", "do a thing"), {
        status: "fallback",
        reason,
      });
    });
  }

  it("client error and thrown error fall back", async () => {
    const a = fake({ status: "error", message: "APIError" });
    assert.deepEqual(await draftWorkOrder(a.client, "t1", "do a thing"), {
      status: "fallback",
      reason: "error",
    });
    const b = fake(() => {
      throw new Error("boom");
    });
    assert.deepEqual(await draftWorkOrder(b.client, "t1", "do a thing"), {
      status: "fallback",
      reason: "error",
    });
  });

  it("unusable answers fall back as bad_answer", async () => {
    for (const text of [
      "not json",
      "null",
      '{"title":"","doneMeans":["a"],"risk":"low"}',
      '{"title":"t","doneMeans":[],"risk":"low"}',
      '{"title":"t","doneMeans":["a"],"risk":"extreme"}',
    ]) {
      const { client } = fake({ status: "ok", text });
      assert.deepEqual(await draftWorkOrder(client, "t1", "do a thing"), {
        status: "fallback",
        reason: "bad_answer",
      });
    }
  });
});

describe("parseDraft", () => {
  it("keeps at most 5 lines and clips long text", () => {
    const d = parseDraft(
      JSON.stringify({
        title: "T".repeat(200),
        doneMeans: ["a", "b", "c", "d", "e", "f", "g", "L".repeat(500)],
        risk: "low",
      }),
    );
    assert.ok(d);
    assert.equal(d.doneMeans.length, 5);
    assert.ok(d.title.length <= 80);
  });
});

describe("cost", () => {
  it("volatile input plus capped output stays under 1k tokens", () => {
    const req = buildRequest("t1", "x".repeat(MAX_SENTENCE));
    const userTokens = Math.ceil(req.user.length / 3);
    assert.ok(userTokens + req.maxTokens < 1000);
  });

  it("frozen system prompt is long enough to cache and holds no per-call text", () => {
    assert.ok(DRAFT_SYSTEM.length / 4 > 512, `${DRAFT_SYSTEM.length} chars`);
    assert.equal(
      buildRequest("a", "one").system,
      buildRequest("b", "two").system,
    );
  });
});

describe("fallbackNote", () => {
  it("has a plain line for every reason", () => {
    for (const r of [
      "empty",
      "over_cap",
      "disabled",
      "budget",
      "daily_cap",
      "error",
      "bad_answer",
    ] as const)
      assert.ok(fallbackNote(r).length > 0);
  });
});

describe("draft details (W26)", () => {
  const withDetails = (details: unknown) =>
    JSON.stringify({
      title: "Fix the signup form",
      doneMeans: ["Empty email is rejected"],
      risk: "low",
      details,
    });

  it("carries a details string through the parser", () => {
    assert.equal(
      parseDraft(withDetails("The form is at /signup.  Keep the copy."))
        ?.details,
      "The form is at /signup. Keep the copy.",
    );
  });

  it("bounds details to MAX_DETAILS", () => {
    const d = parseDraft(withDetails("x".repeat(MAX_DETAILS + 500)))?.details;
    assert.ok(d !== undefined && d.length <= MAX_DETAILS);
  });

  it("omits details when blank or not a string", () => {
    assert.equal(parseDraft(withDetails("   "))?.details, undefined);
    assert.equal(parseDraft(withDetails(7))?.details, undefined);
  });

  it("schema asks for details and the prompt describes it", () => {
    const props = DRAFT_SCHEMA.properties as Record<string, unknown>;
    assert.ok("details" in props);
    assert.match(DRAFT_SYSTEM, /- details:/);
  });
});
