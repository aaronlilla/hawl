import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { b64url } from "@hawl/protocol/src/hash.ts";
import type { Jwk } from "@hawl/protocol/src/sign.ts";
import {
  applyPending,
  autoUpdateEnabled,
  checkAndStage,
  readPending,
  sha256Hex,
} from "./apply.ts";
import { runUpdate } from "./cmd.ts";
import {
  compareVersions,
  planUpdate,
  signedBytes,
  UPDATE_PUBKEY,
  type UpdateManifest,
  verifyUpdateManifest,
} from "./manifest.ts";

const key = generateKeyPairSync("ed25519");
const pub = key.publicKey.export({ format: "jwk" }) as Jwk;
const other = generateKeyPairSync("ed25519");

const NEW_BIN = Buffer.from("new-binary-bytes");

function manifest(
  over: Partial<Omit<UpdateManifest, "sig">> = {},
  signer = key.privateKey,
): UpdateManifest {
  const body = {
    version: "1.2.0",
    channel: "latest",
    min_relay: "1.0.0",
    assets: [
      {
        os: "linux",
        arch: "x64",
        url: "https://github.com/aaronlilla/hawl/releases/download/v1.2.0/hawl-linux-x64",
        sha256: sha256Hex(NEW_BIN),
      },
    ],
    ...over,
  };
  return { ...body, sig: b64url(sign(null, signedBytes(body), signer)) };
}

