import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryKeyStore } from "../daemon/keys.ts";
import { startDaemon } from "../daemon/main.ts";
import { ManifestStore } from "../daemon/manifest.ts";
import { makeRoot, tmpState } from "../daemon/testkit.ts";
import { daemonLink, helperLaunch } from "../mcp/server.ts";
import {
  currentFile,
  newerCurrent,
  npxNext,
  stageLatestNpm,
  stageNpm,
  swapWhenIdle,
  toolsNeedReconnect,
} from "./live-swap.ts";

/** A fake staged package: the entry file exists and `current` points at it. */
function stagePointer(stateDir: string, version: string) {
  const entry = join(stateDir, "versions", version, "main.js");
  mkdirSync(join(stateDir, "versions", version), { recursive: true });
  writeFileSync(entry, "");
  writeFileSync(currentFile(stateDir), JSON.stringify({ version, entry }));
  return entry;
}

const boot = (stateDir: string, version: string, extra = {}) =>
  startDaemon({
    stateDir,
    version,
    keyStore: new MemoryKeyStore(),
    manifests: new ManifestStore(stateDir, makeRoot().roots),
    workers: [],
    onShutdown: () => {},
    ...extra,
  });

test("old helper swaps to the new one; the shim's next call still works", async () => {
  const stateDir = tmpState();
  stagePointer(stateDir, "1.1.0");
  let fresh: Promise<{ stop(): Promise<void> }> | undefined;
  const old = await boot(stateDir, "1.0.0", {
    liveSwap: {
      // The real launch spawns node; here the "new helper" is a second daemon on the same dir.
      next: () => ({
        version: "1.1.0",
        launch: () => {
          fresh = boot(stateDir, "1.1.0");
        },
      }),
    },
  });
  const shim = daemonLink(stateDir, { spawn: () => {}, startWaitMs: 5000 });
  const before = (await shim.call("status")) as { version: string };
  assert.equal(before.version, "1.0.0");
  assert.equal(await old.swapTick(false), "swapped");
  const after = (await shim.call("status")) as { version: string };
  assert.equal(after.version, "1.1.0");
  await (await fresh)?.stop();
});

test("no swap while a call is in flight; swaps once idle", async () => {
  const stateDir = tmpState();
  let busy = true;
  let stopped = 0;
  let launched = 0;
  const deps = {
    stateDir,
    current: "1.0.0",
    next: () => ({ version: "1.1.0", launch: () => void launched++ }),
    idle: () => !busy,
    stop: async () => void stopped++,
    pollMs: 5,
  };
  assert.equal(await swapWhenIdle({ ...deps, drainMs: 40 }), "busy");
  assert.deepEqual([stopped, launched], [0, 0]);
  setTimeout(() => {
    busy = false;
  }, 30);
  assert.equal(await swapWhenIdle({ ...deps, drainMs: 2000 }), "swapped");
  assert.deepEqual([stopped, launched], [1, 1]);
});

test("update.auto=false never swaps", async () => {
  const stateDir = tmpState();
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({ update: { auto: false } }),
  );
  let stopped = 0;
  const r = await swapWhenIdle({
    stateDir,
    current: "1.0.0",
    next: () => ({ version: "1.1.0", launch: () => {} }),
    idle: () => true,
    stop: async () => void stopped++,
  });
  assert.equal(r, "none");
  assert.equal(stopped, 0);
});

test("the shim starts the helper from versions/current when it is newer", () => {
  const stateDir = tmpState();
  const own = { script: "/own/main.js", sea: false, execPath: "node" };
  assert.deepEqual(
    helperLaunch(stateDir, { ...own, version: "1.0.0" }).args,
    ["/own/main.js", "daemon"],
    "nothing staged",
  );
  const entry = stagePointer(stateDir, "1.1.0");
  assert.deepEqual(helperLaunch(stateDir, { ...own, version: "1.0.0" }).args, [
    entry,
    "daemon",
  ]);
  assert.deepEqual(
    helperLaunch(stateDir, { ...own, version: "1.1.0" }).args,
    ["/own/main.js", "daemon"],
    "shim is already as new",
  );
  assert.equal(newerCurrent(stateDir, "1.2.0"), null);
  assert.equal(npxNext(stateDir, "1.1.0"), null);
});

test("stageNpm points current at the install and refuses a wrong integrity", async () => {
  const stateDir = tmpState();
  const install = async (dir: string) => {
    mkdirSync(join(dir, "node_modules", "hawl.ai", "dist"), {
      recursive: true,
    });
    writeFileSync(join(dir, "node_modules", "hawl.ai", "dist", "main.js"), "");
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({
        packages: { "node_modules/hawl.ai": { integrity: "sha512-good" } },
      }),
    );
  };
  await assert.rejects(
    stageNpm({ stateDir, version: "1.1.0", integrity: "sha512-bad", install }),
    /integrity/,
  );
  assert.equal(newerCurrent(stateDir, "1.0.0"), null);
  const c = await stageNpm({
    stateDir,
    version: "1.1.0",
    integrity: "sha512-good",
    install,
  });
  assert.equal(newerCurrent(stateDir, "1.0.0")?.entry, c.entry);
});

test("toolsNeedReconnect: only a changed name set needs a reconnect", () => {
  assert.equal(toolsNeedReconnect(["a", "b"], ["b", "a"]), false);
  assert.equal(toolsNeedReconnect(["a"], ["a", "c"]), true);
  assert.equal(toolsNeedReconnect(["a", "b"], ["a"]), true);
});

test("a source build (0.0.0) never stages a release over itself", async () => {
  // e2e and local helpers are 0.0.0: staging npm hawl.ai 30 s in swapped an older helper in
  // mid-run that did not know the session's agent ("unknown worker", staging journey step 6).
  let fetched = 0;
  let installed = 0;
  const r = await stageLatestNpm({
    stateDir: tmpState(),
    current: "0.0.0",
    fetchManifest: async () => {
      fetched++;
      return {};
    },
    install: async () => {
      installed++;
    },
  });
  assert.equal(r, "none");
  assert.equal(fetched, 0);
  assert.equal(installed, 0);
});
