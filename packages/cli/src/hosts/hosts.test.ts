import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { HOSTS, type HostId } from "./index.ts";
import {
  applyPlan,
  type FilePlan,
  previewPlan,
  type RestoreRecord,
  removeEntries,
  type WrittenEntry,
} from "./merge.ts";
import type { HostCtx } from "./types.ts";

const FIX = join(import.meta.dirname, "fixtures");

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "hawl-hosts-"));
  const projectDir = join(root, "proj");
  const home = join(root, "home");
  const stateDir = join(root, "state");
  for (const d of [projectDir, home, stateDir])
    mkdirSync(d, { recursive: true });
  const ctx: HostCtx = {
    projectDir,
    home,
    residentId: "res_TEST",
    otlpPort: 4318,
  };
  return {
    root,
    projectDir,
    home,
    stateDir,
    ctx,
    dirs: { projectDir, stateDir },
  };
}

function seed(base: string, rel: string, fixture: string) {
  const to = join(base, rel);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(FIX, fixture), to);
  return to;
}

function install(host: HostId, sb: ReturnType<typeof sandbox>) {
  const plans = HOSTS[host].plan(sb.ctx);
  const restore: RestoreRecord[] = [];
  for (const p of plans) {
    const r = applyPlan(p, sb.dirs);
    if (r) restore.push(r);
  }
  return { plans, restore };
}

function uninstall(
  plans: FilePlan[],
  restore: RestoreRecord[],
  sb: ReturnType<typeof sandbox>,
) {
  for (const p of plans) {
    const entries: WrittenEntry[] = p.entries;
    if (!entries.length) continue;
    removeEntries(
      p.abs,
      p.path,
      entries,
      restore.find((r) => r.path === p.path),
      sb.dirs,
    );
  }
}

const bytes = (f: string) => readFileSync(f);

test("claude_code: merge keeps other servers and hooks, and uninstall returns the original bytes", () => {
  const sb = sandbox();
  const mcp = seed(sb.projectDir, ".mcp.json", "mcp-four-space.json");
  const local = seed(
    sb.projectDir,
    ".claude/settings.local.json",
    "claude-local-existing.json",
  );
  const user = seed(
    sb.home,
    ".claude/settings.json",
    "claude-user-existing.json",
  );
  const before = [mcp, local, user].map(bytes);

  const { plans, restore } = install("claude_code", sb);
  const doc = JSON.parse(readFileSync(mcp, "utf8"));
  assert.equal(doc.mcpServers.other.command, "x");
  assert.deepEqual(doc.mcpServers.hawl.args, ["mcp", "--host", "claude_code"]);
  const hooks = JSON.parse(readFileSync(local, "utf8")).hooks;
  assert.equal(
    hooks.UserPromptSubmit.length,
    2,
    "our group is added beside the user's",
  );
  assert.equal(hooks.UserPromptSubmit[0].hooks[0].command, "echo mine");
  for (const e of [
    "SessionStart",
    "SubagentStart",
    "SubagentStop",
    "PreToolUse",
    "PostToolUse",
    "Stop",
  ])
    assert.equal(hooks[e][0].hooks[0].command, `hawl hook claude_code ${e}`);
  assert.equal(doc.mcpServers.hawl.env, undefined, "no id in the shared file");
  assert.deepEqual(bytes(user), before[2], "user settings are untouched");
  const env = JSON.parse(readFileSync(local, "utf8")).env;
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, "http://127.0.0.1:4318");
  assert.equal(env.OTEL_LOG_USER_PROMPTS, "0", "prompt logging stays off");

  uninstall(plans, restore, sb);
  assert.deepEqual([mcp, local, user].map(bytes), before);
});

test("claude_code: files we created are deleted again, including empty dirs", () => {
  const sb = sandbox();
  const { plans, restore } = install("claude_code", sb);
  assert.ok(existsSync(join(sb.projectDir, ".mcp.json")));
  assert.ok(existsSync(join(sb.projectDir, ".hawl", "claude_code.json")));
  uninstall(plans, restore, sb);
  assert.equal(existsSync(join(sb.projectDir, ".mcp.json")), false);
  assert.equal(existsSync(join(sb.projectDir, ".hawl")), false);
  assert.equal(existsSync(join(sb.projectDir, ".claude")), false);
  assert.equal(existsSync(join(sb.home, ".claude", "settings.json")), false);
});

