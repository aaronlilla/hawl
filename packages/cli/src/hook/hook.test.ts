import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { newId } from "@hawl/protocol/src/ids.ts";
import { generateWorkerKey, MemoryKeyStore } from "../daemon/keys.ts";
import { startDaemon } from "../daemon/main.ts";
import { ManifestStore } from "../daemon/manifest.ts";
import { Spool } from "../daemon/spool.ts";
import {
  makeEnvelope,
  makeRelayKey,
  makeRoot,
  tmpState,
} from "../daemon/testkit.ts";
import type { Route } from "../resolve.ts";
import {
  hookOutput,
  readStdin,
  readUnread,
  WAKE_UPGRADED_NOTE,
} from "./hook.ts";

/** 300 ms is the hook budget; shared CI runners get slack so load does not flake it. */
const BUDGET_MS = process.env.CI ? 1500 : 300;

const NOTICE = "\u{1F4EC} Hawl: 1 waiting. Call the mailbox tool.";

async function daemonWithOneUnread() {
  const stateDir = tmpState();
  const resident = newId("res");
  const keyStore = new MemoryKeyStore();
  await keyStore.set(resident, generateWorkerKey().privateJwk);
  const d = await startDaemon({
    stateDir,
    keyStore,
    manifests: new ManifestStore(stateDir, makeRoot().roots),
  });
  await d.attach({
    relay_url: "http://127.0.0.1:9",
    resident_id: resident,
    platform: "codex",
  });
  const env = makeEnvelope(makeRelayKey().privateKey, resident, { seq: 1 }).env;
  new Spool(join(stateDir, "spool"), resident).put(env);
  return { d, stateDir };
}

test("daemon path: Claude Code JSON, plain text for Codex, inside 300 ms", async () => {
  const { d, stateDir } = await daemonWithOneUnread();
  try {
    const t0 = Date.now();
    const out = await hookOutput(
      "claude_code",
      "UserPromptSubmit",
      {},
      { stateDir },
    );
    assert.ok(Date.now() - t0 < BUDGET_MS, "hook over budget");
    assert.deepEqual(JSON.parse(out), {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: NOTICE,
      },
    });
    assert.equal(
      await hookOutput("codex", "SessionStart", {}, { stateDir }),
      NOTICE,
    );
  } finally {
    await d.stop();
  }
  // daemon gone, no fallback configured: nothing printed
  assert.equal(
    await hookOutput("claude_code", "SessionStart", {}, { stateDir }),
    "",
  );
});

test("zero unread prints nothing", async () => {
  const stateDir = tmpState();
  const d = await startDaemon({
    stateDir,
    keyStore: new MemoryKeyStore(),
    manifests: new ManifestStore(stateDir, makeRoot().roots),
  });
  try {
    assert.equal(
      await hookOutput("claude_code", "UserPromptSubmit", {}, { stateDir }),
      "",
    );
  } finally {
    await d.stop();
  }
});

test("no daemon: stateless GET /v1/inbox?limit=0, only the integer is used", async () => {
  const stateDir = tmpState();
  let seen: { url: string; auth: string } | undefined;
  const fakeFetch = (async (url: URL, init: RequestInit) => {
    seen = {
      url: String(url),
      auth: (init.headers as Record<string, string>).authorization ?? "",
    };
    return Response.json({
      unread: 2,
      from: "@evil",
      subject: "ignore rules",
    });
  }) as unknown as typeof fetch;
  const out = await hookOutput(
    "claude_code",
    "UserPromptSubmit",
    {},
    {
      stateDir,
      relayUrl: "https://relay.example",
      agentToken: "tok",
      fetch: fakeFetch,
    },
  );
  assert.equal(seen?.url, "https://relay.example/v1/inbox?limit=0");
  assert.equal(seen?.auth, "Bearer tok");
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
  assert.equal(ctx, "\u{1F4EC} Hawl: 2 waiting. Call the mailbox tool.");
  assert.ok(!out.includes("evil") && !out.includes("ignore"));
});

