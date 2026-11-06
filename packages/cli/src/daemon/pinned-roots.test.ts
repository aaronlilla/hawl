import assert from "node:assert/strict";
import { test } from "node:test";
import { PINNED_ROOTS, pinnedRoots } from "./manifest.ts";

const dev = JSON.stringify({
  root_dev: { kty: "OKP", crv: "Ed25519", x: "x" },
});

test("a dev root counts for loopback and relay-staging only", () => {
  for (const url of ["http://localhost:8080", "https://relay-staging.hawl.ai"])
    assert.ok(
      "root_dev" in
        pinnedRoots({ HAWL_DEV_PINNED_ROOTS: dev, HAWL_RELAY_URL: url }),
      url,
    );
  for (const url of [
    "https://relay.hawl.ai",
    "https://relay-staging.hawl.ai.evil.example",
  ])
    assert.equal(
      pinnedRoots({ HAWL_DEV_PINNED_ROOTS: dev, HAWL_RELAY_URL: url }),
      PINNED_ROOTS,
      url,
    );
  assert.equal(pinnedRoots({ HAWL_DEV_PINNED_ROOTS: dev }), PINNED_ROOTS);
});
