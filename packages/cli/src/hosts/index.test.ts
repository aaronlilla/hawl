import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectHosts, HOSTS, isHost, JOIN_HOSTS } from "./index.ts";
import { applyPlan } from "./merge.ts";
import { OTHER_SNIPPET } from "./other.ts";

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "hawl-idx-"));
  const projectDir = join(root, "proj");
  const home = join(root, "home");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { projectDir, home };
}

test("detectHosts: none, one, and two tools, likeliest first", () => {
  const d = dirs();
  assert.deepEqual(
    detectHosts(d, () => false),
    [],
  );
  mkdirSync(join(d.projectDir, ".cursor"));
  assert.deepEqual(
    detectHosts(d, () => false),
    ["cursor"],
  );
  mkdirSync(join(d.home, ".claude"));
  assert.deepEqual(
    detectHosts(d, () => false),
    ["claude_code", "cursor"],
  );
  assert.deepEqual(
    detectHosts(dirs(), (n) => n === "codex"),
    ["codex"],
  );
});

test("other is a join host and writes only .hawl/other.json", () => {
  assert.ok(isHost("other"));
  assert.ok(JOIN_HOSTS.includes("other"));
  assert.ok(!isHost("windsurf"));
  const d = dirs();
  const plans = HOSTS.other.plan({
    ...d,
    residentId: "res_TEST",
    otlpPort: 4318,
  });
  assert.deepEqual(
    plans.map((p) => p.path),
    [".hawl/other.json"],
  );
  for (const p of plans)
    applyPlan(p, { projectDir: d.projectDir, stateDir: d.home });
  assert.match(
    readFileSync(join(d.projectDir, ".hawl", "other.json"), "utf8"),
    /res_TEST/,
  );
  assert.deepEqual(JSON.parse(OTHER_SNIPPET).mcpServers.hawl.args, [
    "mcp",
    "--host",
    "other",
  ]);
});
