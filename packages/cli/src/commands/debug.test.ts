import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "../test-tmp.ts";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { newId } from "@hawl/protocol/src/ids.ts";
import { generateWorkerKey, MemoryKeyStore } from "../daemon/keys.ts";
import {
  applyDebug,
  createDaemonLogger,
  DEBUG_MS,
  daemonLogPath,
  debugUntil,
  pruneLogs,
  scrubText,
} from "../daemon/log.ts";
import { addWorker, newTownFile, writeTownFile } from "../town-file.ts";
import { debug } from "./debug.ts";
import { doctor } from "./doctor.ts";
import { renderStatus, statusReport } from "./status.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const MB = 1024 * 1024;
const DAY = 86_400_000;

const JWT = `eyJhbGciOiJFZERTQSJ9.${"a".repeat(30)}.${"b".repeat(20)}`;
const INVITE = `https://hawl.ai/i/${"Zx9_-".repeat(9)}`;

test("scrubText strips bearer values, JWTs, token pairs and invite links inside plain text", () => {
  const msg = `retry with Bearer abc123DEF456ghi789 and ${JWT}, token=sekret-value-1, join via ${INVITE}`;
  const out = scrubText(msg);
  for (const secret of ["abc123DEF456", JWT, "sekret-value-1", "Zx9_-Zx9_-"])
    assert.ok(!out.includes(secret), `${secret} still in: ${out}`);
  assert.match(out, /Bearer \[redacted\]/);
  assert.match(out, /\/i\/\[redacted-invite\]/);
  assert.equal(scrubText("ws state connected"), "ws state connected");
});

test("the daemon log writes plain-message secrets already stripped", () => {
  const dir = tmp("hawl-scrub-");
  const log = createDaemonLogger(dir);
  log.info(`opened ${INVITE} with Bearer abc123DEF456ghi789`);
  log.info(
    { note: `token: tok-live-99999` },
    "keyed field with a secret inside",
  );
  const text = readFileSync(daemonLogPath(dir), "utf8");
  assert.ok(!text.includes("abc123DEF456"));
  assert.ok(!text.includes("Zx9_-Zx9_-"));
  assert.ok(!text.includes("tok-live-99999"));
  assert.match(text, /opened/);
});

test("hawl debug on turns the daemon to debug level and shows in status; 24 hours later it is off again", async () => {
  const dir = tmp("hawl-debug-");
  const log = createDaemonLogger(dir);
  const t0 = Date.now();
  assert.equal(applyDebug(log, dir, t0), false);
  assert.equal(log.level, "info");
  log.debug("hidden while off");

  const lines: string[] = [];
  const until = debug(
    { on: true },
    { stateDir: dir, print: (l) => lines.push(l), now: () => t0 },
  );
  assert.equal(until, t0 + DEBUG_MS);
  assert.match(lines[0] as string, /^Verbose logging is on until /);

  // The running daemon picks it up on its next look, no restart.
  assert.equal(applyDebug(log, dir, t0 + 1000), true);
  assert.equal(log.level, "debug");
  log.debug("seen while on");

  const town = tmp("hawl-debug-proj-");
  const rep = await statusReport(
    { projectDir: town },
    {
      stateDir: dir,
      daemon: () =>
        ({
          call: async () => {
            throw new Error("down");
          },
        }) as never,
    },
  );
  assert.equal(rep.debug_until, new Date(until as number).toISOString());
  assert.match(renderStatus(rep), /verbose logging on until /);

  // Past 24 hours it switches itself off and the switch file is gone.
  assert.equal(applyDebug(log, dir, t0 + DEBUG_MS + 1), false);
  assert.equal(log.level, "info");
  assert.equal(debugUntil(dir, t0 + DEBUG_MS + 1), null);
  assert.ok(!existsSync(join(dir, "debug.json")));
  const text = readFileSync(daemonLogPath(dir), "utf8");
  assert.ok(text.includes("seen while on"));
  assert.ok(!text.includes("hidden while off"));

  debug({ on: true }, { stateDir: dir, print: () => {}, now: () => t0 });
  debug({ on: false }, { stateDir: dir, print: (l) => lines.push(l) });
  assert.equal(debugUntil(dir, t0), null);
});

function sparse(file: string, size: number, ageMs: number, now: number) {
  const fd = openSync(file, "w");
  ftruncateSync(fd, size);
  closeSync(fd);
  const t = new Date(now - ageMs);
  utimesSync(file, t, t);
}

