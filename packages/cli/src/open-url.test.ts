import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { canOpenBrowser, openUrl } from "./open-url.ts";

type Call = { cmd: string; args: string[] };

/** A fake `spawn`: each call plays the next scripted outcome. */
function fakeSpawn(plan: ("ok" | "error" | "exit1" | "throw" | "quiet")[]) {
  const calls: Call[] = [];
  const spawnFn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const how = plan.shift() ?? "ok";
    if (how === "throw") throw new Error("spawn EAGAIN");
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    queueMicrotask(() => {
      if (how === "error") child.emit("error", new Error("ENOENT"));
      if (how === "exit1") child.emit("exit", 1);
      if (how === "ok") child.emit("exit", 0);
    });
    return child;
  }) as never;
  return { calls, spawnFn };
}

const URL_OK = "https://hawl.ai/device?code=ABCD-EFGH";

test("Windows opens through cmd start with the link quoted; one clean exit is enough", async () => {
  const f = fakeSpawn(["ok"]);
  assert.equal(await openUrl(URL_OK, "win32", f.spawnFn, 50), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.cmd, "cmd.exe");
  assert.deepEqual(f.calls[0]?.args, [
    "/d",
    "/c",
    "start",
    '""',
    `"${URL_OK}"`,
  ]);
});

test("Windows falls back to explorer when cmd start fails, and reports false when both fail", async () => {
  const a = fakeSpawn(["exit1", "ok"]);
  assert.equal(await openUrl(URL_OK, "win32", a.spawnFn, 50), true);
  assert.deepEqual(
    a.calls.map((c) => c.cmd),
    ["cmd.exe", "explorer.exe"],
  );
  const b = fakeSpawn(["error", "throw"]);
  assert.equal(await openUrl(URL_OK, "win32", b.spawnFn, 50), false);
});

test("an opener that never answers counts as opened after the short wait, and does not hang", async () => {
  const f = fakeSpawn(["quiet"]);
  const t0 = Date.now();
  assert.equal(await openUrl(URL_OK, "linux", f.spawnFn, 80), true);
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal(f.calls[0]?.cmd, "xdg-open");
});

test("only plain http(s) links are opened: nothing that could break out of the quotes", async () => {
  const f = fakeSpawn([]);
  for (const bad of [
    "file:///C:/Windows/System32/calc.exe",
    "javascript:alert(1)",
    'https://hawl.ai/x" & calc',
    "https://hawl.ai/x y",
    "https://hawl.ai/x^y",
    "",
  ])
    assert.equal(await openUrl(bad, "win32", f.spawnFn, 20), false, bad);
  assert.equal(f.calls.length, 0);
});

test("no browser over SSH, without a display, or with HAWL_NO_OPEN=1", () => {
  assert.equal(canOpenBrowser({}, "win32"), true);
  assert.equal(canOpenBrowser({ HAWL_NO_OPEN: "1" }, "win32"), false);
  assert.equal(canOpenBrowser({ SSH_CONNECTION: "x" }, "darwin"), false);
  assert.equal(canOpenBrowser({}, "linux"), false);
  assert.equal(canOpenBrowser({ DISPLAY: ":0" }, "linux"), true);
});
