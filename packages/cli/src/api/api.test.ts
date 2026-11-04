import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "../test-tmp.ts";
import { join } from "node:path";
import { test } from "node:test";
import { OPENAPI_FILE } from "../../build/gen-openapi.ts";
import { writeFileDurable } from "../daemon/fsutil.ts";
import { tokenPath } from "../daemon/socket.ts";
import { toolDefs } from "../mcp/tool-defs.ts";
import { startApiServer } from "./http.ts";
import { openApi } from "./openapi.ts";

test("the checked-in OpenAPI file matches tool-defs.ts", () => {
  const want = `${JSON.stringify(openApi(), null, 2)}\n`;
  const have = readFileSync(OPENAPI_FILE, "utf8").replace(/\r\n/g, "\n");
  assert.ok(
    have === want,
    "apps/web/public/hawl-local-api.openapi.json is out of date: run `node packages/cli/build/gen-openapi.ts`",
  );
  const paths = Object.keys(openApi().paths as object);
  for (const t of toolDefs())
    assert.ok(paths.includes(`/v1/tools/${t.name}`), t.name);
  // Every op answers 401 without the token, so every op declares it.
  for (const [p, ops] of Object.entries(openApi().paths as object))
    for (const op of Object.values(ops as object))
      assert.ok("401" in (op as { responses: object }).responses, p);
});

test("the helper's mailbox lists no ack (its spool takes only limit and include_read); the relay's keeps it", async () => {
  const mb = toolDefs().find((t) => t.name === "mailbox");
  assert.ok(mb);
  assert.ok(!("ack" in (mb.inputSchema.properties as object)));
  assert.doesNotMatch(mb.description, /\back\b/);
  assert.match(mb.description, /Example: \{"limit": 10\}/);
  const { DESCRIPTIONS } = await import("@hawl/protocol/src/tool-docs.ts");
  assert.match(DESCRIPTIONS.mailbox, /"ack": "12\.13"/);
});

test("local API: token required, a tool runs through the helper's tool op, wait wakes on mail", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "hawl-api-"));
  writeFileDurable(tokenPath(stateDir), "secret-token");
  const calls: Record<string, unknown>[] = [];
  let unread = 0;
  const api = await startApiServer(
    stateDir,
    {
      async call(op, a) {
        calls.push({ op, ...a });
        if (op === "notice") return { unread, needs_action: 0, aimed: unread };
        if (op === "mailbox") return { envelopes: new Array(unread).fill({}) };
        return { structuredContent: { echoed: a?.name } };
      },
    },
    () => ["res_one"],
  );
  try {
    const auth = { authorization: "Bearer secret-token" };
    assert.equal((await fetch(`${api.url}/v1/tools`)).status, 401);
    const list = (await (
      await fetch(`${api.url}/v1/tools`, { headers: auth })
    ).json()) as { tools: unknown[] };
    assert.equal(list.tools.length, toolDefs().length);
    const r = await fetch(`${api.url}/v1/tools/dm_send`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ to: "@a", text: "hi" }),
    });
    assert.deepEqual(await r.json(), {
      ok: true,
      result: { echoed: "dm_send" },
    });
    assert.equal(calls[0]?.resident_id, "res_one");
    setTimeout(() => {
      unread = 2;
    }, 300);
    const w = (await (
      await fetch(`${api.url}/v1/wait?timeout=5`, { headers: auth })
    ).json()) as { woke: boolean; unread: number };
    assert.deepEqual([w.woke, w.unread], [true, 2]);
  } finally {
    await api.close();
  }
});