test("pruneLogs deletes files older than 7 days, then the oldest until 50 MB fits, and keeps the live file", () => {
  const dir = tmp("hawl-prune-");
  const logs = join(dir, "logs");
  mkdirSync(logs);
  const now = Date.now();
  sparse(join(logs, "daemon.log"), 5 * MB, 0, now);
  sparse(join(logs, "daemon.log.1"), 20 * MB, 1 * DAY, now);
  sparse(join(logs, "daemon.log.2"), 20 * MB, 2 * DAY, now);
  sparse(join(logs, "daemon.log.3"), 20 * MB, 3 * DAY, now);
  sparse(join(logs, "daemon.log.4"), 1 * MB, 8 * DAY, now);

  const gone = pruneLogs(dir, now).map((f) => f.replace(/^.*[\\/]/, ""));
  assert.deepEqual(gone.sort(), ["daemon.log.3", "daemon.log.4"]);
  assert.ok(existsSync(join(logs, "daemon.log")));
  assert.ok(existsSync(join(logs, "daemon.log.1")));
  assert.ok(existsSync(join(logs, "daemon.log.2")));
});

const sent = (j: { calls: { url: string }[] }) =>
  j.calls.filter((c) => c.url.endsWith("/v1/support/bundles"));

async function joined() {
  const dir = tmp("hawl-send-proj-");
  const stateDir = tmp("hawl-send-state-");
  const keys = new MemoryKeyStore();
  const k = generateWorkerKey();
  await keys.set("res_1", k.privateJwk);
  const t = newTownFile("shop");
  addWorker(
    t,
    { town_id: "twn_1", town_slug: "shop", relay_url: "https://relay.test" },
    { resident_id: "res_1", platform: "claude_code", kid: k.kid },
  );
  writeTownFile(dir, t);
  // A log with a verbose line and a leaked token in a message.
  mkdirSync(join(stateDir, "logs"));
  writeFileSync(
    daemonLogPath(stateDir),
    `${JSON.stringify({ level: 20, time: new Date().toISOString(), msg: `frame Bearer abc123DEF456ghi789` })}\n`,
  );
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFake = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v1/auth/token"))
      return Response.json({ access_token: "t0k3n" });
    return Response.json({ code: "HAWL-ABCD-2345" }, { status: 201 });
  }) as typeof fetch;
  return { dir, stateDir, keys, calls, fetchFake };
}

test("doctor --send refuses without an explicit yes when no one is at the keyboard, and sends nothing", async () => {
  const j = await joined();
  const out: string[] = [];
  const r = await doctor(
    { projectDir: j.dir, send: true },
    {
      stateDir: j.stateDir,
      keyStore: j.keys,
      fetch: j.fetchFake,
      isTTY: false,
      print: (l) => out.push(l),
    },
  );
  assert.equal(sent(j).length, 0);
  assert.equal(r.code, undefined);
  assert.equal(r.exitCode, 1);
  assert.match(
    out.join("\n"),
    /Not sent: there is no keyboard here\. Add --yes/,
  );
  assert.match(
    out.join("\n"),
    /What would be sent|would be sent to Hawl support: \d+ KB, \d+ lines/,
  );
});

test("doctor --send: an answer other than yes sends nothing; yes uploads the cleaned gzip and prints the code", async () => {
  const j = await joined();
  const out: string[] = [];
  const base = {
    stateDir: j.stateDir,
    keyStore: j.keys,
    fetch: j.fetchFake,
    isTTY: true,
    print: (l: string) => out.push(l),
  };
  await doctor(
    { projectDir: j.dir, send: true },
    { ...base, ask: async () => "" },
  );
  await doctor(
    { projectDir: j.dir, send: true },
    { ...base, ask: async () => "no" },
  );
  assert.equal(sent(j).length, 0);

  const r = await doctor(
    { projectDir: j.dir, send: true },
    { ...base, ask: async () => "y" },
  );
  assert.equal(r.code, "HAWL-ABCD-2345");
  assert.match(out.join("\n"), /Support code: HAWL-ABCD-2345/);
  const up = j.calls.find(
    (c) => c.url === "https://relay.test/v1/support/bundles",
  );
  assert.ok(up);
  assert.equal(
    (up.init?.headers as Record<string, string>).authorization,
    "Bearer t0k3n",
  );
  const text = gunzipSync(up.init?.body as Buffer).toString();
  assert.match(text, /hawl support bundle/);
  assert.match(text, /last 7 days 1 lines/);
  assert.ok(!text.includes("abc123DEF456"));
});

test("doctor --send --yes uploads without asking", async () => {
  const j = await joined();
  const r = await doctor(
    { projectDir: j.dir, send: true, yes: true },
    {
      stateDir: j.stateDir,
      keyStore: j.keys,
      fetch: j.fetchFake,
      isTTY: false,
      print: () => {},
    },
  );
  assert.equal(r.code, "HAWL-ABCD-2345");
});

test("scrubText redacts a whole quoted value, spaces and all", () => {
  for (const msg of [
    `login password="correct horse battery staple" ok`,
    `login password='correct horse battery staple' ok`,
    JSON.stringify({ msg: 'login password="correct horse battery staple" ok' }),
    JSON.stringify({ note: "passphrase: 'correct horse battery staple'" }),
  ]) {
    const out = scrubText(msg);
    assert.ok(!out.includes("horse"), out);
    assert.ok(!out.includes("staple"), out);
  }
  // still valid JSON after scrubbing a JSON line
  const line = scrubText(
    JSON.stringify({ msg: 'password="correct horse battery staple" done' }),
  );
  assert.equal(
    (JSON.parse(line) as { msg: string }).msg,
    'password="[redacted]" done',
  );
});

