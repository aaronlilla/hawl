import assert from "node:assert/strict";
import { test } from "node:test";
import { ProcessActors } from "./process-actor.ts";

const tos = (r: { to: string | undefined; line: { kind: string } }[]) =>
  r.map((x) => `${x.to}:${x.line.kind}`);

test("a process shows on the row of the agent that ran it: subagent, its terminal, never the folder", () => {
  const a = new ProcessActors();
  a.started("s1", "TERM");
  a.noted("s1", "run tests", "SUB");
  // Linked to the subagent's call (reason inherited by the child): the subagent's row.
  assert.deepEqual(
    tos(
      a.route({
        kind: "process_start",
        session_id: "s1",
        pid: 10,
        reason: "run tests",
      }),
    ),
    ["SUB:process_start"],
  );
  assert.deepEqual(
    tos(a.route({ kind: "process_exit", session_id: "s1", pid: 10 })),
    ["SUB:process_exit"],
  );
  // Not linked to any call: the terminal's row.
  assert.deepEqual(
    tos(a.route({ kind: "process_start", session_id: "s1", pid: 11 })),
    ["TERM:process_start"],
  );
  // Unknown session: no agent (first connection, as before).
  assert.deepEqual(
    tos(a.route({ kind: "process_start", session_id: "s2", pid: 12 })),
    ["undefined:process_start"],
  );
  a.stopped("s1");
  assert.deepEqual(
    tos(
      a.route({
        kind: "process_start",
        session_id: "s1",
        pid: 13,
        reason: "run tests",
      }),
    ),
    ["undefined:process_start"],
  );
});

test("a subagent's Monitor shell, linked late, moves off its terminal's row and leaves no stale process there", () => {
  const a = new ProcessActors();
  a.started("s1", "TERM");
  a.noted("s1", "watch the build", "SUB");
  // The poll sees the shell first, with no reason yet: the terminal's row.
  assert.deepEqual(
    tos(a.route({ kind: "process_start", session_id: "s1", pid: 20 })),
    ["TERM:process_start"],
  );
  // ReasonLinker.confirm sends its start again with the Monitor's reason.
  assert.deepEqual(
    tos(
      a.route({
        kind: "process_start",
        session_id: "s1",
        pid: 20,
        reason: "watch the build",
      }),
    ),
    ["TERM:process_exit", "SUB:process_start"],
  );
  assert.deepEqual(
    tos(a.route({ kind: "process_exit", session_id: "s1", pid: 20 })),
    ["SUB:process_exit"],
  );
  // The terminal's own Monitor: confirmed on the same row, nothing moves.
  a.noted("s1", "tail the log", "TERM");
  a.route({ kind: "process_start", session_id: "s1", pid: 21 });
  assert.deepEqual(
    tos(
      a.route({
        kind: "process_start",
        session_id: "s1",
        pid: 21,
        reason: "tail the log",
      }),
    ),
    ["TERM:process_start"],
  );
});