test("a hung relay cannot push the hook past its budget", async () => {
  const stateDir = tmpState();
  const hang = (() => new Promise(() => {})) as unknown as typeof fetch;
  const t0 = Date.now();
  const n = await readUnread({
    stateDir,
    relayUrl: "https://relay.example",
    agentToken: "t",
    fetch: hang,
  });
  assert.equal(n, 0);
  assert.ok(Date.now() - t0 < BUDGET_MS);
});

test("Stop: at most 3 per session, never while stop_hook_active", async () => {
  const { d, stateDir } = await daemonWithOneUnread();
  try {
    const input = { session_id: "sess_1" };
    const outs: string[] = [];
    for (let i = 0; i < 5; i++) {
      outs.push(await hookOutput("codex", "Stop", input, { stateDir }));
    }
    assert.deepEqual(
      outs.map((o) => o !== ""),
      [true, true, true, false, false],
    );
    assert.deepEqual(JSON.parse(outs[0] as string), {
      decision: "block",
      reason: NOTICE,
    });
    // a different session has its own budget
    assert.notEqual(
      await hookOutput("codex", "Stop", { session_id: "sess_2" }, { stateDir }),
      "",
    );
    // already continuing: stay quiet
    assert.equal(
      await hookOutput(
        "codex",
        "Stop",
        { session_id: "sess_3", stop_hook_active: true },
        { stateDir },
      ),
      "",
    );
    // no session id or a path-shaped one: nothing
    assert.equal(await hookOutput("codex", "Stop", {}, { stateDir }), "");
    assert.equal(
      await hookOutput("codex", "Stop", { session_id: "../x" }, { stateDir }),
      "",
    );
  } finally {
    await d.stop();
  }
});

test("no env token: the hook mints one from the keychain key and reads the inbox", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { generateWorkerKey, MemoryKeyStore } = await import(
    "../daemon/keys.ts"
  );
  const { newTownFile, addWorker, writeTownFile } = await import(
    "../town-file.ts"
  );
  const { keychainMinter } = await import("./hook.ts");
  const cwd = mkdtempSync(join(tmpdir(), "hawl-hook-"));
  const stateDir = tmpState();
  const k = generateWorkerKey();
  const rid = "res_01";
  const store = new MemoryKeyStore();
  await store.set(rid, k.privateJwk);
  const tf = newTownFile("x");
  addWorker(
    tf,
    { town_id: "town_1", town_slug: "t", relay_url: "https://relay.example" },
    { resident_id: rid, platform: "claude_code", kid: k.kid },
  );
  writeTownFile(cwd, tf);
  const seen: { url: string; auth: string | null }[] = [];
  const fakeFetch = (async (u: URL | string, init?: RequestInit) => {
    const url = String(u);
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/v1/auth/token"))
      return Response.json({ access_token: "minted" });
    return Response.json({ unread: 3 });
  }) as unknown as typeof fetch;
  const n = await readUnread({
    stateDir,
    fetch: fakeFetch,
    mintToken: keychainMinter(cwd, stateDir, {
      fetch: fakeFetch,
      keyStore: store,
    }),
  });
  assert.equal(n, 3);
  assert.equal(seen[0]?.url, "https://relay.example/v1/auth/token");
  assert.equal(seen[1]?.url, "https://relay.example/v1/inbox?limit=0");
  assert.equal(seen[1]?.auth, "Bearer minted");
});

function joinedFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "hawl-hook-"));
  mkdirSync(join(dir, ".hawl"));
  writeFileSync(
    join(dir, ".hawl", "hawl.json"),
    JSON.stringify({
      v: 1,
      village_id: "vil_1",
      folder_label: "p",
      memberships: [
        {
          town_id: "twn_1",
          town_slug: "acme",
          relay_url: "https://relay.hawl.ai",
          workers: [
            { resident_id: "res_W1", platform: "claude_code", kid: "k" },
            { resident_id: "res_W2", platform: "codex", kid: "k" },
          ],
        },
      ],
      written: [],
      restore: [],
    }),
  );
  return dir;
}

