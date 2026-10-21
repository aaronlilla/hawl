import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryKeyStore } from "./keys.ts";
import { startDaemon } from "./main.ts";
import { ManifestStore } from "./manifest.ts";
import { makeRoot, tmpState } from "./testkit.ts";

async function boot(fetchManifest: () => Promise<unknown>, config?: object) {
  const stateDir = tmpState();
  const binPath = join(mkdtempSync(join(tmpdir(), "hawl-dbin-")), "hawl");
  writeFileSync(binPath, "old-binary-bytes");
  if (config)
    writeFileSync(join(stateDir, "config.json"), JSON.stringify(config));
  const logs: string[] = [];
  const d = await startDaemon({
    stateDir,
    keyStore: new MemoryKeyStore(),
    manifests: new ManifestStore(stateDir, makeRoot().roots),
    workers: [],
    update: {
      binPath,
      current: "1.1.0",
      os: "linux",
      arch: "x64",
      log: (l: string) => logs.push(l),
      intervalMs: 3_600_000,
      download: async () => new Uint8Array(),
      fetchManifest,
    },
  });
  return { d, binPath, logs };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test("daemon starts the updater once at startup", async () => {
  let calls = 0;
  const { d } = await boot(async () => {
    calls++;
    return {};
  });
  await tick();
  assert.equal(calls, 1);
  await d.stop();
});

test("update.auto=false: daemon never fetches the manifest", async () => {
  let calls = 0;
  const { d, binPath } = await boot(
    async () => {
      calls++;
      return {};
    },
    { update: { auto: false } },
  );
  await tick();
  assert.equal(calls, 0);
  assert.equal(readFileSync(binPath, "utf8"), "old-binary-bytes");
  await d.stop();
});

test("a failed check is logged and the old binary stays", async () => {
  const { d, binPath, logs } = await boot(async () => {
    throw new Error("offline");
  });
  await tick();
  assert.ok(logs.some((l) => l.includes("hawl update check failed: offline")));
  assert.equal(readFileSync(binPath, "utf8"), "old-binary-bytes");
  await d.stop();
});

test("no update option: no updater (short-lived paths and tests)", async () => {
  const stateDir = tmpState();
  const d = await startDaemon({
    stateDir,
    keyStore: new MemoryKeyStore(),
    manifests: new ManifestStore(stateDir, makeRoot().roots),
    workers: [],
  });
  await d.stop();
});
