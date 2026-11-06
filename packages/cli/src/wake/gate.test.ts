import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IDLE_QUIET_MS,
  MAX_IDLE_WAKES_PER_HOUR,
  WAKE_MIN_INTERVAL_MS,
  WakeGate,
  wakeOn,
} from "./gate.ts";

const idle = IDLE_QUIET_MS + 1;

test("wakes on a rise in aimed mail, not on the same count again", () => {
  const g = new WakeGate();
  assert.equal(g.shouldWake({ aimed: 0, quietMs: null, now: 0 }), false);
  assert.equal(g.shouldWake({ aimed: 1, quietMs: null, now: 0 }), true);
  g.woke(1, 0);
  const later = WAKE_MIN_INTERVAL_MS + 1;
  assert.equal(g.shouldWake({ aimed: 1, quietMs: idle, now: later }), false);
  assert.equal(g.shouldWake({ aimed: 2, quietMs: idle, now: later }), true);
});

test("a read (count drops) re-arms the next arrival", () => {
  const g = new WakeGate();
  g.woke(2, 0);
  const t = WAKE_MIN_INTERVAL_MS + 1;
  assert.equal(g.shouldWake({ aimed: 0, quietMs: idle, now: t }), false);
  assert.equal(g.shouldWake({ aimed: 1, quietMs: idle, now: t }), true);
});

test("a busy agent is left to its hooks", () => {
  const g = new WakeGate();
  assert.equal(g.shouldWake({ aimed: 1, quietMs: 500, now: 0 }), false);
  assert.equal(g.shouldWake({ aimed: 1, quietMs: idle, now: 0 }), true);
});

test("min interval and hourly cap", () => {
  const g = new WakeGate();
  let now = 0;
  for (let i = 1; i <= MAX_IDLE_WAKES_PER_HOUR; i++) {
    assert.equal(g.shouldWake({ aimed: i, quietMs: idle, now }), true, `#${i}`);
    g.woke(i, now);
    assert.equal(
      g.shouldWake({ aimed: i + 1, quietMs: idle, now: now + 1 }),
      false,
      "too soon",
    );
    now += WAKE_MIN_INTERVAL_MS;
  }
  assert.equal(
    g.shouldWake({ aimed: 99, quietMs: idle, now }),
    false,
    "hourly cap",
  );
  assert.equal(
    g.shouldWake({ aimed: 99, quietMs: idle, now: 3_600_001 }),
    true,
    "cap rolls off after an hour",
  );
});

test("seen() records what a hook already told the agent", () => {
  const g = new WakeGate();
  g.seen(3);
  assert.equal(g.shouldWake({ aimed: 3, quietMs: idle, now: 0 }), false);
});

test("folder switch: absent is on, false is off, no town file is off", () => {
  assert.equal(wakeOn({}), true);
  assert.equal(wakeOn({ wake: true }), true);
  assert.equal(wakeOn({ wake: false }), false);
  assert.equal(wakeOn(null), false);
});
