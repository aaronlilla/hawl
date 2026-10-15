import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CLAUDE_MCP_ADD_ARGS,
  CLAUDE_MCP_REMOVE_ARGS,
  installUserScope,
  type RunResult,
  readUserScope,
  removeUserScope,
  type UserScopeDeps,
} from "./user-scope.ts";

function box(extra: Partial<UserScopeDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "hawl-us-"));
  const home = join(root, "home");
  const stateDir = join(home, ".hawl");
  mkdirSync(stateDir, { recursive: true });
  const calls: string[][] = [];
  let mcpExists = false;
  const runClaude = (args: string[]): RunResult => {
    calls.push(args);
    const ok = { status: 0, stdout: "", stderr: "" };
    if (args[1] === "get")
      return mcpExists ? ok : { status: 1, stdout: "", stderr: "none" };
    if (args[1] === "add") mcpExists = true;
    if (args[1] === "remove") mcpExists = false;
    return ok;
  };
  const deps: UserScopeDeps = {
    home,
    stateDir,
    env: {},
    has: () => true,
    runClaude,
    ...extra,
  };
  return {
    root,
    home,
    stateDir,
    deps,
    calls,
    setExists: (v: boolean) => {
      mcpExists = v;
    },
  };
}

const read = (f: string) => readFileSync(f, "utf8");

test("install writes Claude and Codex hooks with --scope user and adds the MCP server", () => {
  const b = box();
  const r = installUserScope(b.deps);
  assert.equal(r.mcp, "added");
  const s = JSON.parse(read(join(b.home, ".claude", "settings.json")));
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(
    s.hooks.SessionStart[0].hooks[0].command,
    "hawl hook claude_code SessionStart --scope user",
  );
  assert.equal(s.env, undefined);
  const t = read(join(b.home, ".codex", "config.toml"));
  assert.match(t, /\[mcp_servers\.hawl\]/);
  assert.match(t, /command = "hawl hook codex PostToolUse --scope user"/);
  assert.deepEqual(b.calls.at(-1), CLAUDE_MCP_ADD_ARGS);
  assert.deepEqual(CLAUDE_MCP_ADD_ARGS.slice(0, 6), [
    "mcp",
    "add",
    "--scope",
    "user",
    "hawl",
    "--",
  ]);
  assert.equal(readUserScope(b.stateDir)?.claude_mcp, true);
});

test("install twice changes nothing and adds no duplicates", () => {
  const b = box();
  installUserScope(b.deps);
  const a = read(join(b.home, ".claude", "settings.json"));
  const x = read(join(b.home, ".codex", "config.toml"));
  const st = read(join(b.stateDir, "user-scope.json"));
  const r = installUserScope(b.deps);
  assert.equal(read(join(b.home, ".claude", "settings.json")), a);
  assert.equal(read(join(b.home, ".codex", "config.toml")), x);
  assert.equal(r.files.length, 0);
  assert.equal(r.mcp, "exists");
  assert.equal(b.calls.filter((c) => c[1] === "add").length, 1);
  // The second run must not forget that we added the MCP server.
  assert.equal(readUserScope(b.stateDir)?.claude_mcp, true);
  assert.equal(read(join(b.stateDir, "user-scope.json")), st);
});

test("existing user hooks and settings are kept; removal leaves foreign entries", () => {
  const b = box();
  mkdirSync(join(b.home, ".claude"), { recursive: true });
  mkdirSync(join(b.home, ".codex"), { recursive: true });
  const own = { hooks: [{ type: "command", command: "mine" }] };
  writeFileSync(
    join(b.home, ".claude", "settings.json"),
    JSON.stringify({ theme: "dark", hooks: { PreToolUse: [own] } }),
  );
  const toml = '# mine\nmodel = "x"\n\n[mcp_servers.other]\ncommand = "o"\n';
  writeFileSync(join(b.home, ".codex", "config.toml"), toml);
  installUserScope(b.deps);
  const s = JSON.parse(read(join(b.home, ".claude", "settings.json")));
  assert.equal(s.theme, "dark");
  assert.deepEqual(s.hooks.PreToolUse[0], own);
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.ok(read(join(b.home, ".codex", "config.toml")).startsWith(toml));

  const out = removeUserScope(b.deps);
  assert.equal(out.mcp, "removed");
  assert.deepEqual(b.calls.at(-1), CLAUDE_MCP_REMOVE_ARGS);
  const after = JSON.parse(read(join(b.home, ".claude", "settings.json")));
  assert.deepEqual(after, { theme: "dark", hooks: { PreToolUse: [own] } });
  assert.equal(read(join(b.home, ".codex", "config.toml")), toml);
  assert.equal(existsSync(join(b.stateDir, "user-scope.json")), false);
});