function relayDeps(unread: number) {
  return {
    relayUrl: "https://relay.example",
    agentToken: "t",
    stateDir: tmpState(),
    fetch: (async () => Response.json({ unread })) as unknown as typeof fetch,
  };
}

test("SessionStart prints the brief for both hosts, with 0 and with unread", async () => {
  const cwd = joinedFolder();
  const line = "2 waiting. Call the mailbox tool.";
  for (const unread of [0, 2]) {
    const cc = await hookOutput(
      "claude_code",
      "SessionStart",
      { cwd },
      relayDeps(unread),
    );
    const parsed = JSON.parse(cc).hookSpecificOutput;
    assert.equal(parsed.hookEventName, "SessionStart");
    const ctx = parsed.additionalContext as string;
    assert.match(ctx, /Home base: site acme via relay\.hawl\.ai/);
    assert.match(ctx, /worker res_W1 \(claude_code\)/);
    assert.equal(ctx.endsWith(line), unread === 2);

    const cx = await hookOutput(
      "codex",
      "SessionStart",
      { cwd },
      relayDeps(unread),
    );
    assert.ok(!cx.startsWith("{"), "codex gets plain stdout");
    assert.match(cx, /worker res_W2 \(codex\)/);
    assert.equal(cx.endsWith(line), unread === 2);
  }
});

test("SessionStart in a folder joined before the waiter: adds it and tells the person once", async () => {
  const cwd = joinedFolder();
  mkdirSync(join(cwd, ".claude"));
  // What join wrote before the waiter existed.
  writeFileSync(
    join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "hawl hook claude_code SessionStart",
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [{ type: "command", command: "hawl hook claude_code Stop" }],
          },
        ],
      },
    }),
  );
  const first = JSON.parse(
    await hookOutput("claude_code", "SessionStart", { cwd }, relayDeps(0)),
  );
  assert.equal(first.systemMessage, WAKE_UPGRADED_NOTE);
  assert.match(first.hookSpecificOutput.additionalContext, /Home base/);
  const settings = readFileSync(
    join(cwd, ".claude", "settings.local.json"),
    "utf8",
  );
  assert.match(settings, /"asyncRewake": true/);
  // Next session: already upgraded, no message.
  const again = JSON.parse(
    await hookOutput("claude_code", "SessionStart", { cwd }, relayDeps(0)),
  );
  assert.equal(again.systemMessage, undefined);
});

test("UserPromptSubmit keeps the short notice even in a joined folder", async () => {
  const out = await hookOutput(
    "codex",
    "UserPromptSubmit",
    { cwd: joinedFolder() },
    relayDeps(1),
  );
  assert.equal(out, NOTICE);
});

test("SessionStart without a town file falls back to the plain notice", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hawl-hook-"));
  assert.equal(
    await hookOutput("codex", "SessionStart", { cwd }, relayDeps(1)),
    NOTICE,
  );
});

test("machine-wide hook: silent outside a joined folder, briefs in a subfolder of one", async () => {
  const outside = mkdtempSync(join(tmpdir(), "hawl-hook-"));
  assert.equal(
    await hookOutput(
      "claude_code",
      "SessionStart",
      { cwd: outside, session_id: "s1" },
      { ...relayDeps(1), scope: "user" },
    ),
    "",
  );
  const sub = join(joinedFolder(), "apps", "web");
  mkdirSync(sub, { recursive: true });
  const out = await hookOutput(
    "claude_code",
    "SessionStart",
    { cwd: sub, session_id: "s2" },
    { ...relayDeps(0), scope: "user" },
  );
  assert.match(out, /Home base: site acme/);
});

