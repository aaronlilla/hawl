import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findJoinedRoot, resolveRoute } from "./resolve.ts";

function join2(
  dir: string,
  memberships: { slug: string; workers: [string, string][] }[],
): void {
  mkdirSync(join(dir, ".hawl"), { recursive: true });
  writeFileSync(
    join(dir, ".hawl", "hawl.json"),
    JSON.stringify({
      v: 1,
      village_id: "vil_1",
      folder_label: "p",
      memberships: memberships.map((m, i) => ({
        town_id: `twn_${i}`,
        town_slug: m.slug,
        relay_url: "https://relay.hawl.ai",
        workers: m.workers.map(([rid, platform]) => ({
          resident_id: rid,
          platform,
          kid: "k",
        })),
      })),
      written: [],
      restore: [],
    }),
  );
}

test("walks up from a subfolder to the joined folder", () => {
  const root = mkdtempSync(join(tmpdir(), "hawl-route-"));
  join2(root, [{ slug: "acme", workers: [["res_A", "claude_code"]] }]);
  const deep = join(root, "a", "b", "c");
  mkdirSync(deep, { recursive: true });
  assert.equal(findJoinedRoot(deep), root);
  const r = resolveRoute(deep, { host: "claude_code", env: {} });
  assert.equal(r?.site_slug, "acme");
  assert.equal(r?.resident_id, "res_A");
  assert.equal(r?.source, "platform");
});

test("unmapped folder: no route", () => {
  const dir = mkdtempSync(join(tmpdir(), "hawl-route-"));
  assert.equal(resolveRoute(dir, { host: "codex", env: {} }), null);
});

test("nested joined folders: the nearest one wins", () => {
  const outer = mkdtempSync(join(tmpdir(), "hawl-route-"));
  join2(outer, [{ slug: "outer", workers: [["res_O", "codex"]] }]);
  const inner = join(outer, "pkg");
  join2(inner, [{ slug: "inner", workers: [["res_I", "codex"]] }]);
  assert.equal(
    resolveRoute(join(inner, "src"), { host: "codex", env: {} })?.site_slug,
    "inner",
  );
  assert.equal(
    resolveRoute(join(outer, "docs"), { host: "codex", env: {} })?.site_slug,
    "outer",
  );
});

test("one folder in two sites: the host's id file, then HAWL_SITE, then HAWL_RESIDENT_ID", () => {
  const root = mkdtempSync(join(tmpdir(), "hawl-route-"));
  join2(root, [
    { slug: "acme", workers: [["res_A", "claude_code"]] },
    {
      slug: "beta",
      workers: [
        ["res_B", "claude_code"],
        ["res_C", "codex"],
      ],
    },
  ]);
  const none = resolveRoute(root, { host: "claude_code", env: {} });
  assert.equal(none?.resident_id, "res_A");
  assert.equal(none?.ambiguous, true);

  writeFileSync(
    join(root, ".hawl", "claude_code.json"),
    JSON.stringify({ resident_id: "res_B" }),
  );
  const byFile = resolveRoute(root, { host: "claude_code", env: {} });
  assert.equal(byFile?.site_slug, "beta");
  assert.equal(byFile?.source, "id_file");

  const bySite = resolveRoute(root, {
    host: "claude_code",
    env: { HAWL_SITE: "acme" },
  });
  assert.equal(bySite?.resident_id, "res_A");
  assert.equal(bySite?.source, "env_site");

  const byId = resolveRoute(root, {
    host: "claude_code",
    env: { HAWL_SITE: "acme", HAWL_RESIDENT_ID: "res_C" },
  });
  assert.equal(byId?.resident_id, "res_C");
  assert.equal(byId?.source, "env_resident");

  // An override naming a worker this folder does not have is ignored.
  const foreign = resolveRoute(root, {
    host: "claude_code",
    env: { HAWL_RESIDENT_ID: "res_X" },
  });
  assert.equal(foreign?.resident_id, "res_B");
});

test("an unreadable town file is treated as not mapped", () => {
  const root = mkdtempSync(join(tmpdir(), "hawl-route-"));
  mkdirSync(join(root, ".hawl"));
  writeFileSync(join(root, ".hawl", "hawl.json"), "{not json");
  assert.equal(resolveRoute(root, { env: {} }), null);
});
