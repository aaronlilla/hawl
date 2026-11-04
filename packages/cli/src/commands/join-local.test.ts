import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { tmpState } from "../daemon/testkit.ts";
import { joinLocal, leaveLocal, localMemberships } from "./join-local.ts";

test("join --local in a Codex folder writes the hawl table and keeps the user's", async () => {
  const project = tmpState();
  mkdirSync(join(project, ".codex"));
  writeFileSync(
    join(project, ".codex", "config.toml"),
    '[mcp_servers.other]\ncommand = "y"\n',
  );
  const r = await joinLocal({
    projectDir: project,
    handle: "@cx",
    host: "codex",
    dir: tmpState(),
  });
  assert.equal(r.config, join(project, ".codex", "config.toml"));
  const doc = parseToml(readFileSync(r.config, "utf8")) as Record<string, any>;
  assert.equal(doc.mcp_servers.other.command, "y");
  assert.deepEqual(doc.mcp_servers.hawl.args, [
    "-y",
    "hawl.ai",
    "mcp",
    "--host",
    "codex",
    "--local",
  ]);
  assert.ok(existsSync(join(project, ".hawl", "codex.json")));
});

test("leave undoes a local join: the hawl entry goes, the user's servers and files stay", async () => {
  const project = tmpState();
  writeFileSync(
    join(project, ".mcp.json"),
    JSON.stringify({ mcpServers: { other: { command: "y" } } }),
  );
  await joinLocal({ projectDir: project, handle: "@a", dir: tmpState() });
  assert.equal(localMemberships(project).length, 1);
  const left = leaveLocal(project);
  assert.equal(left.length, 1);
  const doc = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(doc.mcpServers), ["other"]);
  assert.equal(existsSync(join(project, ".hawl", "claude_code.json")), false);
  assert.equal(localMemberships(project).length, 0);
  assert.deepEqual(leaveLocal(project), []);
});

test("leave in a Codex folder removes only the hawl table", async () => {
  const project = tmpState();
  mkdirSync(join(project, ".codex"));
  writeFileSync(
    join(project, ".codex", "config.toml"),
    '[mcp_servers.other]\ncommand = "y"\n',
  );
  await joinLocal({
    projectDir: project,
    handle: "@cx",
    host: "codex",
    dir: tmpState(),
  });
  leaveLocal(project);
  const doc = parseToml(
    readFileSync(join(project, ".codex", "config.toml"), "utf8"),
  ) as Record<string, any>;
  assert.equal(doc.mcp_servers.other.command, "y");
  assert.equal(doc.mcp_servers.hawl, undefined);
});

test("local join names malformed JSON and preserves the config without joining", async () => {
  const projectDir = tmpState();
  const dir = tmpState();
  const config = join(projectDir, ".mcp.json");
  writeFileSync(config, "{oops");
  await assert.rejects(
    joinLocal({ projectDir, dir, handle: "@broken" }),
    /\.mcp\.json is not valid JSON/,
  );
  assert.equal(readFileSync(config, "utf8"), "{oops");
  assert.equal(localMemberships(projectDir).length, 0);
  assert.equal(existsSync(join(dir, "keys")), false);
});
