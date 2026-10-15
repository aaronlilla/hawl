import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateWorkerKey, MemoryKeyStore } from "../daemon/keys.ts";
import {
  addWorker,
  newTownFile,
  readTownFile,
  writeTownFile,
} from "../town-file.ts";
import { wake } from "./wake.ts";

const RELAY = "https://relay.test";
const RID = "wrk_01TEST";

async function world(withMembership = true) {
  const root = mkdtempSync(join(tmpdir(), "hawl-wake-"));
  const projectDir = join(root, "app");
  mkdirSync(projectDir, { recursive: true });
  const key = generateWorkerKey();
  const keyStore = new MemoryKeyStore();
  await keyStore.set(RID, key.privateJwk);
  if (withMembership) {
    const town = newTownFile("app");
    addWorker(
      town,
      { town_id: "twn_01TEST", town_slug: "acme", relay_url: RELAY },
      { resident_id: RID, platform: "codex", kid: key.kid },
    );
    writeTownFile(projectDir, town);
  }
  const lines: string[] = [];
  return { projectDir, keyStore, lines, print: (l: string) => lines.push(l) };
}

const json = (code: number, v: unknown) =>
  new Response(JSON.stringify(v), {
    status: code,
    headers: { "content-type": "application/json" },
  });

test("wake on then off is saved in this folder", async () => {
  const w = await world();
  const siteWake = async () => true;
  await wake({ projectDir: w.projectDir, on: true }, { ...w, siteWake });
  assert.equal(readTownFile(w.projectDir)?.wake, true);
  assert.deepEqual(w.lines, ["wake on"]);
  await wake({ projectDir: w.projectDir, on: false }, { ...w, siteWake });
  assert.equal(readTownFile(w.projectDir)?.wake, false);
});

test("wake on is refused with the reason when the site owner turned it off", async () => {
  const w = await world();
  await assert.rejects(
    wake(
      { projectDir: w.projectDir, on: true },
      { ...w, siteWake: async () => false },
    ),
    /owner of acme turned wake off for the whole site/,
  );
  assert.notEqual(readTownFile(w.projectDir)?.wake, true);
});

test("wake off is never refused", async () => {
  const w = await world();
  await wake(
    { projectDir: w.projectDir, on: false },
    { ...w, siteWake: async () => false },
  );
  assert.equal(readTownFile(w.projectDir)?.wake, false);
});

test("the relay's wake_enabled=false switch refuses; an unreadable switch allows", async () => {
  const off = await world();
  const fetchOff = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/token")) return json(200, { access_token: "t" });
    assert.equal(url, `${RELAY}/v1/towns/twn_01TEST/settings/switches`);
    return json(200, { wake_enabled: false });
  }) as typeof fetch;
  await assert.rejects(
    wake({ projectDir: off.projectDir, on: true }, { ...off, fetch: fetchOff }),
    /turned wake off/,
  );

  const unknown = await world();
  const fetchNo = (async (input: unknown) =>
    String(input).endsWith("/v1/auth/token")
      ? json(200, { access_token: "t" })
      : json(404, { error: "not_found" })) as typeof fetch;
  await wake(
    { projectDir: unknown.projectDir, on: true },
    { ...unknown, fetch: fetchNo },
  );
  assert.equal(readTownFile(unknown.projectDir)?.wake, true);
});

test("wake needs a membership", async () => {
  const w = await world(false);
  await assert.rejects(
    wake({ projectDir: w.projectDir, on: false }, w),
    /no hawl membership/,
  );
});
