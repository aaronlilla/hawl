import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "../test-tmp.ts";
import { join } from "node:path";
import { test } from "node:test";
import {
  createDaemonLogger,
  RotatingFile,
  traceFrameField,
  traceHeader,
  traceIdOf,
} from "./log.ts";

test("traceFrameField passes a well-formed trace through and drops anything else", () => {
  const t = { "sentry-trace": `${"a".repeat(32)}-${"b".repeat(16)}-1` };
  assert.deepEqual(traceFrameField(t), { trace: t });
  assert.deepEqual(traceFrameField({ ...t, baggage: "k=v" }), {
    trace: { ...t, baggage: "k=v" },
  });
  // Nothing but the two known keys travels, and baggage has a size cap.
  assert.deepEqual(traceFrameField({ ...t, extra: "x" }), { trace: t });
  assert.deepEqual(traceFrameField({ ...t, baggage: "k".repeat(2000) }), {
    trace: t,
  });
  assert.deepEqual(traceFrameField({ "sentry-trace": "nope" }), {});
  assert.deepEqual(traceFrameField(undefined), {});
  assert.deepEqual(traceHeader(t), { "sentry-trace": t["sentry-trace"] });
  assert.deepEqual(traceHeader({ "sentry-trace": "nope" }), {});
});

const lines = (f: string) =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

test("daemon log redacts token, key, secret, authorization and cookie fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "hawl-log-"));
  const log = createDaemonLogger(dir);
  log.info(
    {
      token: "tok-SECRET-1",
      api_key: "key-SECRET-2",
      secret: "sec-SECRET-3",
      authorization: "Bearer SECRET-4",
      cookie: "sid=SECRET-5",
      headers: { authorization: "Bearer SECRET-6", cookie: "SECRET-7" },
      nested: {
        token: "SECRET-8",
        private_key: "SECRET-9",
        password: "SECRET-10",
      },
      name: "who",
    },
    "hello",
  );
  const raw = readFileSync(join(dir, "logs", "daemon.log"), "utf8");
  assert.ok(!raw.includes("SECRET"), raw);
  const [l] = lines(join(dir, "logs", "daemon.log"));
  assert.equal(l?.name, "who");
  assert.equal(l?.msg, "hello");
});

test("daemon log rotates at the size limit and keeps 3 files", () => {
  const dir = mkdtempSync(join(tmpdir(), "hawl-rot-"));
  const f = join(dir, "daemon.log");
  const w = new RotatingFile(f, 100, 3);
  for (let i = 0; i < 12; i++) w.write(`${i}${"x".repeat(40)}\n`);
  assert.ok(existsSync(f));
  assert.ok(existsSync(`${f}.1`));
  assert.ok(existsSync(`${f}.2`));
  assert.ok(!existsSync(`${f}.3`));
  assert.ok(statSync(f).size <= 100);
  // newest line is in the live file, oldest kept lines are in .2
  assert.ok(readFileSync(f, "utf8").includes("11xxx"));
});

test("traceIdOf takes the trace id part of sentry-trace", () => {
  const t = "a".repeat(32);
  assert.equal(traceIdOf({ "sentry-trace": `${t}-${"b".repeat(16)}-1` }), t);
  assert.equal(traceIdOf({ "sentry-trace": `${t}-${"b".repeat(16)}` }), t);
  assert.equal(traceIdOf({ "sentry-trace": "garbage" }), undefined);
  assert.equal(traceIdOf(undefined), undefined);
  assert.equal(traceIdOf("x"), undefined);
});
