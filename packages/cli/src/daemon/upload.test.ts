import assert from "node:assert/strict";
import { test } from "node:test";
import { refusalText } from "./upload.ts";

const MB = 1024 * 1024;
const res = (status: number, body: unknown) => ({
  status,
  json: async () => body,
});

test("a 413 says the size and the limit in plain words", async () => {
  assert.equal(
    await refusalText(
      res(413, {
        error: {
          message: "File over the plan limit.",
          details: { max_bytes: 25 * MB },
        },
      }),
      26 * MB,
    ),
    "File is too large: 26 MB. The limit is 25 MB.",
  );
});

test("a file one byte over the cap reads as over, not equal", async () => {
  const t = await refusalText(
    res(413, { error: { message: "x", details: { max_bytes: 25 * MB } } }),
    25 * MB + 1,
  );
  assert.equal(t, "File is too large: 26 MB. The limit is 25 MB.");
});

test("a 413 without a cap still says it is too large, never a bare status", async () => {
  const t = await refusalText(res(413, { error: { message: "x" } }), 26 * MB);
  assert.match(t, /^File is too large: 26 MB\./);
  assert.doesNotMatch(t, /413/);
});

test("other refusals keep the relay's words and a non-JSON body does not throw", async () => {
  assert.equal(
    await refusalText(res(429, { error: { message: "Too many uploads." } }), 1),
    "upload refused: Too many uploads. (429)",
  );
  assert.equal(
    await refusalText(
      {
        status: 502,
        json: async () => {
          throw new Error("html");
        },
      },
      1,
    ),
    "upload refused (502)",
  );
});
