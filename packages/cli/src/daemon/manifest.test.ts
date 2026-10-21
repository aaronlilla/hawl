import assert from "node:assert/strict";
import { test } from "node:test";
import { ManifestStore } from "./manifest.ts";
import {
  makeRelayKey,
  makeRoot,
  manifestPayload,
  signManifest,
  tmpState,
} from "./testkit.ts";

const NOW = Date.parse("2026-10-10T14:00:00Z");

function setup() {
  const root = makeRoot();
  const relay = makeRelayKey();
  const dir = tmpState();
  const store = new ManifestStore(dir, root.roots, () => NOW);
  return { root, relay, dir, store };
}

test("accepts a root-signed manifest and persists the highest seq", () => {
  const { root, relay, dir, store } = setup();
  const m1 = signManifest(root, manifestPayload(relay.jwk, { seq: 5 }));
  assert.deepEqual(store.accept(m1), { ok: true, seq: 5, changed: true });
  const again = new ManifestStore(dir, root.roots, () => NOW);
  assert.equal(again.seq, 5);
  assert.equal(again.usable, true);
});

test("manifest rollback is refused: lower seq, and equal seq with other content", () => {
  const { root, relay, store } = setup();
  assert.equal(
    store.accept(signManifest(root, manifestPayload(relay.jwk, { seq: 7 }))).ok,
    true,
  );
  const lower = store.accept(
    signManifest(root, manifestPayload(relay.jwk, { seq: 6 })),
  );
  assert.deepEqual(lower, { ok: false, reason: "rollback" });
  const other = makeRelayKey();
  const sameSeqOtherKeys = store.accept(
    signManifest(root, manifestPayload(other.jwk, { seq: 7 })),
  );
  assert.deepEqual(sameSeqOtherKeys, { ok: false, reason: "rollback" });
  // identical replay is fine and changes nothing
  assert.deepEqual(
    store.accept(signManifest(root, manifestPayload(relay.jwk, { seq: 7 }))),
    { ok: true, seq: 7, changed: false },
  );
  assert.equal(store.seq, 7);
});

test("rollback is still refused after a restart", () => {
  const { root, relay, dir, store } = setup();
  store.accept(signManifest(root, manifestPayload(relay.jwk, { seq: 9 })));
  const again = new ManifestStore(dir, root.roots, () => NOW);
  assert.deepEqual(
    again.accept(signManifest(root, manifestPayload(relay.jwk, { seq: 8 }))),
    { ok: false, reason: "rollback" },
  );
});

test("wrong root, bad signature, bad schema and bad window are refused", () => {
  const { root, relay, store } = setup();
  const stranger = makeRoot("root_1");
  const forged = signManifest(stranger, manifestPayload(relay.jwk));
  assert.deepEqual(store.accept(forged), { ok: false, reason: "root_sig" });
  const unknown = signManifest(makeRoot("root_9"), manifestPayload(relay.jwk));
  assert.deepEqual(store.accept(unknown), {
    ok: false,
    reason: "unknown_root",
  });
  const good = signManifest(root, manifestPayload(relay.jwk));
  good.payload.seq = 99; // edited after signing
  assert.deepEqual(store.accept(good), { ok: false, reason: "root_sig" });
  assert.deepEqual(store.accept({ nope: 1 }), { ok: false, reason: "schema" });
  const old = signManifest(
    root,
    manifestPayload(relay.jwk, { not_after: "2026-02-01T00:00:00Z" }),
  );
  assert.deepEqual(store.accept(old), { ok: false, reason: "expired" });
  assert.equal(store.current, null);
});

test("a planted manifest.json that the root did not sign is ignored on load", async () => {
  const { relay, dir, root } = setup();
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const stranger = makeRoot("root_1");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(signManifest(stranger, manifestPayload(relay.jwk))),
  );
  assert.equal(new ManifestStore(dir, root.roots, () => NOW).current, null);
});

test("relayKey fails closed outside the window and for keys revoked before the signing time", () => {
  const { root, relay, dir, store } = setup();
  store.accept(
    signManifest(
      root,
      manifestPayload(relay.jwk, {
        revoked: [
          {
            kid: "rk_2026q3",
            at: "2026-10-09T12:00:00Z",
            reason: "compromise",
          },
        ],
        keys: [
          ...manifestPayload(relay.jwk).keys,
          {
            kid: "rk_2026q3",
            jwk: relay.jwk as never,
            status: "retired",
          },
        ],
      }),
    ),
  );
  assert.ok(store.relayKey("rk_2026q4", "2026-10-10T00:00:00Z"));
  assert.equal(store.relayKey("rk_2099q1", "2026-10-10T00:00:00Z"), null);
  assert.ok(store.relayKey("rk_2026q3", "2026-10-09T11:00:00Z"));
  assert.equal(store.relayKey("rk_2026q3", "2026-10-09T12:00:01Z"), null);
  assert.equal(store.relayKey("rk_2026q3", "not a date"), null);
  const later = new ManifestStore(dir, root.roots, () =>
    Date.parse("2100-01-01T00:00:00Z"),
  );
  assert.equal(later.usable, false);
  assert.equal(later.relayKey("rk_2026q4", "2026-10-10T00:00:00Z"), null);
});
