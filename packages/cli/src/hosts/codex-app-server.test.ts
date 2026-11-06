import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CodexAppServer, type ProcLike } from "./codex-app-server.ts";

function fake(completeTurns = true) {
  const out = new PassThrough();
  const sent: any[] = [];
  const ev = new EventEmitter();
  let killed = false;
  const reply = (o: unknown) => out.write(`${JSON.stringify(o)}\n`);
  const p: ProcLike = {
    stdin: {
      write(s: string) {
        const m = JSON.parse(s);
        sent.push(m);
        if (m.id === undefined) return;
        if (m.method === "thread/start")
          reply({ id: m.id, result: { thread: { id: "T1" } } });
        else if (m.method === "turn/start") {
          reply({ id: m.id, result: { turn: { id: "u1" } } });
          if (completeTurns)
            reply({
              method: "turn/completed",
              params: { threadId: m.params.threadId },
            });
        } else reply({ id: m.id, result: {} });
      },
    },
    stdout: out,
    kill() {
      killed = true;
    },
    on: (e, cb) => ev.on(e, cb),
  };
  return { p, sent, killed: () => killed };
}

test("turn payload carries only the fixed template", async () => {
  const f = fake();
  const s = new CodexAppServer({ cwd: "/fixed", spawnFn: () => f.p });
  assert.equal(s.sensitive, true);
  assert.equal(await s.wake(3), true);
  const turn = f.sent.find((m) => m.method === "turn/start");
  assert.deepEqual(turn.params, {
    threadId: "T1",
    input: [
      {
        type: "text",
        text: "\u{1F4EC} Hawl: 3 waiting. Call the mailbox tool.",
      },
    ],
    effort: "low",
  });
  const start = f.sent.find((m) => m.method === "thread/start");
  assert.equal(start.params.cwd, "/fixed");
  assert.equal(start.params.approvalPolicy, "never");
  assert.equal(start.params.sandbox, "read-only");
  s.stop();
});

test("no notice, no turn; resume uses the given thread id", async () => {
  const f = fake();
  const s = new CodexAppServer({
    cwd: "/c",
    threadId: "OLD",
    spawnFn: () => f.p,
  });
  assert.equal(await s.wake(0), false);
  assert.equal(f.sent.length, 0);
  await s.wake(1);
  assert.ok(
    f.sent.some(
      (m) => m.method === "thread/resume" && m.params.threadId === "OLD",
    ),
  );
  s.stop();
});

test("bounded runtime: a turn that never completes is killed", async () => {
  const f = fake(false);
  const s = new CodexAppServer({
    cwd: "/c",
    turnTimeoutMs: 50,
    spawnFn: () => f.p,
  });
  await assert.rejects(s.wake(2), /timeout/);
  assert.equal(f.killed(), true);
});