test("claude_code: a changed value is never overwritten and never removed", () => {
  const sb = sandbox();
  const local = join(sb.projectDir, ".claude", "settings.local.json");
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(
    local,
    JSON.stringify(
      { env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://mine:4318" } },
      null,
      2,
    ),
  );
  const plans = HOSTS.claude_code.plan(sb.ctx);
  const localPlan = plans.find(
    (p) => p.path === ".claude/settings.local.json",
  ) as FilePlan;
  assert.ok(
    localPlan.skipped.some((s) => s.key === "env.OTEL_EXPORTER_OTLP_ENDPOINT"),
  );
  applyPlan(localPlan, sb.dirs);
  assert.equal(
    JSON.parse(readFileSync(local, "utf8")).env.OTEL_EXPORTER_OTLP_ENDPOINT,
    "http://mine:4318",
  );
  assert.ok(
    plans.every((p) => !p.path.startsWith("~/")),
    "no plan touches home",
  );
});

test("project id: read from .hawl/<tool>.json walking up; exclude line added once and removed", async () => {
  const sb = sandbox();
  install("claude_code", sb);
  const sub = join(sb.projectDir, "a", "b");
  mkdirSync(sub, { recursive: true });
  const { readProjectId } = await import("../project-id.ts");
  assert.equal(readProjectId("claude_code", sub)?.resident_id, "res_TEST");
  assert.equal(readProjectId("codex", sub), null);

  const { addExclude, removeExclude } = await import("./exclude.ts");
  assert.equal(addExclude(sb.projectDir), false, "not a git checkout");
  mkdirSync(join(sb.projectDir, ".git", "info"), { recursive: true });
  const ex = join(sb.projectDir, ".git", "info", "exclude");
  writeFileSync(ex, "*.log");
  assert.equal(addExclude(sb.projectDir), true);
  assert.equal(addExclude(sb.projectDir), false, "second call adds nothing");
  assert.equal(readFileSync(ex, "utf8"), "*.log\n.hawl/\n");
  assert.equal(removeExclude(sb.projectDir), true);
  assert.equal(readFileSync(ex, "utf8"), "*.log\n");
});

test("claude_code: after the user edits the file, leave removes only entries whose hash still matches", () => {
  const sb = sandbox();
  const mcp = seed(sb.projectDir, ".mcp.json", "mcp-four-space.json");
  const { plans, restore } = install("claude_code", sb);
  const doc = JSON.parse(readFileSync(mcp, "utf8"));
  doc.mcpServers.mine = { command: "z" };
  writeFileSync(mcp, JSON.stringify(doc, null, 2));
  uninstall(plans, restore, sb);
  const after = JSON.parse(readFileSync(mcp, "utf8"));
  assert.equal(after.mcpServers.hawl, undefined);
  assert.equal(after.mcpServers.mine.command, "z");
  assert.equal(after.mcpServers.other.command, "x");

  // An entry the user changed stays.
  const sb2 = sandbox();
  const mcp2 = seed(sb2.projectDir, ".mcp.json", "mcp-four-space.json");
  const r2 = install("claude_code", sb2);
  const d2 = JSON.parse(readFileSync(mcp2, "utf8"));
  d2.mcpServers.hawl.args = ["custom"];
  writeFileSync(mcp2, JSON.stringify(d2, null, 2));
  uninstall(r2.plans, r2.restore, sb2);
  assert.deepEqual(
    JSON.parse(readFileSync(mcp2, "utf8")).mcpServers.hawl.args,
    ["custom"],
  );
});

test("codex: generated TOML parses with the expected tables", () => {
  const sb = sandbox();
  install("codex", sb);
  const text = readFileSync(
    join(sb.projectDir, ".codex", "config.toml"),
    "utf8",
  );
  const doc = parseToml(text) as Record<string, any>;
  assert.equal(doc.mcp_servers.hawl.command, "hawl");
  assert.deepEqual(doc.mcp_servers.hawl.args, ["mcp", "--host", "codex"]);
  assert.equal(doc.mcp_servers.hawl.env, undefined);
  assert.equal(
    JSON.parse(readFileSync(join(sb.projectDir, ".hawl", "codex.json"), "utf8"))
      .resident_id,
    "res_TEST",
  );
  assert.equal(doc.hooks.UserPromptSubmit[0].hooks[0].type, "command");
  assert.equal(
    doc.hooks.UserPromptSubmit[0].hooks[0].command,
    "hawl hook codex UserPromptSubmit",
  );
  assert.equal(doc.otel, undefined);
  for (const e of ["SessionStart", "PreToolUse", "PostToolUse"])
    assert.equal(doc.hooks[e][0].hooks[0].command, `hawl hook codex ${e}`);
});

test("codex: merge into a file with no trailing newline, then uninstall returns the original bytes", () => {
  const sb = sandbox();
  const cfg = seed(
    sb.projectDir,
    ".codex/config.toml",
    "codex-no-trailing-newline.toml",
  );
  const before = bytes(cfg);
  const { plans, restore } = install("codex", sb);
  const doc = parseToml(readFileSync(cfg, "utf8")) as Record<string, any>;
  assert.equal(doc.mcp_servers.other.command, "y");
  assert.equal(doc.mcp_servers.hawl.command, "hawl");
  uninstall(plans, restore, sb);
  assert.deepEqual(bytes(cfg), before);
});

test("codex: block removal by hash works without the restore record", () => {
  const sb = sandbox();
  const cfg = seed(
    sb.projectDir,
    ".codex/config.toml",
    "codex-no-trailing-newline.toml",
  );
  const { plans } = install("codex", sb);
  const text = readFileSync(cfg, "utf8");
  writeFileSync(cfg, `${text}\n[extra]\nk = 1\n`);
  uninstall(plans, [], sb);
  const doc = parseToml(readFileSync(cfg, "utf8")) as Record<string, any>;
  assert.equal(doc.mcp_servers.hawl, undefined);
  assert.equal(doc.hooks, undefined);
  assert.equal(doc.otel, undefined);
  assert.equal(doc.extra.k, 1);
  assert.equal(doc.mcp_servers.other.command, "y");
});

test("codex: a user's own [otel] is left alone and not reported", () => {
  const sb = sandbox();
  const cfg = seed(sb.projectDir, ".codex/config.toml", "codex-own-otel.toml");
  const plans = HOSTS.codex.plan(sb.ctx);
  assert.deepEqual(plans[0]?.skipped, []);
  install("codex", sb);
  const doc = parseToml(readFileSync(cfg, "utf8")) as Record<string, any>;
  assert.equal(doc.otel.log_user_prompt, true);
  assert.equal(doc.mcp_servers.hawl.command, "hawl");
});

test("installing twice changes nothing the second time", () => {
  const sb = sandbox();
  install("codex", sb);
  install("claude_code", sb);
  const f = [
    join(sb.projectDir, ".codex", "config.toml"),
    join(sb.projectDir, ".mcp.json"),
  ];
  const once = f.map(bytes);
  for (const h of ["codex", "claude_code"] as const)
    for (const p of HOSTS[h].plan(sb.ctx))
      assert.equal(p.changed, false, `${p.path} re-planned`);
  assert.deepEqual(f.map(bytes), once);
});

test("cursor and devin: mcp entry plus rules file, and a round trip", () => {
  const sb = sandbox();
  const cur = seed(sb.projectDir, ".cursor/mcp.json", "mcp-four-space.json");
  const before = bytes(cur);
  const c = install("cursor", sb);
  const rules = readFileSync(
    join(sb.projectDir, ".cursor", "rules", "hawl.mdc"),
    "utf8",
  );
  assert.match(rules, /^---\n/);
  assert.match(rules, /alwaysApply: true/);
  const d = install("devin", sb);
  assert.ok(existsSync(join(sb.projectDir, ".devin", "mcp_config.local.json")));
  uninstall(c.plans, c.restore, sb);
  uninstall(d.plans, d.restore, sb);
  assert.deepEqual(bytes(cur), before);
  assert.equal(existsSync(join(sb.projectDir, ".cursor", "rules")), false);
  assert.equal(existsSync(join(sb.projectDir, ".devin")), false);
});

test("gemini: telemetry block with prompt logging off", () => {
  const sb = sandbox();
  install("gemini", sb);
  const t = JSON.parse(
    readFileSync(join(sb.projectDir, ".gemini", "settings.json"), "utf8"),
  ).telemetry;
  assert.equal(t.enabled, true);
  assert.equal(t.otlpProtocol, "http");
  assert.equal(t.otlpEndpoint, "http://127.0.0.1:4318");
  assert.equal(t.logPrompts, false);
});

test("a file that is not plain JSON or valid TOML is left alone", () => {
  const sb = sandbox();
  writeFileSync(join(sb.projectDir, ".mcp.json"), "{ // comment\n}");
  mkdirSync(join(sb.projectDir, ".codex"), { recursive: true });
  writeFileSync(join(sb.projectDir, ".codex", "config.toml"), "= broken");
  for (const h of ["claude_code", "codex"] as const) {
    const plans = HOSTS[h].plan(sb.ctx);
    const first = plans[0] as FilePlan;
    assert.equal(first.changed, false);
    assert.ok(first.skipped.length > 0);
  }
});

test("preview shows added lines and marks new files", () => {
  const sb = sandbox();
  const out = HOSTS.claude_code.plan(sb.ctx).map(previewPlan).join("\n");
  assert.match(out, /\.mcp\.json \(new file\)/);
  assert.match(out, /\+ +"hawl": \{/);
  const sb2 = sandbox();
  seed(sb2.projectDir, ".mcp.json", "mcp-four-space.json");
  const p = HOSTS.claude_code.plan(sb2.ctx)[0] as FilePlan;
  assert.match(previewPlan(p), /^ *\+.*hawl/m);
});
