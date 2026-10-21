import assert from "node:assert/strict";
import { test } from "node:test";
import { announceFrames, LiveSessions, SESSION_FRESH_MS } from "./live.ts";

test("a heartbeat keeps a session live until it goes quiet", () => {
  let t = 1_000;
  const l = new LiveSessions(() => t);
  l.beat("res_A", "s1");
  assert.deepEqual(l.live("res_A"), ["s1"]);
  t += SESSION_FRESH_MS - 1;
  assert.deepEqual(l.live("res_A"), ["s1"]);
  t += 2;
  assert.deepEqual(l.live("res_A"), []);
});

test("bye removes only that session, and sessions stay per worker", () => {
  const l = new LiveSessions(() => 1);
  l.beat("res_A", "s1");
  l.beat("res_A", "s2");
  l.beat("res_B", "s1");
  l.bye("res_A", "s1");
  assert.deepEqual(l.live("res_A"), ["s2"]);
  assert.deepEqual(l.live("res_B"), ["s1"]);
  l.forget("res_B");
  assert.deepEqual(l.live("res_B"), []);
});

test("after a reconnect the relay hears every open session, or one bye when none is open", () => {
  assert.deepEqual(announceFrames(["a", "b"]), [
    { t: "agent_session", host_session_id: "a", state: "live" },
    { t: "agent_session", host_session_id: "b", state: "live" },
  ]);
  assert.deepEqual(announceFrames([]), [
    { t: "agent_session", host_session_id: "daemon", state: "bye" },
  ]);
});
