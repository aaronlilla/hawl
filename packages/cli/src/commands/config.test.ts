import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setStopHook } from "./config.ts";

test("config stop-hook writes the folder's town file; no membership refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "hawl-cfg-"));
  assert.throws(() => setStopHook({ projectDir: dir, on: false }, () => {}));
  mkdirSync(join(dir, ".hawl"));
  writeFileSync(
    join(dir, ".hawl", "hawl.json"),
    JSON.stringify({
      v: 1,
      village_id: "vil_1",
      folder_label: "p",
      memberships: [],
      written: [],
      restore: [],
    }),
  );
  const out: string[] = [];
  setStopHook({ projectDir: dir, on: false }, (l) => out.push(l));
  const read = () =>
    JSON.parse(readFileSync(join(dir, ".hawl", "hawl.json"), "utf8"));
  assert.equal(read().stop_hook, false);
  setStopHook({ projectDir: dir, on: true }, (l) => out.push(l));
  assert.equal(read().stop_hook, true);
  assert.deepEqual(out, ["stop-hook off", "stop-hook on"]);
});
