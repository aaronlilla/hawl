import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REMOVED_TEXT } from "../daemon/ws.ts";
import { addWorker, readTownFile, newTownFile, writeTownFile } from "../town-file.ts";
import { agentSection, doctor, doctorChecks, TIP_PREFIX } from "./doctor.ts";
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

function folderWithMember(): { dir: string; state: string } {
  const dir = mkdtempSync(join(tmpdir(), "hawl-doc-"));
  const state = mkdtempSync(join(tmpdir(), "hawl-doc-state-"));
  const t = newTownFile("shop");
  t.memberships.push({
    town_id: "twn_1",
    town_slug: "shop",
    relay_url: "http://127.0.0.1:9",
    workers: [{ resident_id: "res_1", platform: "claude_code", kid: "k1" }],
  });
  writeTownFile(dir, t);
  return { dir, state };
}
const daemonCheck = (cs: { name: string; state: string; detail: string }[]) =>
  cs.find((c) => c.name === "daemon");
const quiet = {
  print: () => {},
  fetch: (async () => new Response("{}")) as typeof fetch,
};
const noKeys = { get: async () => null, kind: "test" } as never;

test("doctor says the exact command that starts a stopped helper", async () => {
  const { dir, state } = folderWithMember();
  const r = await doctor(
    { projectDir: dir },
    {
      ...quiet,
      stateDir: state,
      keyStore: noKeys,
      daemon: () => ({ call: async () => Promise.reject(new Error("down")) }),
    },
  );
  const d = daemonCheck(r.checks);
  assert.equal(d?.state, "fail");
  assert.match(d?.detail ?? "", /run `hawl doctor --fix` to start it/);
});

test("doctor --fix starts a stopped helper and reports it running", async () => {
  const { dir, state } = folderWithMember();
  let up = false;
  let started = 0;
  const r = await doctor(
    { projectDir: dir, fix: true },
    {
      ...quiet,
      stateDir: state,
      keyStore: noKeys,
      ensureDaemon: async () => {
        started++;
        up = true;
      },
      daemon: () => ({
        call: async () =>
          up
            ? { pid: 4242, version: "9.9.9" }
            : Promise.reject(new Error("down")),
      }),
    },
  );
  const d = daemonCheck(r.checks);
  assert.equal(started, 1);
  assert.equal(d?.state, "ok");
  assert.match(d?.detail ?? "", /started it \(pid 4242 v9\.9\.9\)/);
});

test("doctor --fix leaves a running helper alone and says when it will not start", async () => {
  const { dir, state } = folderWithMember();
  let started = 0;
  const running = await doctor(
    { projectDir: dir, fix: true },
    {
      ...quiet,
      stateDir: state,
      keyStore: noKeys,
      ensureDaemon: async () => {
        started++;
      },
      daemon: () => ({ call: async () => ({ pid: 1, version: "1.0.0" }) }),
    },
  );
  assert.equal(started, 0);
  assert.equal(daemonCheck(running.checks)?.detail, "pid 1 v1.0.0");
  const stuck = await doctor(
    { projectDir: dir, fix: true },
    {
      ...quiet,
      stateDir: state,
      keyStore: noKeys,
      ensureDaemon: async () => {
        throw new Error("no");
      },
      daemon: () => ({ call: async () => Promise.reject(new Error("down")) }),
    },
  );
  assert.equal(daemonCheck(stuck.checks)?.state, "fail");
  assert.match(daemonCheck(stuck.checks)?.detail ?? "", /would not start/);
});

test("an untrusted Codex folder is a manual step, not a failure", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "hawl-doctor-codex-"));
  const t = newTownFile("proj");
  addWorker(
    t,
    { town_id: "tn_1", town_slug: "acme", relay_url: "https://relay.hawl.ai" },
    { resident_id: "res_1", platform: "codex", kid: "k" },
  );
  t.written.push({
    path: ".codex/config.toml",
    key: "mcp_servers.hawl",
    sha256: "x",
    resident_id: "res_1",
  });
  writeTownFile(projectDir, t);
  mkdirSync(join(projectDir, ".codex"), { recursive: true });
  writeFileSync(
    join(projectDir, ".codex/config.toml"),
    '[mcp_servers.hawl]'+String.fromCharCode(10)+'command = "hawl"',
  );
  const codexHome = mkdtempSync(join(tmpdir(), "hawl-codexhome-"));
  const checks = await doctorChecks(
    { projectDir, codexHome },
    { stateDir: projectDir, home: projectDir },
  );
  const trust = checks.find((c) => c.name === "codex trust");
  assert.equal(trust?.state, "manual");
  assert.match(trust?.detail ?? "", /trust this folder in Codex/);
});

test("doctor says plainly when the relay removed this folder's agent", async () => {
  const { dir, state } = folderWithMember();
  const town = readTownFile(dir);
  const rid = town?.memberships[0]?.workers[0]?.resident_id as string;
  const r = await doctor(
    { projectDir: dir },
    {
      ...quiet,
      stateDir: state,
      keyStore: noKeys,
      daemon: () => ({
        call: async () => ({
          pid: 1,
          version: "0.0.0",
          workers: [{ resident_id: rid, refused: REMOVED_TEXT }],
        }),
      }),
    },
  );
  const c = r.checks.find((x) => x.name === "agent access");
  assert.equal(c?.state, "fail");
  assert.equal(c?.detail, REMOVED_TEXT);
  assert.equal(r.exitCode, 1);
});
