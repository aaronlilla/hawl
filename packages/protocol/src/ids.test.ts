import assert from "node:assert/strict";
import { test } from "node:test";
import {
  base32Crockford,
  ID_PREFIXES,
  isId,
  newId,
  parseId,
  uuidv7,
} from "./ids.ts";

test("uuidv7 has version 7 and RFC variant", () => {
  const u = uuidv7();
  assert.match(
    u,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("ids sort by creation time across milliseconds", () => {
  const ids = [
    1_700_000_000_000, 1_700_000_000_001, 1_700_000_001_000, 1_800_000_000_000,
  ].map((t) => newId("msg", t));
  assert.deepEqual([...ids].sort(), ids);
});

test("ids sort by creation order inside one millisecond", () => {
  const t = 1_900_000_000_000;
  const ids = Array.from({ length: 5000 }, () => newId("evt", t));
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
});

test("ids never go backwards when the clock does", () => {
  const a = newId("msg", 2_000_000_000_000);
  const b = newId("msg", 1_000_000_000_000);
  assert.ok(a < b);
});

test("parseId reads prefix and timestamp", () => {
  const t = 2_100_000_000_123;
  const id = newId("res", t);
  const p = parseId(id);
  assert.equal(p?.prefix, "res");
  assert.equal(p?.timeMs, t);
  assert.equal(parseId(id, "res")?.uuid, id.slice(4));
});

test("parseId and isId reject bad ids", () => {
  const good = newId("twn");
  for (const bad of [
    "",
    "twn",
    "twn_",
    "xxx_01928f3e-7a10-7c3b-8a55-1f2e3d4c5b6a",
    "twn_01928f3e-7a10-4c3b-8a55-1f2e3d4c5b6a", // version 4
    "twn_01928f3e-7a10-7c3b-0a55-1f2e3d4c5b6a", // bad variant
    "twn_01928F3E-7A10-7C3B-8A55-1F2E3D4C5B6A", // upper case
    `${good} `,
  ]) {
    assert.equal(parseId(bad), null, bad);
    assert.equal(isId(bad), false, bad);
  }
  assert.equal(isId(good, "res"), false);
  assert.equal(isId(good, "twn"), true);
  assert.equal(isId(42), false);
});

test("every prefix round-trips", () => {
  for (const p of ID_PREFIXES) assert.equal(parseId(newId(p), p)?.prefix, p);
});

test("base32Crockford", () => {
  assert.equal(base32Crockford(Buffer.from("")), "");
  assert.equal(base32Crockford(Buffer.from("f")), "CR");
  assert.equal(base32Crockford(Buffer.from("foobar")), "CSQPYRK1E8");
});