test("scrubText catches a bare `token <value>` and long hex or base64 strings, but keeps ids and trace_id", () => {
  const b64 = randomBytes(33).toString("base64");
  const b64url = randomBytes(33).toString("base64url");
  const hex = randomBytes(24).toString("hex");
  const out = scrubText(
    `got token abc123xyz789qrs4 then key ${b64url} and blob ${b64} and hash ${hex}`,
  );
  for (const s of ["abc123xyz789qrs4", b64url, b64, hex])
    assert.ok(!out.includes(s), `${s} still in: ${out}`);
  // plain words after "token" are not eaten
  assert.equal(
    scrubText("token refresh failed, retrying"),
    "token refresh failed, retrying",
  );

  const res = newId("res");
  const req = newId("req");
  const twn = newId("twn");
  const trace = randomBytes(16).toString("hex");
  const keep = JSON.stringify({
    trace_id: trace,
    "sentry-trace": `${trace}-${randomBytes(8).toString("hex")}-1`,
    res,
    req,
    twn,
    msg: `${res} asked ${req} in ${twn} very_long_function_name_without_any_digits_here`,
  });
  assert.equal(scrubText(keep), keep);
});

test("scrubText covers the real invite link and API shapes", () => {
  const token = randomBytes(32).toString("base64url"); // invites.ts newToken(): 43 chars
  assert.equal(token.length, 43);
  const invitation = newId("msg").slice(4); // email invites use the bare uuidv7 at /i/<id>
  for (const s of [
    `https://hawl.ai/i/${token}`,
    `https://hawl.ai/i/${token}?join=1`,
    `GET /v1/invites/${token}/status 200`,
    `POST https://relay.hawl.ai/v1/invites/${token}/join`,
    `/login?next=${encodeURIComponent(`/i/${token}?join=1`)}`,
    `https://hawl.ai/i/${invitation}`,
  ]) {
    const out = scrubText(s);
    const secret = s.includes(invitation) ? invitation : token;
    assert.ok(!out.includes(secret.slice(0, 20)), out);
    assert.ok(!out.includes(secret.slice(-20)), out);
  }
  assert.equal(scrubText("https://hawl.ai/pricing"), "https://hawl.ai/pricing");
});

test("pruneLogs also drops lines older than 7 days from the live file", () => {
  const dir = tmp("hawl-prune-live-");
  const logs = join(dir, "logs");
  mkdirSync(logs);
  const now = Date.now();
  const line = (ageMs: number, msg: string) =>
    `${JSON.stringify({ time: new Date(now - ageMs).toISOString(), msg })}\n`;
  const live = join(logs, "daemon.log");
  writeFileSync(
    live,
    line(9 * DAY, "old one") +
      line(8 * DAY, "old two") +
      "not json at all\n" +
      line(2 * DAY, "recent") +
      line(0, "now"),
  );
  pruneLogs(dir, now);
  const text = readFileSync(live, "utf8");
  assert.ok(!text.includes("old one") && !text.includes("old two"), text);
  assert.ok(text.includes("recent") && text.includes("now"), text);
  assert.ok(text.includes("not json at all"), text);
});

test("pruneLogs keeps a line another process appends while it trims the live file", async () => {
  const dir = tmp("hawl-prune-race-");
  const logs = join(dir, "logs");
  mkdirSync(logs);
  const live = join(logs, "daemon.log");
  const stop = join(dir, "stop");
  const now = Date.now();
  // Big old block so the trim runs long enough for the writer to land lines inside it.
  const old = `${JSON.stringify({ time: new Date(now - 30 * DAY).toISOString(), msg: "x".repeat(80) })}\n`;
  writeFileSync(live, old.repeat(300_000));
  const writer = spawn(
    process.execPath,
    [
      "-e",
      `const fs=require("fs");let i=0;
while(!fs.existsSync(${JSON.stringify(stop)})){
fs.appendFileSync(${JSON.stringify(live)},JSON.stringify({time:new Date().toISOString(),seq:i++})+"\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}
console.log(i)`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let out = "";
  writer.stdout.on("data", (d) => {
    out += d;
  });
  const exited = new Promise((r) => writer.on("exit", r));
  await new Promise((r) => setTimeout(r, 300));
  pruneLogs(dir, now);
  writeFileSync(stop, "");
  await exited;
  const sent = Number(out.trim());
  const seen = new Set(
    readFileSync(live, "utf8")
      .split("\n")
      .filter((l) => l.includes('"seq"'))
      .map((l) => (JSON.parse(l) as { seq: number }).seq),
  );
  const lost = [...Array(sent).keys()].filter((i) => !seen.has(i));
  assert.deepEqual(lost, []);
});
