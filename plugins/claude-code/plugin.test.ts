import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p: string) =>
  JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const manifest = read("./.claude-plugin/plugin.json");
const hooks = read("./hooks/hooks.json");
const market = read("./marketplace.json");

test("plugin.json has the required fields and wraps hawl mcp", () => {
  assert.equal(manifest.name, "hawl");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  // hooks/hooks.json loads by convention; listing it again makes Claude Code report a duplicate.
  assert.equal(manifest.hooks, undefined);
  assert.deepEqual(manifest.mcpServers.hawl, {
    command: "hawl",
    args: ["mcp", "--host", "claude_code"],
  });
});

test("hook commands match `hawl hook claude_code <event>` from CLI-2", () => {
  const events = Object.keys(hooks.hooks);
  assert.ok(events.includes("UserPromptSubmit"));
  assert.ok(events.includes("SessionStart"));
  // Stop and PostToolUse only fire for mail aimed at the agent; `hawl config stop-hook off` silences them.
  assert.ok(events.includes("Stop"));
  assert.ok(events.includes("PostToolUse"));
  for (const event of events) {
    const entries = hooks.hooks[event];
    // SessionStart and Stop also start the idle-wake waiter (an asyncRewake hook).
    const waits = event === "SessionStart" || event === "Stop";
    assert.equal(entries.length, waits ? 2 : 1);
    assert.equal(entries[0].hooks.length, 1);
    assert.deepEqual(entries[0].hooks[0], {
      type: "command",
      command: `hawl hook claude_code ${event}`,
    });
    if (waits)
      assert.deepEqual(entries[1].hooks, [
        {
          type: "command",
          command: "hawl hook claude_code Wake",
          asyncRewake: true,
          timeout: 86400,
        },
      ]);
  }
});

test("marketplace lists the plugin with a matching name and version", () => {
  assert.equal(typeof market.name, "string");
  assert.ok(market.owner?.name);
  assert.equal(market.plugins.length, 1);
  const [p] = market.plugins;
  assert.equal(p.name, manifest.name);
  assert.equal(p.version, manifest.version);
  assert.equal(p.source, "./");
});
