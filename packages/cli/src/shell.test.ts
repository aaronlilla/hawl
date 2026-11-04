import assert from "node:assert/strict";
import { test } from "node:test";
import { winCommandLine } from "./shell.ts";

test("winCommandLine joins plain words and quotes the awkward ones", () => {
  assert.equal(winCommandLine("hawl", ["daemon"]), "hawl daemon");
  assert.equal(winCommandLine("claude", []), "claude");
  assert.equal(
    winCommandLine("claude", ["mcp", "add", "my server", 'a"b']),
    'claude mcp add "my server" "a\\"b"',
  );
  assert.equal(winCommandLine("x", ["a&b"]), 'x "a&b"');
});