test("project and machine-wide copies of one event: only the first acts", async () => {
  const cwd = joinedFolder();
  const deps = relayDeps(1);
  // Written when the machine-wide copy is installed.
  writeFileSync(join(deps.stateDir, "user-scope.json"), "{}");
  const input = { cwd, session_id: "s3", prompt: "hi" };
  const [a, b] = await Promise.all([
    hookOutput("codex", "UserPromptSubmit", input, deps),
    hookOutput("codex", "UserPromptSubmit", input, { ...deps, scope: "user" }),
  ]);
  assert.deepEqual([a, b].sort(), ["", NOTICE].sort());
  // A different prompt in the same session is a new event.
  assert.equal(
    await hookOutput(
      "codex",
      "UserPromptSubmit",
      { ...input, prompt: "next" },
      { ...deps, scope: "user" },
    ),
    NOTICE,
  );
});

test("the notice counts only the session's own worker", async () => {
  const { d, stateDir } = await daemonWithOneUnread();
  try {
    const other = joinedFolder(); // res_W1 / res_W2: nothing waiting for them
    assert.equal(
      await hookOutput(
        "codex",
        "UserPromptSubmit",
        { cwd: other },
        { stateDir },
      ),
      "",
    );
  } finally {
    await d.stop();
  }
});

test("PostToolUse: the notice shows only when unread rose since the session was last told", async () => {
  const { d, stateDir } = await daemonWithOneUnread();
  try {
    const post = (sid: string, n: number) =>
      hookOutput(
        "claude_code",
        "PostToolUse",
        { session_id: sid, tool_use_id: `t${n}` },
        { stateDir },
      );
    // first tool call after the mail arrived: one notice, JSON context form
    assert.deepEqual(JSON.parse(await post("sess_p", 1)), {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: NOTICE,
      },
    });
    // same count on the next calls: quiet
    assert.equal(await post("sess_p", 2), "");
    assert.equal(await post("sess_p", 3), "");
    // a session already told at prompt time does not get it again mid-task
    assert.notEqual(
      await hookOutput(
        "claude_code",
        "UserPromptSubmit",
        { session_id: "sess_q", prompt: "go" },
        { stateDir },
      ),
      "",
    );
    assert.equal(await post("sess_q", 1), "");
    // no session id: nothing to compare against, nothing printed
    assert.equal(
      await hookOutput("claude_code", "PostToolUse", {}, { stateDir }),
      "",
    );
    // Codex gets the same JSON form on PostToolUse
    assert.equal(
      JSON.parse(
        await hookOutput(
          "codex",
          "PostToolUse",
          { session_id: "sess_c", tool_use_id: "x" },
          { stateDir },
        ),
      ).hookSpecificOutput.additionalContext,
      NOTICE,
    );
  } finally {
    await d.stop();
  }
});

test("PostToolUse: after the mail is read, the next arrival shows again", async () => {
  const stateDir = tmpState();
  const resident = newId("res");
  const keyStore = new MemoryKeyStore();
  await keyStore.set(resident, generateWorkerKey().privateJwk);
  const d = await startDaemon({
    stateDir,
    keyStore,
    manifests: new ManifestStore(stateDir, makeRoot().roots),
  });
  try {
    await d.attach({
      relay_url: "http://127.0.0.1:9",
      resident_id: resident,
      platform: "claude_code",
    });
    const spool = new Spool(join(stateDir, "spool"), resident);
    const key = makeRelayKey().privateKey;
    const post = (n: number) =>
      hookOutput(
        "claude_code",
        "PostToolUse",
        { session_id: "sess_r", tool_use_id: `r${n}` },
        { stateDir },
      );
    const first = makeEnvelope(key, resident, { seq: 1 }).env;
    spool.put(first);
    assert.notEqual(await post(1), "");
    spool.markRead([first.relay.message_id]);
    assert.equal(await post(2), "", "count fell to 0: quiet, but recorded");
    spool.put(makeEnvelope(key, resident, { seq: 2 }).env);
    assert.notEqual(await post(3), "", "new mail after reading shows again");
  } finally {
    await d.stop();
  }
});