function tmp(): { stateDir: string; binPath: string } {
  const root = mkdtempSync(join(tmpdir(), "hawl-upd-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const binPath = join(root, "hawl");
  writeFileSync(binPath, "old-binary-bytes");
  return { stateDir, binPath };
}

function deps(
  t: { stateDir: string; binPath: string },
  m: unknown,
  bytes: Uint8Array = NEW_BIN,
  current = "1.1.0",
) {
  return {
    ...t,
    current,
    channel: "latest",
    os: "linux",
    arch: "x64",
    pubkey: pub,
    fetchManifest: async () => m,
    download: async () => bytes,
  };
}

test("good manifest verifies", () => {
  const r = verifyUpdateManifest(manifest(), pub);
  assert.equal(r.ok, true);
});

test("update --check reports a newer signed release and update stages it", async () => {
  const t = tmp();
  const d = deps(t, manifest());
  let output = "";
  const io = {
    out: (s: string) => {
      output += s;
    },
    err: (s: string) => {
      output += s;
    },
  };
  assert.equal(await runUpdate({ channel: "latest", check: true }, d, io), 10);
  assert.match(output, /1\.2\.0 is available/);
  assert.equal(readPending(t.stateDir), null);
  assert.equal(await runUpdate({ channel: "latest" }, d, io), 0);
  assert.equal(readPending(t.stateDir)?.version, "1.2.0");
});

test("update without a pinned release key explains the refusal and keeps the current binary", async () => {
  const t = tmp();
  const d = { ...deps(t, manifest()), pubkey: {} };
  let output = "";
  const io = {
    out: (s: string) => {
      output += s;
    },
    err: (s: string) => {
      output += s;
    },
  };
  assert.equal(await runUpdate({ channel: "latest" }, d, io), 1);
  assert.match(output, /no release verification key/);
  assert.doesNotMatch(output, /try again later/i);
  assert.equal(readPending(t.stateDir), null);
  assert.equal(readFileSync(t.binPath, "utf8"), "old-binary-bytes");
});

test("bad signature is refused", () => {
  const r = verifyUpdateManifest(manifest({}, other.privateKey), pub);
  assert.deepEqual(r, { ok: false, reason: "bad_sig" });
});

test("tampered asset after signing is refused", () => {
  const m = manifest();
  (m.assets[0] as { sha256: string }).sha256 = "0".repeat(64);
  assert.deepEqual(verifyUpdateManifest(m, pub), {
    ok: false,
    reason: "bad_sig",
  });
});

test("unpinned key refuses everything", () => {
  assert.deepEqual(UPDATE_PUBKEY, {});
  assert.deepEqual(verifyUpdateManifest(manifest()), {
    ok: false,
    reason: "no_key",
  });
});

test("non-https asset url and bad shape are refused", () => {
  const m = manifest({
    assets: [
      { os: "linux", arch: "x64", url: "http://x/y", sha256: "a".repeat(64) },
    ],
  });
  assert.deepEqual(verifyUpdateManifest(m, pub), {
    ok: false,
    reason: "schema",
  });
  assert.deepEqual(verifyUpdateManifest({ nope: 1 }, pub), {
    ok: false,
    reason: "schema",
  });
});

test("compareVersions orders numerically", () => {
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.ok(compareVersions("0.9.9", "1.0.0") < 0);
});

test("downgrade is refused, same version is a no-op", () => {
  const m = manifest({ version: "1.0.0" });
  const p = planUpdate(m, {
    current: "1.1.0",
    channel: "latest",
    os: "linux",
    arch: "x64",
  });
  assert.deepEqual(p, { ok: false, reason: "downgrade" });
  const same = planUpdate(manifest({ version: "1.1.0" }), {
    current: "1.1.0",
    channel: "latest",
    os: "linux",
    arch: "x64",
  });
  assert.deepEqual(same, { ok: false, reason: "up_to_date" });
});

test("the manifest must be for the requested channel", () => {
  const base = { current: "1.1.0", os: "linux", arch: "x64" };
  assert.deepEqual(planUpdate(manifest(), { ...base, channel: "next" }), {
    ok: false,
    reason: "channel",
  });
  assert.equal(
    planUpdate(manifest({ channel: "next" }), { ...base, channel: "next" }).ok,
    true,
  );
  assert.deepEqual(
    planUpdate(manifest({ channel: "next" }), { ...base, channel: "latest" }),
    { ok: false, reason: "channel" },
  );
});

test("no asset for this platform", () => {
  const p = planUpdate(manifest(), {
    current: "1.1.0",
    channel: "latest",
    os: "darwin",
    arch: "arm64",
  });
  assert.deepEqual(p, { ok: false, reason: "no_asset" });
});

test("checkAndStage refuses a bad signature and stages nothing", async () => {
  const t = tmp();
  const r = await checkAndStage(deps(t, manifest({}, other.privateKey)));
  assert.deepEqual(r, { status: "refused", reason: "bad_sig" });
  assert.equal(readPending(t.stateDir), null);
  assert.equal(existsSync(`${t.binPath}.next`), false);
});

test("checkAndStage refuses wrong sha256 and stages nothing", async () => {
  const t = tmp();
  const r = await checkAndStage(deps(t, manifest(), Buffer.from("tampered")));
  assert.deepEqual(r, { status: "refused", reason: "sha256" });
  assert.equal(readPending(t.stateDir), null);
  assert.equal(existsSync(`${t.binPath}.next`), false);
});

test("checkAndStage refuses a downgrade", async () => {
  const t = tmp();
  const r = await checkAndStage(
    deps(t, manifest({ version: "1.0.0" }), NEW_BIN, "1.1.0"),
  );
  assert.deepEqual(r, { status: "refused", reason: "downgrade" });
});

test("update.auto=false skips check and apply", async () => {
  const t = tmp();
  writeFileSync(
    join(t.stateDir, "config.json"),
    JSON.stringify({ update: { auto: false } }),
  );
  assert.equal(autoUpdateEnabled(t.stateDir), false);
  const r = await checkAndStage(deps(t, manifest()));
  assert.deepEqual(r, { status: "skipped", reason: "auto_off" });
  assert.equal(existsSync(`${t.binPath}.next`), false);

  // A pending update staged earlier is also not applied while auto is off.
  writeFileSync(`${t.binPath}.next`, NEW_BIN);
  writeFileSync(
    join(t.stateDir, "update-pending.json"),
    JSON.stringify({
      version: "1.2.0",
      sha256: sha256Hex(NEW_BIN),
      staged: `${t.binPath}.next`,
    }),
  );
  assert.deepEqual(applyPending({ ...t, current: "1.1.0" }), {
    status: "skipped",
    reason: "auto_off",
  });
  assert.equal(readFileSync(t.binPath, "utf8"), "old-binary-bytes");
});

test("good update stages, then swaps atomically at restart", async () => {
  const t = tmp();
  const r = await checkAndStage(deps(t, manifest()));
  assert.deepEqual(r, { status: "staged", version: "1.2.0" });
  assert.equal(readFileSync(t.binPath, "utf8"), "old-binary-bytes");
  const a = applyPending({ ...t, current: "1.1.0" });
  assert.deepEqual(a, { status: "applied", from: "1.1.0", to: "1.2.0" });
  assert.equal(readFileSync(t.binPath, "utf8"), "new-binary-bytes");
  assert.equal(readFileSync(`${t.binPath}.old`, "utf8"), "old-binary-bytes");
  assert.equal(readPending(t.stateDir), null);
  assert.deepEqual(applyPending({ ...t, current: "1.2.0" }), {
    status: "none",
  });
});

test("staged file changed on disk is refused at apply", async () => {
  const t = tmp();
  await checkAndStage(deps(t, manifest()));
  writeFileSync(`${t.binPath}.next`, "evil");
  const a = applyPending({ ...t, current: "1.1.0" });
  assert.deepEqual(a, { status: "refused", reason: "sha256" });
  assert.equal(readFileSync(t.binPath, "utf8"), "old-binary-bytes");
  assert.equal(readPending(t.stateDir), null);
});

test("pending older than the running version is refused at apply", async () => {
  const t = tmp();
  await checkAndStage(deps(t, manifest()));
  const a = applyPending({ ...t, current: "1.3.0" });
  assert.deepEqual(a, { status: "refused", reason: "downgrade" });
  assert.equal(readFileSync(t.binPath, "utf8"), "old-binary-bytes");
});