test("removal of files we created deletes them", () => {
  const b = box();
  installUserScope(b.deps);
  removeUserScope(b.deps);
  assert.equal(existsSync(join(b.home, ".claude", "settings.json")), false);
  assert.equal(existsSync(join(b.home, ".codex", "config.toml")), false);
});

test("an entry the user changed since we wrote it is kept", () => {
  const b = box();
  installUserScope(b.deps);
  const f = join(b.home, ".claude", "settings.json");
  const s = JSON.parse(read(f));
  s.hooks.SessionEnd[0].hooks[0].command = "edited";
  s.extra = 1;
  writeFileSync(f, JSON.stringify(s));
  const out = removeUserScope(b.deps);
  assert.ok(out.kept.some((k) => k.includes("hooks.SessionEnd")));
  const after = JSON.parse(read(f));
  assert.equal(after.hooks.SessionEnd[0].hooks[0].command, "edited");
  assert.equal(after.hooks.PreToolUse, undefined);
  assert.equal(after.extra, 1);
});

test("claude CLI absent: hooks still written, MCP skipped with a note", () => {
  const b = box({ has: (n) => n !== "claude" });
  mkdirSync(join(b.home, ".claude"), { recursive: true });
  const r = installUserScope(b.deps);
  assert.equal(r.mcp, "no-cli");
  assert.ok(r.notes.some((n) => n.includes("not on PATH")));
  assert.equal(b.calls.length, 0);
  assert.ok(existsSync(join(b.home, ".claude", "settings.json")));
  assert.equal(readUserScope(b.stateDir)?.claude_mcp, false);
  removeUserScope(b.deps);
  assert.equal(b.calls.length, 0);
});

test("an existing hawl MCP server at user scope is left and not removed later", () => {
  const b = box();
  b.setExists(true);
  const r = installUserScope(b.deps);
  assert.equal(r.mcp, "exists");
  assert.equal(
    b.calls.some((c) => c[1] === "add"),
    false,
  );
  removeUserScope(b.deps);
  assert.equal(
    b.calls.some((c) => c[1] === "remove"),
    false,
  );
});

test("a failing claude CLI is reported, not thrown", () => {
  const b = box({
    runClaude: (a) =>
      a[1] === "get"
        ? { status: 1, stdout: "", stderr: "" }
        : { status: 2, stdout: "", stderr: "boom\nmore" },
  });
  const r = installUserScope(b.deps);
  assert.equal(r.mcp, "failed");
  assert.ok(r.notes[0]?.includes("boom"));
  const thrower = box({
    runClaude: () => {
      throw new Error("spawn claude ENOENT");
    },
  });
  assert.equal(installUserScope(thrower.deps).mcp, "failed");
});

test("CLAUDE_CONFIG_DIR and CODEX_HOME are honoured", () => {
  const b = box();
  const cdir = join(b.root, "cc");
  const xdir = join(b.root, "cx");
  const deps = {
    ...b.deps,
    env: { CLAUDE_CONFIG_DIR: cdir, CODEX_HOME: xdir },
  };
  installUserScope(deps);
  assert.ok(existsSync(join(cdir, "settings.json")));
  assert.ok(existsSync(join(xdir, "config.toml")));
  assert.equal(existsSync(join(b.home, ".claude")), false);
  assert.equal(existsSync(join(b.home, ".codex")), false);
  removeUserScope(deps);
  assert.equal(existsSync(join(cdir, "settings.json")), false);
  assert.equal(existsSync(join(xdir, "config.toml")), false);
});

test("a tool that is not installed gets no files", () => {
  const b = box({ has: (n) => n === "claude" });
  installUserScope(b.deps);
  assert.ok(existsSync(join(b.home, ".claude", "settings.json")));
  assert.equal(existsSync(join(b.home, ".codex")), false);
});

test("a settings file that is not JSON is left alone and reported", () => {
  const b = box();
  mkdirSync(join(b.home, ".claude"), { recursive: true });
  writeFileSync(join(b.home, ".claude", "settings.json"), "{ // nope");
  const r = installUserScope(b.deps);
  assert.ok(r.skipped.length > 0);
  assert.equal(read(join(b.home, ".claude", "settings.json")), "{ // nope");
});
