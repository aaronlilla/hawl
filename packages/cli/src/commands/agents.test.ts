import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addWorker, newTownFile, writeTownFile } from "../town-file.ts";
import { agents, agentsReport, findJoinedRoot } from "./agents.ts";
import { joinLocal } from "./join-local.ts";

const NOW = new Date("2026-10-13T12:00:00Z");
const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 3600e3).toISOString();

function joined(opts: { settings?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hawl-agents-"));
  const t = newTownFile("proj");
  addWorker(
    t,
    { town_id: "tn_1", town_slug: "acme", relay_url: "https://relay.hawl.ai" },
    { resident_id: "res_1", platform: "claude_code", kid: "k" },
  );
  t.written.push(
    {
      path: ".mcp.json",
      key: "mcpServers.hawl",
      sha256: "x",
      resident_id: "res_1",
    },
    {
      path: ".claude/settings.local.json",
      key: "hooks.PreToolUse[]",
      sha256: "x",
      resident_id: "res_1",
    },
  );
  writeTownFile(dir, t);
  writeFileSync(join(dir, ".mcp.json"), '{"mcpServers":{"hawl":{}}}');
  mkdirSync(join(dir, ".claude"), { recursive: true });
  if (opts.settings !== false)
    writeFileSync(
      join(dir, ".claude/settings.local.json"),
      '{"hooks":{"PreToolUse":[]}}',
    );
  return dir;
}

const sess = (
  root: string,
  via: "hook" | "mcp",
  h = 1,
  host = "claude_code",
) => ({
  host,
  root,
  via,
  first_seen: hoursAgo(h),
  last_seen: hoursAgo(h),
});
const base = (dir: string, sessions?: unknown[], extra = {}) => ({
  home: dir,
  stateDir: dir,
  now: () => NOW,
  detect: () => [],
  request: async () => {
    if (!sessions) throw new Error("ECONNREFUSED");
    return { sessions };
  },
  ...extra,
});
const first = async (dir: string, sessions?: unknown[]) =>
  (await agentsReport({ cwd: dir }, base(dir, sessions))).hosts[0];

test("not joined exits 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hawl-agents-"));
  const lines: string[] = [];
  const r = await agents(
    { cwd: dir },
    { ...base(dir, []), print: (l) => lines.push(l) },
  );
  assert.equal(r.exitCode, 1);
  assert.match(lines[0] as string, /has not joined/);
});

test("finds the joined root from a subfolder", () => {
  const dir = joined();
  mkdirSync(join(dir, "a/b"), { recursive: true });
  assert.equal(findJoinedRoot(join(dir, "a/b")), dir);
});

test("hooked: hook and mcp seen in this root", async () => {
  const dir = joined();
  const h = await first(dir, [sess(dir, "hook"), sess(dir, "mcp")]);
  assert.equal(h?.state, "hooked");
});

test("sessions from other roots or older than 7 days do not count", async () => {
  const dir = joined();
  const h = await first(dir, [
    sess("/elsewhere", "hook"),
    sess(dir, "mcp", 24 * 8),
  ]);
  assert.equal(h?.state, "configured_not_seen");
  assert.match(h?.detail ?? "", /Start Claude Code in this folder/);
});

test("partial names what is missing", async () => {
  const dir = joined();
  const h = await first(dir, [sess(dir, "mcp")]);
  assert.equal(h?.state, "partial");
  assert.match(h?.detail ?? "", /no hook events/);
  const h2 = await first(dir, [sess(dir, "hook")]);
  assert.match(h2?.detail ?? "", /no MCP connection/);
});

test("broken when a config entry is gone", async () => {
  const dir = joined({ settings: false });
  const r = await agentsReport({ cwd: dir }, base(dir, []));
  assert.equal(r.hosts[0]?.state, "broken");
  assert.equal(r.ok, false);
});

test("daemon down still shows config and exits 0", async () => {
  const dir = joined();
  const lines: string[] = [];
  const r = await agents(
    { cwd: dir },
    { ...base(dir), print: (l) => lines.push(l) },
  );
  assert.equal(r.exitCode, 0);
  assert.equal(r.report.daemon.running, false);
  assert.match(
    lines[0] as string,
    /daemon not running: start any agent here or run `hawl daemon`/,
  );
  assert.match(
    lines[0] as string,
    /Site acme via relay\.hawl\.ai: claude_code:res_1/,
  );
});

test("detected but unconfigured host is not hooked", async () => {
  const dir = joined();
  const r = await agentsReport(
    { cwd: dir },
    base(dir, [], { detect: () => ["cursor"] }),
  );
  const c = r.hosts.find((x) => x.host === "cursor");
  assert.equal(c?.state, "not_hooked");
  assert.match(c?.detail ?? "", /hawl join --host cursor/);
  assert.equal(r.ok, true);
});

test("--json prints the structured report", async () => {
  const dir = joined();
  const lines: string[] = [];
  const r = await agents(
    { cwd: dir, json: true },
    { ...base(dir, []), print: (l) => lines.push(l) },
  );
  assert.equal(
    JSON.parse(lines[0] as string).hosts[0].state,
    "configured_not_seen",
  );
  assert.equal(r.exitCode, 0);
});

test("local agents finds membership from subfolders and reports broken config", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "hawl-local-agents-"));
  const dir = mkdtempSync(join(tmpdir(), "hawl-local-state-"));
  await joinLocal({ projectDir, dir, handle: "@local" });
  const child = join(projectDir, "child");
  mkdirSync(child);
  const good = await agentsReport({ cwd: child });
  assert.equal(good.joined, true);
  assert.equal(good.root, projectDir);
  assert.equal(good.route[0].site, "local");
  assert.equal(good.ok, true);
  rmSync(join(projectDir, ".mcp.json"));
  const bad = await agentsReport({ cwd: child });
  assert.equal(bad.ok, false);
  assert.equal(bad.hosts[0].state, "broken");
});
