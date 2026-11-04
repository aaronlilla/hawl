import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { newId } from "@hawl/protocol/src/ids.ts";
import { makeEnvelope, makeRelayKey } from "../daemon/testkit.ts";
import { type DaemonLink, makeServer } from "./server.ts";
import {
  actingAs,
  followHostSession,
  hostSessionId,
  metaSessionId,
  startTerminalAgent,
} from "./session.ts";
import { mailbox } from "./tool-run.ts";

const FOLDER = newId("res");
const CHILD = newId("res");
const signer = {
  kid: "key_X",
  privateKey: generateKeyPairSync("ed25519").privateKey,
};

function daemon(
  answer: (op: string, args: Record<string, unknown>) => unknown,
) {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const link: DaemonLink = {
    async call(op, args = {}) {
      calls.push({ op, args });
      return answer(op, args);
    },
  };
  return { link, calls };
}

const opened = {
  resident_id: CHILD,
  handle: "otter",
  display_name: "Aaron's Claude · Otter",
  session_of: FOLDER,
};

test("Claude Code's session id names the terminal; Codex and others get one per process", () => {
  assert.equal(
    hostSessionId("claude_code", { CLAUDE_CODE_SESSION_ID: "abc-123" }),
    "abc-123",
  );
  assert.equal(
    hostSessionId("codex", { CLAUDE_CODE_SESSION_ID: "abc-123" }),
    undefined,
  );
  assert.equal(
    hostSessionId("claude_code", { CLAUDE_CODE_SESSION_ID: "bad id\n" }),
    undefined,
  );
});

