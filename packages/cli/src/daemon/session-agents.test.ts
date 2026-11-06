import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { newId } from "@hawl/protocol/src/ids.ts";
import { pino } from "pino";
import { generateWorkerKey, MemoryKeyStore } from "./keys.ts";
import { startDaemon } from "./main.ts";
import { ManifestStore } from "./manifest.ts";
import {
  readSessionAgents,
  sessionKeyFor,
  sessionsPath,
} from "./session-agents.ts";
import { request } from "./socket.ts";
import { Spool } from "./spool.ts";
import { makeEnvelope, makeRelayKey, makeRoot, tmpState } from "./testkit.ts";

const RELAY = "http://127.0.0.1:9";

/** A relay stand-in for the two HTTP calls `session_open` makes. */
function fakeRelay(o: { sessions?: boolean } = {}) {
  /** Public keys the relay has retired (their terminal's name went to a newer one). */
  const retired = new Set<string>();
  const calls: { session_key: string; public_jwk: Record<string, string> }[] =
    [];
  const byKey = new Map<string, string>();
  const handles = new Map<string, string>();
  const closed: string[] = [];
  /** The next `close` close calls fail like a dropped connection. */
  const down = { close: 0 };
  const names = ["otter", "heron", "fox"];
  /** Agents with a handover waiting (GET /v1/inbox?limit=0 answers handover: true for them). */
  const handovers = new Set<string>();
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/auth/token") {
      // The token names the agent whose key signed the assertion.
      const jwt = (
        JSON.parse(String(init?.body)) as { client_assertion: string }
      ).client_assertion;
      const sub = (
        JSON.parse(
          Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString(),
        ) as {
          sub: string;
        }
      ).sub;
      return Response.json({
        access_token: `tok:${sub}`,
        token_type: "Bearer",
      });
    }
    if (url.pathname === "/v1/inbox") {
      const who = String(new Headers(init?.headers).get("authorization")).slice(
        "Bearer tok:".length,
      );
      return Response.json({
        unread: 0,
        open_work: 0,
        handover: handovers.has(who),
        goal_rev: `rev-${who}`,
      });
    }
    if (url.pathname === "/v1/residents/me/sessions/close") {
      if (down.close > 0) {
        down.close--;
        throw new Error("simulated connection reset");
      }
      closed.push(
        (JSON.parse(String(init?.body)) as { resident_id: string }).resident_id,
      );
      return Response.json({ closed: true });
    }
    if (url.pathname === "/v1/residents/me/sessions" && o.sessions !== false) {
      const body = JSON.parse(String(init?.body)) as (typeof calls)[number];
      calls.push(body);
      if (retired.has(body.public_jwk.x ?? ""))
        return Response.json(
          { error: { code: "invalid_state", message: "retired" } },
          { status: 409 },
        );
      const replaces = (body as { replaces?: string }).replaces;
      let rid = byKey.get(body.session_key);
      if (!rid && replaces && byKey.has(replaces)) {
        // Codex: the provisional agent takes this session.
        rid = byKey.get(replaces) as string;
        byKey.set(body.session_key, rid);
        byKey.delete(replaces);
      } else if (rid && replaces) byKey.delete(replaces);
      if (!rid) {
        rid = newId("res");
        byKey.set(body.session_key, rid);
        handles.set(rid, names[handles.size] ?? "x");
      }
      const handle = handles.get(rid) ?? "x";
      return Response.json({
        resident_id: rid,
        handle,
        display_name: `Aaron's Claude · ${handle[0]?.toUpperCase()}${handle.slice(1)}`,
        session_of: "res_folder",
        reused: false,
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, retired, closed, handovers, down };
}

async function setup(
  o: {
    sessions?: boolean;
    now?: () => number;
    closedSweepMs?: number;
    pidAlive?: (pid: number) => boolean;
  } = {},
) {
  const stateDir = tmpState();
  const keyStore = new MemoryKeyStore();
  const folder = newId("res");
  await keyStore.set(folder, generateWorkerKey().privateJwk);
  const relay = fakeRelay(o);
  const d = await startDaemon({
    stateDir,
    keyStore,
    manifests: new ManifestStore(stateDir, makeRoot().roots),
    fetch: relay.fetch,
    idleWakeSweepMs: 0,
    now: o.now,
    closedSweepMs: o.closedSweepMs,
    pidAlive: o.pidAlive,
  });
  const call = (op: string, args: Record<string, unknown> = {}) =>
    request(d.socketPath, { op, token: d.token, ...args });
  const r = await call("attach", {
    worker: { relay_url: RELAY, resident_id: folder, platform: "claude_code" },
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { stateDir, keyStore, folder, relay, d, call };
}

type Opened = {
  resident_id: string;
  handle: string;
  display_name: string;
  session_of: string;
};

test("each terminal in a folder opens its own agent; the same session id gets the same one", async () => {
  const { stateDir, keyStore, folder, relay, d, call } = await setup();
  try {
    const a = await call("session_open", {
      resident_id: folder,
      host_session_id: "claude-session-A",
      host: "claude_code",
    });
    const b = await call("session_open", {
      resident_id: folder,
      host_session_id: "claude-session-B",
    });
    assert.equal(a.ok && b.ok, true, JSON.stringify([a, b]));
    const A = a.ok ? (a.result as Opened) : (null as never);
    const B = b.ok ? (b.result as Opened) : (null as never);
    assert.equal(A.handle, "otter");
    assert.equal(B.handle, "heron");
    assert.notEqual(A.resident_id, B.resident_id);
    assert.equal(A.session_of, folder);
    // Its key is stored for the MCP process to sign with; the relay only ever saw a hash.
    assert.ok(await keyStore.get(A.resident_id));
    assert.equal(
      relay.calls[0]?.session_key,
      sessionKeyFor(folder, "claude-session-A"),
    );
    assert.ok(
      !readFileSync(sessionsPath(stateDir), "utf8").includes(
        "claude-session-A",
      ),
    );
    assert.equal(readSessionAgents(stateDir).length, 2);
    // Both are attached as their own workers, not remembered as folders.
    const st = await call("status");
    const ws = (st.ok ? st.result : null) as {
      workers: { resident_id: string; session_of?: string }[];
    };
    assert.equal(
      ws.workers.find((x) => x.resident_id === A.resident_id)?.session_of,
      folder,
    );
    const remembered = JSON.parse(
      readFileSync(join(stateDir, "workers.json"), "utf8"),
    ) as {
      workers: { resident_id: string }[];
    };
    assert.deepEqual(
      remembered.workers.map((x) => x.resident_id),
      [folder],
    );
    // `claude --resume`: same session id, same agent, and the key this machine holds is reused.
    const again = await call("session_open", {
      resident_id: folder,
      host_session_id: "claude-session-A",
    });
    assert.equal(
      again.ok && (again.result as Opened).resident_id,
      A.resident_id,
    );
    assert.equal(relay.calls[2]?.public_jwk.x, relay.calls[0]?.public_jwk.x);
    // A session agent cannot open sessions of its own.
    const nested = await call("session_open", {
      resident_id: A.resident_id,
      host_session_id: "x",
    });
    assert.equal(nested.ok, false);
  } finally {
    await d.stop();
  }
});

test("a terminal's notice counts its own mail plus the folder's; closing it lets the agent go", async () => {
  const { stateDir, folder, d, call } = await setup();
  try {
    const a = await call("session_open", {
      resident_id: folder,
      host_session_id: "sess-1",
    });
    const A = (a.ok ? a.result : null) as Opened;
    const relayKey = makeRelayKey();
    new Spool(join(stateDir, "spool"), A.resident_id).put(
      makeEnvelope(relayKey.privateKey, A.resident_id, { seq: 1 }).env,
    );
    new Spool(join(stateDir, "spool"), folder).put(
      makeEnvelope(relayKey.privateKey, folder, { seq: 1 }).env,
    );
    const mine = await call("notice", { resident_id: A.resident_id });
    assert.equal(mine.ok && (mine.result as { unread: number }).unread, 2);
    // The hook only knows the folder; with the host's session id it counts that terminal too.
    const viaFolder = await call("notice", {
      resident_id: folder,
      host_session_id: "sess-1",
    });
    assert.equal(
      viaFolder.ok && (viaFolder.result as { unread: number }).unread,
      2,
    );
    const folderOnly = await call("notice", { resident_id: folder });
    assert.equal(
      folderOnly.ok && (folderOnly.result as { unread: number }).unread,
      1,
    );

    // Goodbye from the terminal: its agent's socket is let go.
    await call("agent_session", {
      resident_id: A.resident_id,
      host_session_id: "sess-1",
      state: "bye",
    });
    const st = await call("status");
    const ws = (st.ok ? st.result : null) as {
      workers: { resident_id: string }[];
    };
    assert.ok(!ws.workers.some((x) => x.resident_id === A.resident_id));
    // A call for it (daemon restarted under an open terminal) attaches it again.
    const mb = await call("mailbox", { resident_id: A.resident_id });
    assert.equal(mb.ok, true, JSON.stringify(mb));

    // `hawl leave` on the folder forgets its terminals.
    await call("detach", { resident_id: folder, destroy_spool: true });
    assert.equal(readSessionAgents(stateDir).length, 0);
    const st2 = await call("status");
    assert.equal(
      ((st2.ok ? st2.result : null) as { workers: unknown[] }).workers.length,
      0,
    );
  } finally {
    await d.stop();
  }
});

test("an older relay without session agents answers unsupported, so the folder's worker is used", async () => {
  const { folder, d, call } = await setup({ sessions: false });
  try {
    const r = await call("session_open", {
      resident_id: folder,
      host_session_id: "s",
    });
    assert.equal(r.ok, true);
    assert.equal(
      (r.ok ? r.result : (null as never as { unsupported: boolean })) &&
        (r.result as { unsupported?: boolean }).unsupported,
      true,
    );
  } finally {
    await d.stop();
  }
});

test("resuming with a key the relay retired asks again with a new key and stores that one", async () => {
  const { keyStore, folder, relay, d, call } = await setup();
  try {
    const a = await call("session_open", {
      resident_id: folder,
      host_session_id: "old-terminal",
    });
    assert.equal(a.ok, true, JSON.stringify(a));
    const first = relay.calls[0]?.public_jwk.x as string;
    relay.retired.add(first);
    const again = await call("session_open", {
      resident_id: folder,
      host_session_id: "old-terminal",
    });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(relay.calls.length, 3, "the old key, then a new one");
    assert.equal(relay.calls[1]?.public_jwk.x, first);
    const second = relay.calls[2]?.public_jwk.x as string;
    assert.notEqual(second, first);
    const rid = (again.ok ? again.result : null) as { resident_id: string };
    assert.equal((await keyStore.get(rid.resident_id))?.x, second);
  } finally {
    await d.stop();
  }
});

test("Codex: the provisional session is handed to Codex's id, and a resume drops the provisional agent", async () => {
  const { stateDir, keyStore, folder, relay, d, call } = await setup();
  try {
    const open = async (args: Record<string, unknown>) => {
      const r = await call("session_open", { resident_id: folder, ...args });
      assert.equal(r.ok, true, JSON.stringify(r));
      return (r.ok ? r.result : null) as Opened;
    };
    // A new Codex session: started provisional, then bound to Codex's session id.
    const prov = await open({ host_session_id: "prov-1", host: "codex" });
    const provKey = (await keyStore.get(prov.resident_id))?.x;
    const bound = await open({
      host_session_id: "codex-S",
      replaces_host_session_id: "prov-1",
    });
    const sent = relay.calls.at(-1) as (typeof relay.calls)[number] & {
      replaces?: string;
    };
    assert.equal(sent.session_key, sessionKeyFor(folder, "codex-S"));
    assert.equal(sent.replaces, sessionKeyFor(folder, "prov-1"));
    assert.equal(sent.public_jwk.x, provKey, "the provisional agent's own key");
    assert.equal(bound.resident_id, prov.resident_id);
    assert.deepEqual(
      readSessionAgents(stateDir).map((x) => [x.resident_id, x.session_key]),
      [[prov.resident_id, sessionKeyFor(folder, "codex-S")]],
    );
    // `codex resume codex-S` in a new process: starts provisional (a new agent), then resumes.
    const prov2 = await open({ host_session_id: "prov-2", host: "codex" });
    assert.notEqual(prov2.resident_id, prov.resident_id);
    const back = await open({
      host_session_id: "codex-S",
      replaces_host_session_id: "prov-2",
    });
    assert.equal(back.resident_id, prov.resident_id);
    assert.equal(
      relay.calls.at(-1)?.public_jwk.x,
      provKey,
      "resumed with its key",
    );
    assert.deepEqual(
      readSessionAgents(stateDir).map((x) => x.resident_id),
      [prov.resident_id],
      "the retired provisional agent is forgotten",
    );
    const st = await call("status");
    const ws = (st.ok ? st.result : null) as {
      workers: { resident_id: string }[];
    };
    assert.ok(
      !ws.workers.some((x) => x.resident_id === prov2.resident_id),
      "and its socket let go",
    );
  } finally {
    await d.stop();
  }
});

test("the daemon's host-session list (`hawl agents`) never overwrites the terminal agents' list", async () => {
  const { stateDir, folder, relay, d, call } = await setup();
  try {
    const a = await call("session_open", {
      resident_id: folder,
      host_session_id: "claude-session-A",
    });
    assert.equal(a.ok, true, JSON.stringify(a));
    const A = (a.ok ? a.result : null) as Opened;
    // The MCP process announces itself: the daemon logs the host session for `hawl agents`.
    const h = await call("host_session", {
      resident_id: A.resident_id,
      host_session_id: "claude-session-A",
      host: "claude_code",
      root: stateDir,
    });
    assert.equal(h.ok, true, JSON.stringify(h));
    assert.equal(readSessionAgents(stateDir).length, 1, "still listed");
    // `claude --resume`: the key this machine holds is sent again, not a new one.
    const again = await call("session_open", {
      resident_id: folder,
      host_session_id: "claude-session-A",
    });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(relay.calls[1]?.public_jwk.x, relay.calls[0]?.public_jwk.x);
  } finally {
    await d.stop();
  }
});

test("invariant: an ended subagent's record stays until the relay confirms it retired", async () => {
  const { stateDir, folder, relay, d, call } = await setup();
  try {
    await call("session_open", {
      resident_id: folder,
      host_session_id: "claude-session-A",
    });
    const ids = {
      resident_id: folder,
      host_session_id: "claude-session-A",
      agent_id: "aa9feca500505fc51",
    };
    await call("subagent_open", { ...ids, agent_type: "reviewer" });
    const sub = (await call("subagent_for", {
      resident_id: (
        readSessionAgents(stateDir).find((x) => !x.spawned_by) as {
          resident_id: string;
        }
      ).resident_id,
      agent_id: ids.agent_id,
    })) as { ok: true; result: { resident_id: string } };
    const subId = sub.result.resident_id;
    // The relay is unreachable at SubagentStop: not reported closed, record kept, no acting as it.
    relay.down.close = 1;
    const c1 = await call("subagent_close", ids);
    assert.deepEqual(c1.ok && c1.result, { closed: false });
    assert.deepEqual(relay.closed, []);
    assert.ok(readSessionAgents(stateDir).some((x) => x.resident_id === subId));
    const terminal = readSessionAgents(stateDir).find((x) => !x.spawned_by);
    const f = await call("subagent_for", {
      resident_id: terminal?.resident_id,
      agent_id: ids.agent_id,
    });
    assert.equal(f.ok && f.result, null);
    // Once the relay is back, the next Stop retires it and only then forgets it.
    const c2 = await call("subagent_close", ids);
    assert.deepEqual(c2.ok && c2.result, { closed: true });
    assert.deepEqual(relay.closed, [subId]);
    assert.ok(
      !readSessionAgents(stateDir).some((x) => x.resident_id === subId),
    );
  } finally {
    await d.stop();
  }
});

test("a Claude Code subagent gets its own agent under its terminal, and ends with SubagentStop", async () => {
  const { stateDir, keyStore, folder, relay, d, call } = await setup();
  try {
    const a = await call("session_open", {
      resident_id: folder,
      host_session_id: "claude-session-A",
    });
    const A = (a.ok ? a.result : null) as Opened;
    // SubagentStart: the hook names the folder, the session and the subagent.
    const s = await call("subagent_open", {
      resident_id: folder,
      host_session_id: "claude-session-A",
      agent_id: "aa9feca500505fc50",
      agent_type: "reviewer",
    });
    assert.equal(s.ok, true, JSON.stringify(s));
    // The terminal's MCP server asks which agent a tool call with hawl_agent acts as.
    const f = await call("subagent_for", {
      resident_id: A.resident_id,
      agent_id: "aa9feca500505fc50",
    });
    const sub = (f.ok ? f.result : null) as { resident_id: string | null };
    assert.ok(sub?.resident_id, JSON.stringify(f));
    assert.notEqual(sub.resident_id, A.resident_id);
    const opened = relay.calls[1] as unknown as Record<string, unknown>;
    assert.equal(opened.spawned_by, A.resident_id);
    assert.equal(opened.agent_type, "reviewer");
    assert.equal(
      opened.session_key,
      sessionKeyFor(folder, "claude-session-A|aa9feca500505fc50"),
    );
    assert.ok(await keyStore.get(sub.resident_id as string));
    // Only its own terminal can act as it.
    const other = await call("subagent_for", {
      resident_id: folder,
      agent_id: "aa9feca500505fc50",
    });
    assert.equal((other.ok ? other.result : null) as unknown, null);
    // SubagentStop: closed on the relay, socket gone, local entry forgotten.
    const c = await call("subagent_close", {
      resident_id: folder,
      host_session_id: "claude-session-A",
      agent_id: "aa9feca500505fc50",
    });
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.deepEqual(relay.closed, [sub.resident_id]);
    const st = await call("status");
    const ws = (st.ok ? st.result : null) as {
      workers: { resident_id: string }[];
    };
    assert.ok(!ws.workers.some((w) => w.resident_id === sub.resident_id));
    assert.ok(
      !readSessionAgents(stateDir).some(
        (x) => x.resident_id === sub.resident_id,
      ),
    );
    const gone = await call("subagent_for", {
      resident_id: A.resident_id,
      agent_id: "aa9feca500505fc50",
    });
    assert.equal((gone.ok ? gone.result : null) as unknown, null);
  } finally {
    await d.stop();
  }
});

test("after /clear (a new session id in the hooks, same MCP server), the terminal is found by Claude Code's pid", async () => {
  const { folder, d, call } = await setup();
  try {
    const a = await call("session_open", {
      resident_id: folder,
      host_session_id: "claude-session-A",
      ppid: 4242, // the MCP server's parent: Claude Code
    });
    const A = (a.ok ? a.result : null) as Opened;
    // Hooks now report the cleared session's id, with CLAUDE_PID.
    const s = await call("subagent_open", {
      resident_id: folder,
      host_session_id: "claude-session-A-cleared",
      claude_pid: 4242,
      agent_id: "sub9",
      agent_type: "reviewer",
    });
    assert.deepEqual(s.ok ? s.result : s, { opened: true });
    const f = await call("subagent_for", {
      resident_id: A.resident_id,
      agent_id: "sub9",
    });
    assert.ok((f.ok ? f.result : null) as { resident_id: string } | null);
    // Another Claude Code's hooks never match it.
    const other = await call("subagent_open", {
      resident_id: folder,
      host_session_id: "someone-else",
      claude_pid: 5555,
      agent_id: "sub10",
    });
    assert.deepEqual(other.ok ? other.result : other, { opened: false });
  } finally {
    await d.stop();
  }
});

test("after /clear, a pid two terminals share matches neither (no guessing)", async () => {
  const { folder, d, call } = await setup();
  try {
    for (const hsid of ["claude-session-A", "claude-session-B"])
      await call("session_open", {
        resident_id: folder,
        host_session_id: hsid,
        ppid: 4242,
      });
    const s = await call("subagent_open", {
      resident_id: folder,
      host_session_id: "claude-session-A-cleared",
      claude_pid: 4242,
      agent_id: "sub11",
    });
    assert.deepEqual(s.ok ? s.result : s, { opened: false });
  } finally {
    await d.stop();
  }
});

test("a terminal that closes ends its open subagents too", async () => {
  const { folder, relay, d, call } = await setup();
  try {
    const a = await call("session_open", {
      resident_id: folder,
      host_session_id: "claude-session-A",
    });
    const A = (a.ok ? a.result : null) as Opened;
    await call("subagent_open", {
      resident_id: folder,
      host_session_id: "claude-session-A",
      agent_id: "sub1",
      agent_type: "Explore",
    });
    const f = await call("subagent_for", {
      resident_id: A.resident_id,
      agent_id: "sub1",
    });
    const sub = (f.ok ? f.result : null) as { resident_id: string };
    assert.ok(sub?.resident_id);
    await call("agent_session", {
      resident_id: A.resident_id,
      host_session_id: "claude-session-A",
      state: "bye",
    });
    // The close is sent in the background.
    for (let i = 0; i < 50 && relay.closed.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(relay.closed, [sub.resident_id]);
  } finally {
    await d.stop();
  }
});

test("a terminal whose heartbeats only lapse (PC asleep) keeps its subagents; they come back with it", async () => {
  let t = Date.now();
  const { folder, relay, d, call } = await setup({
    now: () => t,
    closedSweepMs: 20,
  });
  try {
    const a = await call("session_open", {
      resident_id: folder,
      host_session_id: "claude-session-A",
    });
    const A = (a.ok ? a.result : null) as Opened;
    await call("subagent_open", {
      resident_id: folder,
      host_session_id: "claude-session-A",
      agent_id: "sub1",
      agent_type: "Explore",
    });
    const f = await call("subagent_for", {
      resident_id: A.resident_id,
      agent_id: "sub1",
    });
    const sub = (f.ok ? f.result : null) as { resident_id: string };
    assert.ok(sub?.resident_id);
    const held = async () => {
      const st = await call("status");
      return (
        (st.ok ? st.result : null) as { workers: { resident_id: string }[] }
      ).workers.map((w) => w.resident_id);
    };
    // No heartbeat for a minute: both go offline, nothing is retired.
    t += 60_000;
    for (let i = 0; i < 50 && (await held()).includes(A.resident_id); i++)
      await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    const asleep = await held();
    assert.ok(!asleep.includes(A.resident_id), "terminal offline");
    assert.ok(!asleep.includes(sub.resident_id), "subagent offline");
    assert.deepEqual(relay.closed, []);
    // The PC wakes: the terminal's next heartbeat brings both back, the same subagent.
    await call("agent_session", {
      resident_id: A.resident_id,
      host_session_id: "claude-session-A",
      state: "live",
    });
    for (let i = 0; i < 50 && !(await held()).includes(sub.resident_id); i++)
      await new Promise((r) => setTimeout(r, 20));
    const awake = await held();
    assert.ok(awake.includes(A.resident_id), "terminal back");
    assert.ok(awake.includes(sub.resident_id), "subagent back");
    const f2 = await call("subagent_for", {
      resident_id: A.resident_id,
      agent_id: "sub1",
    });
    assert.deepEqual(f2.ok && f2.result, { resident_id: sub.resident_id });
    assert.deepEqual(relay.closed, []);
  } finally {
    await d.stop();
  }
});

test("a terminal whose host process is gone goes offline at the next sweep, not after the heartbeat timeout", async () => {
  // The clock never moves: only the dead process can take the terminal offline here.
  let alive = true;
  const { folder, relay, d, call } = await setup({
    now: () => 1_000,
    closedSweepMs: 20,
    pidAlive: () => alive,
  });
  try {
    const a = await call("session_open", {
      resident_id: folder,
      host_session_id: "claude-session-A",
      ppid: 4242,
    });
    const A = (a.ok ? a.result : null) as Opened;
    await call("agent_session", {
      resident_id: A.resident_id,
      host_session_id: "claude-session-A",
      state: "live",
    });
    const held = async () => {
      const st = await call("status");
      return (
        (st.ok ? st.result : null) as { workers: { resident_id: string }[] }
      ).workers.map((w) => w.resident_id);
    };
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(
      (await held()).includes(A.resident_id),
      "open while its host runs",
    );
    alive = false;
    for (let i = 0; i < 50 && (await held()).includes(A.resident_id); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      !(await held()).includes(A.resident_id),
      "offline once its host is gone",
    );
    assert.deepEqual(relay.closed, []);
  } finally {
    await d.stop();
  }
});

const res = <T>(r: { ok: boolean; result?: unknown }) =>
  (r.ok ? r.result : r) as T;

test("invariant: hook ops sent with the folder id and a session act as that session's agent", async () => {
  const { folder, d, call } = await setup();
  try {
    const open = async (hsid: string) =>
      res<Opened>(
        await call("session_open", {
          resident_id: folder,
          host_session_id: hsid,
        }),
      );
    const A = await open("S-A");
    const B = await open("S-B");
    await call("subagent_open", {
      resident_id: folder,
      host_session_id: "S-A",
      agent_id: "subq",
      agent_type: "reviewer",
    });
    const sub = res<{ resident_id: string }>(
      await call("subagent_for", {
        resident_id: A.resident_id,
        agent_id: "subq",
      }),
    ).resident_id;
    const as = async (op: string, extra: Record<string, unknown>) => {
      const r = await call(op, { resident_id: folder, ...extra });
      assert.equal(r.ok, true, JSON.stringify(r));
      return res<{ as?: string; quiet_ms?: unknown }>(r);
    };
    for (const [ids, want] of [
      [{ host_session_id: "S-A" }, A.resident_id],
      [{ host_session_id: "S-B" }, B.resident_id],
      [{ host_session_id: "S-A", agent_id: "subq" }, sub],
      [{}, folder],
    ] as const) {
      const at = JSON.stringify(ids);
      assert.equal((await as("notice", ids)).as, want, `notice ${at}`);
      assert.equal(
        (await as("peers", { ...ids, nowait: true })).as,
        want,
        `peers ${at}`,
      );
      assert.equal(
        (await as("overlap", { ...ids, path: "a.ts" })).as,
        want,
        `overlap ${at}`,
      );
    }
    // Activity in terminal A never makes terminal B look busy (B's idle wake must still fire).
    await call("activity", {
      resident_id: folder,
      line: { kind: "tool_after", host: "claude_code", session_id: "S-A" },
    });
    assert.equal(
      (await as("notice", { host_session_id: "S-B" })).quiet_ms,
      null,
    );
    assert.equal(
      typeof (await as("notice", { host_session_id: "S-A" })).quiet_ms,
      "number",
    );
  } finally {
    await d.stop();
  }
});

test("SessionStart's handover comes from the terminal's own agent (its key), not another terminal's", async () => {
  const { folder, relay, d, call } = await setup();
  try {
    const A = res<Opened>(
      await call("session_open", {
        resident_id: folder,
        host_session_id: "S-A",
      }),
    );
    await call("session_open", { resident_id: folder, host_session_id: "S-B" });
    relay.handovers.add(A.resident_id);
    const extras = async (hsid: string) =>
      res<{ handover?: boolean }>(
        await call("notice", {
          resident_id: folder,
          host_session_id: hsid,
          extras: true,
        }),
      ).handover;
    assert.equal(await extras("S-A"), true);
    assert.equal(await extras("S-B"), false);
  } finally {
    await d.stop();
  }
});

test("the goal op returns the terminal's own agent's goal token", async () => {
  const { folder, d, call } = await setup();
  try {
    const A = res<Opened>(
      await call("session_open", {
        resident_id: folder,
        host_session_id: "S-A",
      }),
    );
    const g = res<{ goal_rev?: string }>(
      await call("goal", { resident_id: folder, host_session_id: "S-A" }),
    );
    assert.equal(g.goal_rev, `rev-${A.resident_id}`);
  } finally {
    await d.stop();
  }
});

test("invariant: a daemon restart keeps every running subagent's own agent", async () => {
  const { stateDir, keyStore, folder, relay, d, call } = await setup();
  const A = res<Opened>(
    await call("session_open", {
      resident_id: folder,
      host_session_id: "S-A",
      ppid: 4242,
    }),
  );
  await call("subagent_open", {
    resident_id: folder,
    host_session_id: "S-A",
    agent_id: "subr",
    agent_type: "reviewer",
  });
  const sub = res<{ resident_id: string }>(
    await call("subagent_for", {
      resident_id: A.resident_id,
      agent_id: "subr",
    }),
  );
  assert.ok(sub?.resident_id);
  await d.stop();
  const d2 = await startDaemon({
    stateDir,
    keyStore,
    manifests: new ManifestStore(stateDir, makeRoot().roots),
    fetch: relay.fetch,
    idleWakeSweepMs: 0,
  });
  const call2 = (op: string, args: Record<string, unknown> = {}) =>
    request(d2.socketPath, { op, token: d2.token, ...args });
  try {
    await call2("attach", {
      worker: {
        relay_url: RELAY,
        resident_id: folder,
        platform: "claude_code",
      },
    });
    // The terminal's MCP server beats again.
    await call2("agent_session", {
      resident_id: A.resident_id,
      host_session_id: "S-A",
      state: "live",
    });
    assert.deepEqual(
      res(
        await call2("subagent_for", {
          resident_id: A.resident_id,
          agent_id: "subr",
        }),
      ),
      { resident_id: sub.resident_id },
    );
    // Its hook calls still name it, also after /clear (its terminal found by Claude's pid).
    const n = res<{ as?: string }>(
      await call2("notice", {
        resident_id: folder,
        host_session_id: "S-A-cleared",
        claude_pid: 4242,
        agent_id: "subr",
      }),
    );
    assert.equal(n.as, sub.resident_id);
    // An id this machine never opened: no agent (the MCP server then refuses the call).
    assert.equal(
      res(
        await call2("subagent_for", {
          resident_id: A.resident_id,
          agent_id: "nope1",
        }),
      ),
      null,
    );
    // SubagentStop after the restart still retires it on the relay.
    await call2("subagent_close", {
      resident_id: folder,
      host_session_id: "S-A",
      agent_id: "subr",
    });
    assert.deepEqual(relay.closed, [sub.resident_id]);
  } finally {
    await d2.stop();
  }
});

test("invariant: SubagentStop right after a daemon restart (before any heartbeat) still retires it", async () => {
  const { stateDir, keyStore, folder, relay, d, call } = await setup();
  const A = res<Opened>(
    await call("session_open", { resident_id: folder, host_session_id: "S-A" }),
  );
  const ids = { resident_id: folder, host_session_id: "S-A", agent_id: "subq" };
  await call("subagent_open", { ...ids, agent_type: "reviewer" });
  const sub = res<{ resident_id: string }>(
    await call("subagent_for", {
      resident_id: A.resident_id,
      agent_id: "subq",
    }),
  );
  await d.stop();
  const d2 = await startDaemon({
    stateDir,
    keyStore,
    manifests: new ManifestStore(stateDir, makeRoot().roots),
    fetch: relay.fetch,
    idleWakeSweepMs: 0,
  });
  const call2 = (op: string, args: Record<string, unknown> = {}) =>
    request(d2.socketPath, { op, token: d2.token, ...args });
  try {
    await call2("attach", {
      worker: {
        relay_url: RELAY,
        resident_id: folder,
        platform: "claude_code",
      },
    });
    // No heartbeat from the terminal yet: the Stop comes first.
    assert.deepEqual(res(await call2("subagent_close", ids)), { closed: true });
    assert.deepEqual(relay.closed, [sub.resident_id]);
    // The terminal's next heartbeat does not bring the ended subagent back.
    await call2("agent_session", {
      resident_id: A.resident_id,
      host_session_id: "S-A",
      state: "live",
    });
    assert.ok(
      !readSessionAgents(stateDir).some(
        (x) => x.resident_id === sub.resident_id,
      ),
    );
    assert.equal(
      res(
        await call2("subagent_for", {
          resident_id: A.resident_id,
          agent_id: "subq",
        }),
      ),
      null,
    );
  } finally {
    await d2.stop();
  }
});

test("invariant: a session seen after /clear resumes as the same terminal agent", async () => {
  const { folder, d, call } = await setup();
  try {
    const A = res<Opened>(
      await call("session_open", {
        resident_id: folder,
        host_session_id: "S-1",
        ppid: 5151,
      }),
    );
    // /clear: the hooks report a new session id from the same Claude Code process.
    const n = res<{ as?: string }>(
      await call("notice", {
        resident_id: folder,
        host_session_id: "S-1-cleared",
        claude_pid: 5151,
      }),
    );
    assert.equal(n.as, A.resident_id);
    // Later `claude --resume S-1-cleared`: the same agent (name, inbox, handover).
    const again = res<Opened>(
      await call("session_open", {
        resident_id: folder,
        host_session_id: "S-1-cleared",
        ppid: 7777,
      }),
    );
    assert.equal(again.resident_id, A.resident_id);
    assert.equal(again.handle, A.handle);
    // And the session from before /clear still resumes as it too.
    const back = res<Opened>(
      await call("session_open", {
        resident_id: folder,
        host_session_id: "S-1",
        ppid: 8888,
      }),
    );
    assert.equal(back.resident_id, A.resident_id);
    // `claude --continue` after another /clear: its MCP server starts on a fresh id (a provisional
    // agent), then follows the hooks' id to the terminal it was.
    await call("notice", {
      resident_id: folder,
      host_session_id: "S-1-cleared-2",
      claude_pid: 8888,
    });
    const prov = res<Opened>(
      await call("session_open", {
        resident_id: folder,
        host_session_id: "fresh-X",
        ppid: 9999,
      }),
    );
    assert.notEqual(prov.resident_id, A.resident_id);
    const followed = res<Opened>(
      await call("session_open", {
        resident_id: folder,
        host_session_id: "S-1-cleared-2",
        replaces_host_session_id: "fresh-X",
        ppid: 9999,
      }),
    );
    assert.equal(followed.resident_id, A.resident_id);
  } finally {
    await d.stop();
  }
});

test("invariant: concurrent calls for a session agent after a restart open one connection, not two", async () => {
  const { stateDir, keyStore, folder, relay, d, call } = await setup();
  const A = res<Opened>(
    await call("session_open", {
      resident_id: folder,
      host_session_id: "S-race",
    }),
  );
  await d.stop();
  const lines: { worker?: string; state?: string; msg?: string }[] = [];
  // An OS keychain answers slowly, so both calls are inside attach at once.
  const slowKeys = {
    kind: keyStore.kind,
    get: async (a: string) => {
      await new Promise((r) => setTimeout(r, 50));
      return keyStore.get(a);
    },
    set: (a: string, k: Parameters<typeof keyStore.set>[1]) =>
      keyStore.set(a, k),
    delete: (a: string) => keyStore.delete(a),
  };
  const d2 = await startDaemon({
    stateDir,
    keyStore: slowKeys,
    manifests: new ManifestStore(stateDir, makeRoot().roots),
    fetch: relay.fetch,
    idleWakeSweepMs: 0,
    log: pino({}, { write: (l: string) => void lines.push(JSON.parse(l)) }),
  });
  const call2 = (op: string, args: Record<string, unknown> = {}) =>
    request(d2.socketPath, { op, token: d2.token, ...args });
  try {
    await call2("attach", {
      worker: {
        relay_url: RELAY,
        resident_id: folder,
        platform: "claude_code",
      },
    });
    // Two tool calls land together on the session agent the new daemon does not hold yet.
    const [a, b] = await Promise.all([
      call2("mailbox", { resident_id: A.resident_id }),
      call2("mailbox", { resident_id: A.resident_id }),
    ]);
    assert.equal(a.ok && b.ok, true, JSON.stringify([a, b]));
    // Each socket start logs one "connecting"; each later close logs "ws closed" then one more.
    const mine = lines.filter((l) => l.worker === A.resident_id);
    const connecting = mine.filter((l) => l.state === "connecting").length;
    const closed = mine.filter((l) => l.msg === "ws closed").length;
    assert.equal(connecting - closed, 1, JSON.stringify(mine));
  } finally {
    await d2.stop();
  }
});

test("keys do not pile up: every ended subagent's key is deleted with it", async () => {
  const { keyStore, folder, call, d } = await setup();
  try {
    await call("session_open", {
      resident_id: folder,
      host_session_id: "claude-session-K",
    });
    const before = (await keyStore.list()).length;
    for (let i = 0; i < 5; i++) {
      const ids = {
        resident_id: folder,
        host_session_id: "claude-session-K",
        agent_id: `agent-${i}`,
      };
      assert.equal((await call("subagent_open", ids)).ok, true);
      assert.equal((await call("subagent_close", ids)).ok, true);
    }
    assert.equal((await keyStore.list()).length, before);
  } finally {
    await d.stop();
  }
});

test("a server that fell back to the folder's identity keeps its terminal agent online, and its goodbye ends it", async () => {
  let t = Date.now();
  const { folder, d, call } = await setup({ now: () => t, closedSweepMs: 20 });
  try {
    const A = res<Opened>(
      await call("session_open", {
        resident_id: folder,
        host_session_id: "claude-session-A",
      }),
    );
    const held = async () =>
      res<{ workers: { resident_id: string }[] }>(
        await call("status"),
      ).workers.map((w) => w.resident_id);
    // Five minutes of heartbeats, every 20 s, all sent as the folder (the server's open timed out).
    for (let i = 0; i < 15; i++) {
      t += 20_000;
      await call("agent_session", {
        resident_id: folder,
        host_session_id: "claude-session-A",
        state: "live",
      });
      await new Promise((r) => setTimeout(r, 60));
      assert.ok((await held()).includes(A.resident_id), `offline at beat ${i}`);
    }
    await call("agent_session", {
      resident_id: folder,
      host_session_id: "claude-session-A",
      state: "bye",
    });
    for (let i = 0; i < 50 && (await held()).includes(A.resident_id); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(!(await held()).includes(A.resident_id), "goodbye ends it");
  } finally {
    await d.stop();
  }
});
