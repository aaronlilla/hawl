import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { b64url } from "@hawl/protocol/src/hash.ts";
import { startLoopback } from "./loopback.ts";

test("loopback: one-time listener on 127.0.0.1 with a random state and an S256 challenge", async () => {
  const lb = await startLoopback();
  assert.ok(lb);
  try {
    assert.match(lb.redirectUri, /^http:\/\/127\.0\.0\.1:\d{4,5}\/cb$/);
    assert.match(lb.state, /^[A-Za-z0-9_-]{43}$/);
    assert.match(lb.verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      lb.challenge,
      b64url(createHash("sha256").update(lb.verifier).digest()),
    );
    const other = await startLoopback();
    assert.ok(other);
    assert.notEqual(other.state, lb.state, "a new state each time");
    other.close();
  } finally {
    lb.close();
  }
});

test("loopback: accepts exactly one callback with the matching state; wrong state and replay are refused", async () => {
  const lb = await startLoopback();
  assert.ok(lb);
  try {
    const hit = (q: string) => fetch(`${lb.redirectUri}${q}`);
    const wrong = await hit(`?code=${"C".repeat(43)}&state=${"x".repeat(43)}`);
    assert.equal(wrong.status, 400);
    assert.equal((await hit(`?state=${lb.state}`)).status, 400, "no code");
    assert.equal(
      (await fetch(lb.redirectUri.replace("/cb", "/other"))).status,
      404,
    );
    const ok = await hit(`?code=${"A".repeat(43)}&state=${lb.state}`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /close this tab/i);
    const replay = await hit(`?code=${"B".repeat(43)}&state=${lb.state}`);
    assert.equal(replay.status, 400, "a second callback is refused");
    assert.equal(await lb.wait(10), "A".repeat(43), "the first code wins");
  } finally {
    lb.close();
  }
});

test("loopback: a malformed request gets 400 and never stops the listener", async () => {
  const lb = await startLoopback();
  assert.ok(lb);
  try {
    const bad = await fetch(lb.redirectUri.replace("/cb", "//["));
    assert.equal(bad.status, 400);
    const ok = await fetch(
      `${lb.redirectUri}?code=${"A".repeat(43)}&state=${lb.state}`,
    );
    assert.equal(ok.status, 200, "still listening");
    assert.equal(await lb.wait(10), "A".repeat(43));
  } finally {
    lb.close();
  }
});

test("loopback: wait gives null when no callback arrives in time", async () => {
  const lb = await startLoopback();
  assert.ok(lb);
  try {
    assert.equal(await lb.wait(30), null);
  } finally {
    lb.close();
  }
});

test("loopback: a port that cannot be bound gives null, so join falls back to the typed code", async () => {
  const taken = createServer();
  await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
  const port = (taken.address() as { port: number }).port;
  try {
    assert.equal(await startLoopback({ port }), null);
  } finally {
    taken.close();
  }
});
