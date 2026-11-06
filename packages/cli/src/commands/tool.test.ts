import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "../test-tmp.ts";
import { join } from "node:path";
import { test } from "node:test";
import { tool } from "./tool.ts";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "hawl-tool-"));
  mkdirSyncHawl(dir);
  const calls: Record<string, unknown>[] = [];
  let out = "";
  const io = {
    out: (s: string) => void (out += s),
    err: () => {},
    projectDir: dir,
    link: {
      async call(_op: string, a?: Record<string, unknown>) {
        calls.push(a ?? {});
        return { structuredContent: { ok: 1 } };
      },
    },
  };
  return { dir, io, calls, out: () => out };
}

function mkdirSyncHawl(dir: string) {
  const town = {
    v: 1,
    village_id: "vil_1",
    folder_label: "t",
    memberships: [
      {
        town_id: "t",
        town_slug: "s",
        relay_url: "x",
        workers: [{ resident_id: "res_1", platform: "other", kid: "k" }],
      },
    ],
    written: [],
    restore: [],
  };
  mkdirSync(join(dir, ".hawl"));
  writeFileSync(join(dir, ".hawl", "hawl.json"), JSON.stringify(town));
}

test("--json - reads the args from stdin", async () => {
  const h = harness();
  const code = await tool(["dm_send", "--json", "-"], {
    ...h.io,
    stdin: () => '{"to":"@a","text":"hi"}',
  });
  assert.equal(code, 0);
  assert.deepEqual(h.calls[0]?.args, { to: "@a", text: "hi" });
});

test("--json @file reads the args from a file", async () => {
  const h = harness();
  const f = join(h.dir, "args.json");
  writeFileSync(f, '{"to":"@a","text":"hi"}');
  await tool(["dm_send", "--json", `@${f}`], h.io);
  assert.deepEqual(h.calls[0]?.args, { to: "@a", text: "hi" });
});

test("invalid JSON names the PowerShell case and suggests --json -", async () => {
  const h = harness();
  await assert.rejects(
    tool(["dm_send", "--json", "{to:@a,text:hi}"], h.io),
    /PowerShell.*--json -/s,
  );
});