test("in a joined folder the MCP server works as this terminal's own agent", async () => {
  const d = daemon((op) => (op === "session_open" ? opened : null));
  const deps = await startTerminalAgent(
    { daemon: d.link, residentId: FOLDER, host: "claude_code", signer },
    {
      env: { CLAUDE_CODE_SESSION_ID: "sess-42" },
      loadSigner: async (rid) =>
        rid === CHILD ? { ...signer, kid: "key_CHILD" } : null,
    },
  );
  assert.deepEqual(d.calls[0], {
    op: "session_open",
    args: {
      resident_id: FOLDER,
      host_session_id: "sess-42",
      host: "claude_code",
      ppid: process.ppid,
    },
  });
  assert.equal(deps.residentId, CHILD);
  assert.equal(deps.folderId, FOLDER);
  assert.equal(deps.signer?.kid, "key_CHILD");
  assert.equal(
    deps.sessionId,
    "sess-42",
    "presence uses the host's session id",
  );
  assert.match(
    deps.sessionLine ?? "",
    /you are @otter \(Aaron's Claude · Otter\)/,
  );
  // The instructions tell the model who it is in this terminal.
  const server = makeServer({ ...deps, cwd: process.cwd() }) as unknown as {
    server: { _instructions?: string };
  };
  assert.match(server.server._instructions ?? "", /@otter/);
});

test("anything that fails keeps the folder's worker (older daemon or relay, bad answer, no key, timeout)", async () => {
  const base = {
    daemon: daemon(() => null).link,
    residentId: FOLDER,
    host: "claude_code",
    signer,
  };
  const cases: [
    string,
    (op: string) => unknown,
    ((rid: string) => Promise<typeof signer | null>)?,
  ][] = [
    [
      "older daemon",
      () => {
        throw new Error("unknown op session_open");
      },
    ],
    ["older relay", () => ({ unsupported: true })],
    ["bad handle", () => ({ ...opened, handle: "Bad Handle!" })],
    ["bad id", () => ({ ...opened, resident_id: "nope" })],
    ["no key", () => opened, async () => null],
  ];
  for (const [name, answer, load] of cases) {
    const deps = await startTerminalAgent(
      { ...base, daemon: daemon(answer).link },
      { env: {}, loadSigner: load ?? (async () => signer) },
    );
    assert.equal(deps.residentId, FOLDER, name);
    assert.equal(deps.folderId, undefined, name);
  }
  const slow = await startTerminalAgent(
    { ...base, daemon: daemon(() => new Promise(() => {})).link },
    { env: {}, loadSigner: async () => signer, timeoutMs: 50 },
  );
  assert.equal(slow.residentId, FOLDER, "timeout");
  // Local mode (no host): untouched, no daemon call.
  const d = daemon(() => opened);
  const local = await startTerminalAgent({
    daemon: d.link,
    residentId: FOLDER,
    signer,
  });
  assert.equal(local.residentId, FOLDER);
  assert.equal(d.calls.length, 0);
});

test("mailbox shows the terminal's own mail and the folder's, and marks each read where it lives", async () => {
  const relay = makeRelayKey();
  const own = makeEnvelope(relay.privateKey, CHILD, {
    seq: 1,
    text: "to otter",
  }).env;
  const shared = makeEnvelope(relay.privateKey, FOLDER, {
    seq: 1,
    text: "to the folder",
  }).env;
  const d = daemon((op, args) => {
    if (op === "mailbox")
      return { envelopes: args.resident_id === CHILD ? [own] : [shared] };
    return { ok: true };
  });
  const r = await mailbox(
    { daemon: d.link, residentId: CHILD, folderId: FOLDER },
    {},
  );
  assert.equal(r.messages.length, 2);
  assert.match(r.messages[0]?.text ?? "", /to otter/);
  assert.match(r.messages[1]?.text ?? "", /to the folder/);
  const marks = d.calls.filter((c) => c.op === "mark_read").map((c) => c.args);
  assert.deepEqual(marks, [
    { resident_id: CHILD, message_ids: [own.relay.message_id] },
    { resident_id: FOLDER, message_ids: [shared.relay.message_id] },
  ]);
  // Without a folder (old behaviour) only its own inbox is read.
  const d2 = daemon(() => ({ envelopes: [], read: [] }));
  await mailbox({ daemon: d2.link, residentId: FOLDER }, {});
  assert.equal(d2.calls.filter((c) => c.op === "mailbox").length, 1);
});

test("a channel message in both the terminal's and the folder's inbox shows once, is read in both, and never again", async () => {
  const relay = makeRelayKey();
  const dup = makeEnvelope(relay.privateKey, CHILD, {
    text: "to the room",
  }).env;
  const dupInFolder = structuredClone(dup);
  const own = makeEnvelope(relay.privateKey, CHILD, { text: "to otter" }).env;
  const shared = makeEnvelope(relay.privateKey, FOLDER, {
    text: "to the folder",
  }).env;
  // A daemon with real read state: each inbox returns only what it has not marked read.
  const inbox = new Map([
    [CHILD, [dup, own]],
    [FOLDER, [dupInFolder, shared]],
  ]);
  const read = new Map<string, Set<string>>([
    [CHILD, new Set()],
    [FOLDER, new Set()],
  ]);
  const d = daemon((op, args) => {
    const who = args.resident_id as string;
    if (op === "mailbox" && args.read_state === true)
      return {
        envelopes: inbox.get(who) ?? [],
        read: [...(read.get(who) ?? [])],
      };
    if (op === "mailbox")
      return {
        envelopes: (inbox.get(who) ?? []).filter(
          (e) => !args.unread_only || !read.get(who)?.has(e.relay.message_id),
        ),
      };
    if (op === "mark_read")
      for (const id of args.message_ids as string[]) read.get(who)?.add(id);
    return { ok: true };
  });
  const deps = { daemon: d.link, residentId: CHILD, folderId: FOLDER };
  const first = await mailbox(deps, {});
  const ids = first.messages.map((m) => m.message_id);
  assert.deepEqual(
    ids.sort(),
    [dup, own, shared].map((e) => e.relay.message_id).sort(),
    "each message once",
  );
  assert.deepEqual(
    [...(read.get(CHILD) ?? [])].sort(),
    [dup, own].map((e) => e.relay.message_id).sort(),
  );
  assert.deepEqual(
    [...(read.get(FOLDER) ?? [])].sort(),
    [dup, shared].map((e) => e.relay.message_id).sort(),
  );
  const second = await mailbox(deps, {});
  assert.deepEqual(second.messages, [], "nothing shows again");
  assert.equal(
    d.calls.filter((c) => c.op === "mailbox").length,
    4,
    "one inbox read each for the terminal and the folder, per call",
  );
  // The two copies come over separate connections: one can land after its twin was read.
  for (const [firstIn, thenIn] of [
    [CHILD, FOLDER],
    [FOLDER, CHILD],
  ] as const) {
    const late = makeEnvelope(relay.privateKey, firstIn, {
      text: `late via ${firstIn}`,
    }).env;
    inbox.get(firstIn)?.push(late);
    const a = await mailbox(deps, {});
    assert.deepEqual(
      a.messages.map((m) => m.message_id),
      [late.relay.message_id],
    );
    inbox.get(thenIn)?.push(structuredClone(late));
    const b = await mailbox(deps, {});
    assert.deepEqual(
      b.messages,
      [],
      `the later copy in ${thenIn === CHILD ? "the terminal" : "the folder"} is not shown`,
    );
    assert.ok(
      read.get(thenIn)?.has(late.relay.message_id),
      "and is marked read there",
    );
  }
});

// --- Codex: the session id arrives on tool calls (`_meta.sessionId`), so a resume keeps its name.

test("Codex's tool-call _meta names the session: sessionId first, then threadId; other hosts ignored", () => {
  assert.equal(
    metaSessionId("codex", { sessionId: "019a-root", threadId: "019a-sub" }),
    "019a-root",
  );
  assert.equal(metaSessionId("codex", { threadId: "019a-t" }), "019a-t");
  assert.equal(metaSessionId("claude_code", { sessionId: "x" }), undefined);
  assert.equal(metaSessionId("codex", { sessionId: "bad id\n" }), undefined);
  assert.equal(metaSessionId("codex", undefined), undefined);
});

function presences() {
  const log: string[] = [];
  return {
    log,
    start: (d: { residentId: string }, id: string) => {
      log.push(`start ${d.residentId} ${id}`);
      return {
        stop: async () => {
          log.push(`stop ${d.residentId} ${id}`);
        },
      };
    },
  };
}

const PROV = "provisional-1";

test("a new Codex session keeps the agent this terminal started with, now bound to Codex's id", async () => {
  const d = daemon((op) => (op === "session_open" ? opened : { sent: true }));
  const deps = {
    daemon: d.link,
    residentId: CHILD,
    folderId: FOLDER,
    host: "codex",
    signer,
    sessionId: PROV,
  };
  const p = presences();
  const f = followHostSession(deps, {
    startPresence: p.start,
    loadSigner: async () => signer,
  });
  const note = await f.onToolCall({ sessionId: "codex-S1", threadId: "t" });
  assert.equal(note, undefined, "same agent: nothing to tell the model");
  assert.deepEqual(d.calls[0], {
    op: "session_open",
    args: {
      resident_id: FOLDER,
      host_session_id: "codex-S1",
      replaces_host_session_id: PROV,
      host: "codex",
      ppid: process.ppid,
    },
  });
  assert.equal(deps.residentId, CHILD);
  assert.equal(deps.sessionId, "codex-S1");
  // The new session beats before the provisional one says goodbye.
  assert.deepEqual(p.log, [
    `start ${CHILD} ${PROV}`,
    `start ${CHILD} codex-S1`,
    `stop ${CHILD} ${PROV}`,
  ]);
  // Later calls (same id, or none) never ask again.
  await f.onToolCall({ sessionId: "codex-S1" });
  await f.onToolCall(undefined);
  assert.equal(d.calls.filter((c) => c.op === "session_open").length, 1);
  await f.stop();
  assert.equal(p.log.at(-1), `stop ${CHILD} codex-S1`);
});

test("codex resume: the session's earlier agent comes back, tools act as it, and the model is told", async () => {
  const FOX = newId("res");
  const d = daemon((op) =>
    op === "session_open"
      ? {
          resident_id: FOX,
          handle: "fox",
          display_name: "Aaron's Codex · Fox",
          session_of: FOLDER,
        }
      : { envelopes: [] },
  );
  const deps = {
    daemon: d.link,
    residentId: CHILD,
    folderId: FOLDER,
    host: "codex",
    signer,
    sessionId: PROV,
  } as Parameters<typeof makeServer>[0] & { sessionId?: string };
  const p = presences();
  const f = followHostSession(deps, {
    startPresence: p.start,
    loadSigner: async (rid) =>
      rid === FOX ? { ...signer, kid: "key_FOX" } : null,
  });
  deps.onToolCall = f.onToolCall;
  // Two calls at once ask the daemon once.
  const [n1, n2] = await Promise.all([
    f.onToolCall({ sessionId: "codex-old" }),
    f.onToolCall({ sessionId: "codex-old" }),
  ]);
  const notes = [n1, n2].filter(Boolean);
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? "", /you are @fox \(Aaron's Codex · Fox\) again/);
  assert.equal(d.calls.filter((c) => c.op === "session_open").length, 1);
  assert.equal(deps.residentId, FOX);
  assert.equal(deps.signer?.kid, "key_FOX");
  assert.match(deps.sessionLine ?? "", /@fox/);
  assert.deepEqual(p.log, [
    `start ${CHILD} ${PROV}`,
    `start ${FOX} codex-old`,
    `stop ${CHILD} ${PROV}`,
  ]);
  // Its mailbox is the resumed agent's.
  await mailbox(deps, {});
  assert.equal(d.calls.find((c) => c.op === "mailbox")?.args.resident_id, FOX);
});

test("claude --continue: the daemon pairs the fresh id with the resumed one (by Claude's pid), and the terminal is Otter again", async () => {
  const OTTER = newId("res");
  let polls = 0;
  const d = daemon((op) => {
    if (op === "session_link")
      // The resumed session's hook reaches the daemon a moment after this server starts.
      return { host_session_id: ++polls >= 2 ? "claude-Y" : null };
    if (op === "session_open")
      return {
        resident_id: OTTER,
        handle: "otter",
        display_name: "Aaron's Claude · Otter",
        session_of: FOLDER,
      };
    return { sent: true };
  });
  const deps = {
    daemon: d.link,
    residentId: CHILD,
    folderId: FOLDER,
    host: "claude_code",
    signer,
    sessionId: "claude-X",
  } as Parameters<typeof makeServer>[0] & { sessionId?: string };
  const p = presences();
  const f = followHostSession(deps, {
    startPresence: p.start,
    loadSigner: async (rid) =>
      rid === OTTER ? { ...signer, kid: "key_OTTER" } : null,
    linkEveryMs: 5,
    ppid: 4242,
  });
  for (let i = 0; i < 200 && deps.residentId !== OTTER; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    deps.residentId,
    OTTER,
    "switched without waiting for a tool call",
  );
  assert.deepEqual(d.calls.find((c) => c.op === "session_link")?.args, {
    resident_id: FOLDER,
    host_session_id: "claude-X",
    ppid: 4242,
  });
  assert.deepEqual(d.calls.find((c) => c.op === "session_open")?.args, {
    resident_id: FOLDER,
    host_session_id: "claude-Y",
    replaces_host_session_id: "claude-X",
    host: "claude_code",
    ppid: process.ppid,
  });
  assert.equal(deps.signer?.kid, "key_OTTER");
  assert.equal(deps.sessionId, "claude-Y");
  assert.deepEqual(p.log, [
    `start ${CHILD} claude-X`,
    `start ${OTTER} claude-Y`,
    `stop ${CHILD} claude-X`,
  ]);
  // The next tool call tells the model, once; nothing asks the daemon again.
  assert.match(
    (await f.onToolCall(undefined)) ?? "",
    /you are @otter .* again/,
  );
  assert.equal(await f.onToolCall(undefined), undefined);
  const asked = d.calls.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(d.calls.length, asked, "polling stopped");
  await f.stop();
});

test("Claude Code terminals, the folder's own worker, and failures never switch", async () => {
  const cases = [
    [
      "claude_code",
      { residentId: CHILD, folderId: FOLDER, host: "claude_code" },
    ],
    ["no terminal agent", { residentId: FOLDER, host: "codex" }],
  ] as const;
  for (const [name, deps] of cases) {
    const d = daemon(() => opened);
    const f = followHostSession(
      { ...deps, daemon: d.link, sessionId: PROV },
      { startPresence: presences().start, loadSigner: async () => signer },
    );
    await f.onToolCall({ sessionId: "codex-S1" });
    await f.stop();
    // Claude Code ignores _meta; it only asks the daemon for a pair (none here).
    assert.equal(
      d.calls.filter((c) => c.op !== "session_link").length,
      0,
      name,
    );
  }
  // The daemon fails three times: keep the provisional agent and stop asking.
  const d = daemon((op) => {
    if (op === "session_open") throw new Error("relay down");
    return {};
  });
  const deps = {
    daemon: d.link,
    residentId: CHILD,
    folderId: FOLDER,
    host: "codex",
    sessionId: PROV,
  };
  const f = followHostSession(deps, {
    startPresence: presences().start,
    loadSigner: async () => signer,
  });
  for (let i = 0; i < 5; i++) await f.onToolCall({ sessionId: "codex-S1" });
  assert.equal(d.calls.filter((c) => c.op === "session_open").length, 3);
  assert.equal(deps.residentId, CHILD);
});

test("the MCP SDK hands each tool call's _meta to the follower, and its note leads the result", async () => {
  const FOX = newId("res");
  const d = daemon((op) =>
    op === "session_open"
      ? { resident_id: FOX, handle: "fox", display_name: "Aaron's Codex · Fox" }
      : op === "tool" // the helper runs the whole tool and answers the MCP result
        ? { content: [{ type: "text", text: "[]" }] }
        : { workers: [] },
  );
  const deps = {
    daemon: d.link,
    residentId: CHILD,
    folderId: FOLDER,
    host: "codex",
    signer,
    sessionId: PROV,
    cwd: process.cwd(),
  } as Parameters<typeof makeServer>[0] & { sessionId?: string };
  const f = followHostSession(deps, {
    startPresence: presences().start,
    loadSigner: async () => signer,
  });
  deps.onToolCall = f.onToolCall;
  const server = makeServer(deps);
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  const transport = {
    onmessage: undefined as undefined | ((m: unknown) => void),
    onclose: undefined as undefined | (() => void),
    onerror: undefined as undefined | ((e: Error) => void),
    async start() {},
    async close() {},
    async send(m: Record<string, unknown>) {
      if (typeof m.id === "number") waiters.get(m.id)?.(m);
    },
  };
  await server.connect(transport as never);
  const req = (id: number, method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiters.set(id, resolve);
      transport.onmessage?.({ jsonrpc: "2.0", id, method, params });
    });
  const init = await req(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "codex-mcp-client", version: "0.160.0" },
  });
  assert.ok(init.result, JSON.stringify(init));
  transport.onmessage?.({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  const res = (await req(2, "tools/call", {
    name: "who",
    arguments: {},
    _meta: { threadId: "codex-old", sessionId: "codex-old", callId: "c1" },
  })) as { result: { content: { text: string }[] } };
  assert.equal(
    d.calls.find((c) => c.op === "session_open")?.args.host_session_id,
    "codex-old",
  );
  assert.match(
    res.result.content[0]?.text ?? "",
    /you are @fox/,
    JSON.stringify(res),
  );
  assert.equal(
    d.calls.find((c) => c.op === "tool")?.args.resident_id,
    FOX,
    "the tool ran as the resumed agent",
  );
});

test("a tool call tagged with hawl_agent (a Claude Code subagent) runs as the subagent's own agent", async () => {
  const SUB = newId("res");
  const d = daemon((op, a) =>
    op === "subagent_for"
      ? a.agent_id === "sub1"
        ? { resident_id: SUB }
        : null
      : op === "mailbox"
        ? { envelopes: [], read: [] }
        : { workers: [] },
  );
  const deps = {
    daemon: d.link,
    residentId: CHILD,
    folderId: FOLDER,
    host: "claude_code",
    signer,
    cwd: process.cwd(),
    loadSigner: async (rid: string) =>
      rid === SUB ? { ...signer, kid: "key_SUB" } : null,
  } as Parameters<typeof makeServer>[0];
  const server = makeServer(deps);
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  const transport = {
    onmessage: undefined as undefined | ((m: unknown) => void),
    onclose: undefined as undefined | (() => void),
    onerror: undefined as undefined | ((e: Error) => void),
    async start() {},
    async close() {},
    async send(m: Record<string, unknown>) {
      if (typeof m.id === "number") waiters.get(m.id)?.(m);
    },
  };
  await server.connect(transport as never);
  const req = (id: number, method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiters.set(id, resolve);
      transport.onmessage?.({ jsonrpc: "2.0", id, method, params });
    });
  await req(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "claude-code", version: "2.1.301" },
  });
  transport.onmessage?.({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  // `who` takes no arguments: the extra field must not fail validation, and is not passed on.
  const r = (await req(2, "tools/call", {
    name: "who",
    arguments: { hawl_agent: "sub1" },
  })) as { result: { isError?: boolean } };
  assert.notEqual(r.result.isError, true, JSON.stringify(r));
  const tool = d.calls.find((c) => c.op === "tool");
  assert.equal(tool?.args.resident_id, SUB);
  assert.deepEqual(tool?.args.args, {});
  // The subagent's mailbox call runs as the subagent (the helper reads only its own inbox).
  d.calls.length = 0;
  await req(3, "tools/call", {
    name: "mailbox",
    arguments: { hawl_agent: "sub1" },
  });
  assert.equal(d.calls.find((c) => c.op === "tool")?.args.resident_id, SUB);
  // No agent of its own for this subagent (its open failed, the cap was hit, or this server is
  // the folder's after a fallback): the call works as before, as this server's own agent.
  d.calls.length = 0;
  const u = (await req(4, "tools/call", {
    name: "who",
    arguments: { hawl_agent: "nope" },
  })) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.notEqual(u.result.isError, true, JSON.stringify(u));
  const own = d.calls.find((c) => c.op === "tool");
  assert.equal(own?.args.resident_id, CHILD);
  assert.deepEqual(own?.args.args, {});
  // A daemon that cannot answer at all: the same, the tag dropped.
  const down = daemon((op) => {
    if (op === "subagent_for") throw new Error("daemon gone");
    return { workers: [] };
  });
  const fb = await actingAs(
    { ...deps, daemon: down.link },
    { hawl_agent: "sub1", x: 1 },
  );
  assert.equal(fb.deps.residentId, CHILD);
  assert.deepEqual(fb.args, { x: 1 });
  // The terminal's own deps never changed.
  assert.equal(deps.residentId, CHILD);
  assert.equal(deps.signer?.kid, "key_X");
});
