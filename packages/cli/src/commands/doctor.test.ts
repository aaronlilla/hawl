import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentSection, doctor, TIP_PREFIX } from "./doctor.ts";
import { joinLocal } from "./join-local.ts";

test("local doctor detects and repairs a missing hawl entry without replacing other servers", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "hawl-doctor-local-"));
  const stateDir = mkdtempSync(join(tmpdir(), "hawl-doctor-state-"));
  const joined = await joinLocal({
    projectDir,
    dir: stateDir,
    handle: "@repair",
  });
  const config = join(projectDir, ".mcp.json");
  writeFileSync(
    config,
    JSON.stringify({ mcpServers: { other: { command: "other" } } }),
  );
  const deps = { stateDir, print: () => {} };
  assert.equal((await doctor({ projectDir }, deps)).exitCode, 1);
  assert.equal((await doctor({ projectDir, fix: true }, deps)).exitCode, 0);
  assert.equal((await doctor({ projectDir }, deps)).exitCode, 0);
  const doc = JSON.parse(readFileSync(config, "utf8"));
  assert.equal(doc.mcpServers.other.command, "other");
  assert.ok(doc.mcpServers.hawl.args.includes("--local"));
  assert.equal(
    JSON.parse(readFileSync(join(projectDir, ".hawl/claude_code.json"), "utf8"))
      .resident_id,
    joined.resident_id,
  );
});

test("local doctor reports malformed config and does not overwrite it with --fix", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "hawl-doctor-invalid-"));
  const stateDir = mkdtempSync(join(tmpdir(), "hawl-doctor-state-"));
  await joinLocal({ projectDir, dir: stateDir, handle: "@invalid" });
  const config = join(projectDir, ".mcp.json");
  writeFileSync(config, "{oops");
  assert.equal(
    (await doctor({ projectDir, fix: true }, { stateDir, print: () => {} }))
      .exitCode,
    1,
  );
  assert.equal(readFileSync(config, "utf8"), "{oops");
});

test("local doctor repairs missing Codex and Cursor entries while keeping the other server", async () => {
  for (const host of ["codex", "cursor"] as const) {
    const projectDir = mkdtempSync(join(tmpdir(), "hawl-doctor-host-"));
    const stateDir = mkdtempSync(join(tmpdir(), "hawl-doctor-state-"));
    const joined = await joinLocal({
      projectDir,
      dir: stateDir,
      handle: "@repair",
      host,
    });
    const before =
      host === "codex"
        ? '[mcp_servers.other]\ncommand = "other"\n'
        : '{"mcpServers":{"other":{"command":"other"}}}';
    writeFileSync(joined.config, before);
    const deps = { stateDir, print: () => {} };
    assert.equal((await doctor({ projectDir }, deps)).exitCode, 1);
    assert.equal((await doctor({ projectDir, fix: true }, deps)).exitCode, 0);
    const after = readFileSync(joined.config, "utf8");
    assert.ok(after.includes("other"));
    assert.ok(after.includes("--local"));
  }
});

test("agent with no tips gets one calm line", () => {
  assert.deepEqual(agentSection([{ handle: "ana", tips: [] }]), [
    "Agents",
    "  ana: nothing to fix.",
  ]);
});

test("no agents says so", () => {
  assert.deepEqual(agentSection([]), ["Agents", "  No agents yet."]);
});

test("tips show the fixed prefix and whether the agent has seen them", () => {
  const out = agentSection([
    {
      handle: "ana",
      tips: [
        { text: "Answer every item.", shown: true },
        { text: "Change the arguments.", shown: false },
      ],
    },
  ]);
  assert.equal(out[2], `    ${TIP_PREFIX} Answer every item.`);
  assert.equal(
    out[3],
    `    ${TIP_PREFIX} Change the arguments. (not shown yet)`,
  );
});

async function run(agentTips?: () => Promise<never[]>) {
  const lines: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "hawl-doctor-"));
  const r = await doctor(
    { projectDir: dir },
    { print: (l) => lines.push(l), ...(agentTips ? { agentTips } : {}) },
  );
  return { lines, r };
}

test("doctor prints the Agents block after the checks when a tips source exists", async () => {
  const { lines } = await run(async () => []);
  assert.equal(lines.length, 2);
  assert.match(lines[1] as string, /^Agents\n {2}No agents yet\.$/);
});

test("doctor leaves the block out with no tips source", async () => {
  const { lines } = await run();
  assert.equal(lines.length, 1);
});

test("a failing tips source says so and keeps the exit code", async () => {
  const { lines, r } = await run(async () => {
    throw new Error("relay down");
  });
  assert.match(lines[1] as string, /not available right now: relay down/);
  assert.equal(r.exitCode, 1);
});