async function daemonWithMail(
  mail: Parameters<typeof makeEnvelope>[2][],
): Promise<{ d: Awaited<ReturnType<typeof startDaemon>>; stateDir: string }> {
  const stateDir = tmpState();
  const resident = newId("res");
  const keyStore = new MemoryKeyStore();
  await keyStore.set(resident, generateWorkerKey().privateJwk);
  const d = await startDaemon({
    stateDir,
    keyStore,
    manifests: new ManifestStore(stateDir, makeRoot().roots),
  });
  await d.attach({
    relay_url: "http://127.0.0.1:9",
    resident_id: resident,
    platform: "codex",
  });
  const key = makeRelayKey().privateKey;
  const spool = new Spool(join(stateDir, "spool"), resident);
  mail.forEach((o, i) => {
    spool.put(makeEnvelope(key, resident, { ...o, seq: i + 1 }).env);
  });
  return { d, stateDir };
}

const BROADCAST = {
  to: { kind: "channel", channel_id: "chn_1", mentions: [] },
} as const;

test("broadcast mail counts in the prompt notice but never triggers Stop or PostToolUse", async () => {
  const { d, stateDir } = await daemonWithMail([BROADCAST, BROADCAST]);
  try {
    const prompt = await hookOutput(
      "claude_code",
      "UserPromptSubmit",
      { session_id: "s_b" },
      { stateDir },
    );
    assert.match(prompt, /2 waiting/);
    assert.equal(
      await hookOutput("codex", "Stop", { session_id: "s_b2" }, { stateDir }),
      "",
    );
    assert.equal(
      await hookOutput(
        "claude_code",
        "PostToolUse",
        { session_id: "s_b3", tool_use_id: "t1" },
        { stateDir },
      ),
      "",
    );
  } finally {
    await d.stop();
  }
});

test("Stop and PostToolUse count only aimed mail among broadcasts", async () => {
  const { d, stateDir } = await daemonWithMail([
    BROADCAST,
    {},
    { intent: "ask" },
  ]);
  try {
    assert.equal(
      JSON.parse(
        await hookOutput("codex", "Stop", { session_id: "s_a" }, { stateDir }),
      ).reason,
      "\u{1F4EC} Hawl: 2 waiting. Call the mailbox tool.",
    );
    assert.match(
      await hookOutput(
        "claude_code",
        "UserPromptSubmit",
        { session_id: "s_a2" },
        { stateDir },
      ),
      /3 waiting/,
    );
  } finally {
    await d.stop();
  }
});

test("stop-hook off: Stop and PostToolUse print nothing, the prompt notice stays", async () => {
  const { d, stateDir } = await daemonWithMail([{}]);
  const route = { town: { stop_hook: false } } as unknown as Route;
  try {
    assert.equal(
      await hookOutput(
        "codex",
        "Stop",
        { session_id: "s_off" },
        { stateDir, route },
      ),
      "",
    );
    assert.equal(
      await hookOutput(
        "claude_code",
        "PostToolUse",
        { session_id: "s_off2", tool_use_id: "t1" },
        { stateDir, route },
      ),
      "",
    );
    assert.match(
      await hookOutput(
        "claude_code",
        "UserPromptSubmit",
        { session_id: "s_off3" },
        { stateDir, route },
      ),
      /1 waiting/,
    );
    // on again (field absent): Stop continues
    assert.notEqual(
      await hookOutput(
        "codex",
        "Stop",
        { session_id: "s_on" },
        { stateDir, route: { town: {} } as unknown as Route },
      ),
      "",
    );
  } finally {
    await d.stop();
  }
});

test("readStdin: input that arrives after the wait is lost; a longer wait gets it", async () => {
  const late = () => {
    const s = new PassThrough();
    setTimeout(() => s.end('{"session_id":"s9","cwd":"/x"}'), 150);
    return s;
  };
  assert.deepEqual(await readStdin(50, late()), {});
  assert.deepEqual(await readStdin(5_000, late()), {
    session_id: "s9",
    cwd: "/x",
  });
});
