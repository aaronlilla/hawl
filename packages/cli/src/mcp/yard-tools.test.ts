import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { parseClientRequest } from "@hawl/protocol/src/envelope.ts";
import { newId } from "@hawl/protocol/src/ids.ts";
import {
  YARD_TOOL_NAMES,
  type YardToolName,
} from "@hawl/protocol/src/validate.ts";
import { callYardTool, isYardTool } from "./yard-tools.ts";

const key = generateKeyPairSync("ed25519");
const RES = newId("res");
const DISPATCHER = newId("res");
const hnd = newId("hnd");
const art = newId("art");
const body = Buffer.from("artifact bytes");
const digest = createHash("sha256").update(body).digest("hex");

/** Valid args and the relay's canned (schema-valid) answer for each yard tool. */
const CASES: Record<YardToolName, { args: unknown; reply: unknown }> = {
  job_open: {
    args: {
      title: "Fix the checkout",
      spec: "The pay button does nothing.",
      capability: "web-fix",
      criteria: [{ id: "c1", text: "Pay works", check: "ci" }],
      idempotency_key: "k1",
    },
    reply: {
      decision: "routed",
      handoff_id: hnd,
      explain: { via: "menu", skipped: [] },
    },
  },
  job_status: {
    args: { handoff_id: hnd },
    reply: {
      state: "asked",
      exec_state: "queued",
      queue_holder: "service",
      to_yard: null,
      foreman: null,
      claim: null,
      waiting_on: null,
      explain: { via: "menu", skipped: [] },
      artifacts: [],
    },
  },
  ledger_read: {
    args: { capability: "web-fix" },
    reply: {
      as_of: "2026-10-20T10:00:00.000Z",
      site: {
        id: newId("twn"),
        yard_rule: "shadow",
        classifier_mode: "suggest",
      },
      yards: [],
      jobs: [],
      hints: [],
    },
  },
  menu_get: {
    args: {},
    reply: {
      published: null,
      revision: 0,
      draft: null,
      draft_revision: 0,
      stations: [],
    },
  },
  menu_set: {
    args: {
      menu: { visibility: "private", capabilities: [] },
      if_draft_revision: 0,
    },
    reply: {
      draft_revision: 1,
      publish_url: "https://hawl.ai/account/yard?site=s&draft=1",
    },
  },
  work_start: {
    args: { title: "Fixing checkout" },
    reply: { card_id: newId("crd") },
  },
  work_update: {
    args: { card_id: newId("crd"), state: "done" },
    reply: { ok: true },
  },
  ask_human: {
    args: { question: "Ship it?", to: "owner", wait_s: 2 },
    reply: { status: "waiting", ask_id: newId("hsk") },
  },
  approval_ask: {
    args: { action: "push_main", target: "main", wait_s: 0 },
    reply: { status: "waiting", approval_id: newId("aap") },
  },
  approval_use: { args: { approval_id: newId("aap") }, reply: { ok: true } },
  line_open: {
    args: {
      handoff_id: hnd,
      to: "@sam-cc",
      purpose: "pair on tests",
      ttl_minutes: 30,
    },
    reply: { line_id: newId("dln"), state: "requested" },
  },
  artifact_get: {
    args: { handoff_id: hnd, artifact_id: art },
    reply: { url: "https://files.example/a", digest, name: "out.txt" },
  },
};

/** The fake relay: answers daemon ops the way the real daemon would forward them. */
function fakeRelay(reply: unknown) {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const daemon = {
    async call(op: string, args: Record<string, unknown> = {}) {
      calls.push({ op, args });
      if (op === "send_tool" && args.name === "who")
        return {
          workers: [{ handle: "@dispatcher", resident_id: DISPATCHER }],
        };
      if (op === "file_meta")
        return {
          file_id: args.file_id,
          name: "a.txt",
          mime: "text/plain",
          bytes: 3,
          sha256: "q".repeat(43),
          state: "released",
          release_state: "released",
        };
      if (op === "send_tool") return reply;
      throw new Error(`unexpected op ${op}`);
    },
  };
  const at = (i: number) => {
    const c = calls[i];
    if (!c) throw new Error(`no daemon call #${i}`);
    return c;
  };
  return { daemon, calls, at };
}

const deps = (
  daemon: ReturnType<typeof fakeRelay>["daemon"],
  cwd = tmpdir(),
) => ({
  daemon,
  residentId: RES,
  signer: { kid: "key_1", privateKey: key.privateKey },
  cwd,
  doFetch: (async () => new Response(body)) as unknown as typeof fetch,
});

test("the module covers exactly the contract's yard tools", () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...YARD_TOOL_NAMES].sort());
  assert.ok(isYardTool("job_open"));
  assert.ok(!isYardTool("who"));
});

for (const name of YARD_TOOL_NAMES) {
  if (name === "job_open" || name === "artifact_get") continue;
  test(`${name}: valid args reach the relay tool by name, the answer comes back`, async () => {
    const { args, reply } = CASES[name];
    const r = fakeRelay(reply);
    assert.deepEqual(await callYardTool(deps(r.daemon), name, args), reply);
    assert.deepEqual(r.calls, [
      { op: "send_tool", args: { resident_id: RES, name, args } },
    ]);
  });
}

for (const name of YARD_TOOL_NAMES) {
  test(`${name}: args that break the protocol schema never reach the relay`, async () => {
    const r = fakeRelay(CASES[name].reply);
    const bad = { ...(CASES[name].args as object), not_in_schema: 1 };
    await assert.rejects(
      callYardTool(deps(r.daemon), name, bad),
      new RegExp(`${name} args`),
    );
    assert.equal(r.calls.length, 0);
  });
}

test("required args and limits are enforced (title length, criteria count, requester needs a job)", async () => {
  const r = fakeRelay({});
  const d = deps(r.daemon);
  await assert.rejects(
    callYardTool(d, "work_start", { title: "x".repeat(81) }),
  );
  await assert.rejects(callYardTool(d, "work_start", {}));
  await assert.rejects(
    callYardTool(d, "job_open", {
      ...(CASES.job_open.args as object),
      criteria: [],
    }),
  );
  await assert.rejects(
    callYardTool(d, "ask_human", { question: "q", to: "requester" }),
  );
  await assert.rejects(
    callYardTool(d, "approval_ask", { action: "rm_rf", target: "x" }),
  );
  assert.equal(r.calls.length, 0);
});

test("a relay answer that breaks the result schema is refused", async () => {
  const r = fakeRelay({ card_id: "nope" });
  await assert.rejects(
    callYardTool(deps(r.daemon), "work_start", { title: "t" }),
    /work_start result/,
  );
});

test("job_open finds the Dispatcher with who and sends one signed request_action to it", async () => {
  const { args, reply } = CASES.job_open;
  const r = fakeRelay(reply);
  assert.deepEqual(await callYardTool(deps(r.daemon), "job_open", args), reply);
  assert.equal(r.at(0).op, "send_tool");
  assert.equal(r.at(0).args.name, "who");
  const send = r.at(1);
  assert.equal(send.op, "send_tool");
  assert.equal(send.args.name, "job_open");
  assert.deepEqual(send.args.args, args);
  const req = parseClientRequest(send.args.client_request as string);
  assert.deepEqual(req.to, { kind: "worker", resident_id: DISPATCHER });
  assert.equal(req.intent, "request_action");
  assert.equal(req.idempotency_key, "k1");
  const first = req.content.parts[0];
  assert.ok(first && first.kind === "text");
  assert.equal(first.text, "The pay button does nothing.");
  assert.ok(send.args.sender_sig);
});

test("job_open without a Dispatcher or a key says so and sends nothing", async () => {
  const r = fakeRelay({});
  r.daemon.call = async (op, a = {}) => {
    r.calls.push({ op, args: a });
    return { workers: [] };
  };
  await assert.rejects(
    callYardTool(deps(r.daemon), "job_open", CASES.job_open.args),
    /no Dispatcher/,
  );
  assert.ok(!r.calls.some((c) => c.args.name === "job_open"));
  await assert.rejects(
    callYardTool(
      { ...deps(r.daemon), signer: undefined },
      "job_open",
      CASES.job_open.args,
    ),
    /no signing key/,
  );
});

test("artifact_get downloads the relay link, checks the sha256 and saves under .hawl/files", async () => {
  const cwd = mkdtempSync(`${tmpdir()}/yard-`);
  const r = fakeRelay(CASES.artifact_get.reply);
  const out = (await callYardTool(
    deps(r.daemon, cwd),
    "artifact_get",
    CASES.artifact_get.args,
  )) as {
    path: string;
    bytes: number;
    sha256: string;
  };
  assert.equal(out.sha256, digest);
  assert.equal(out.bytes, body.length);
  assert.match(out.path.replaceAll("\\", "/"), /\.hawl\/files\/out\.txt$/);
  assert.deepEqual(readFileSync(out.path), body);
  assert.equal(r.at(0).args.name, "artifact_get");
  assert.equal("save_to" in (r.at(0).args.args as object), false);
});

test("artifact_get with a wrong digest saves nothing and fails", async () => {
  const cwd = mkdtempSync(`${tmpdir()}/yard-`);
  const r = fakeRelay({
    ...(CASES.artifact_get.reply as object),
    digest: "0".repeat(64),
  });
  await assert.rejects(
    callYardTool(deps(r.daemon, cwd), "artifact_get", CASES.artifact_get.args),
    /digest does not match/,
  );
});

test("job_open files ride as clean file parts and a relay coaching tip is not a schema error", async () => {
  const fil = newId("fil");
  const r = fakeRelay({ ...(CASES.job_open.reply as object), hawl_tip: "tip" });
  const out = await callYardTool(deps(r.daemon), "job_open", {
    ...(CASES.job_open.args as object),
    files: [fil],
  });
  assert.equal((out as { hawl_tip: string }).hawl_tip, "tip");
  const send = r.calls.find((c) => c.args.name === "job_open");
  const req = parseClientRequest(send?.args.client_request as string);
  const part = req.content.parts.find((p) => p.kind === "file");
  assert.deepEqual(Object.keys(part ?? {}).sort(), [
    "bytes",
    "file_id",
    "kind",
    "mime",
    "name",
    "sha256",
  ]);
});

test("artifact_get never overwrites a file and never leaves .hawl/files", async () => {
  const cwd = mkdtempSync(`${tmpdir()}/yard-`);
  const r = fakeRelay(CASES.artifact_get.reply);
  const d = deps(r.daemon, cwd);
  await callYardTool(d, "artifact_get", CASES.artifact_get.args);
  await assert.rejects(
    callYardTool(d, "artifact_get", CASES.artifact_get.args),
    /already exists/,
  );
  await assert.rejects(
    callYardTool(d, "artifact_get", {
      ...(CASES.artifact_get.args as object),
      save_to: "../../escape.txt",
    }),
    /inside \.hawl\/files/,
  );
});

test("a long wait_s is cut to fit the daemon socket timeout", async () => {
  for (const name of ["ask_human", "approval_ask"] as const) {
    const r = fakeRelay(CASES[name].reply);
    await callYardTool(deps(r.daemon), name, {
      ...(CASES[name].args as object),
      wait_s: 120,
    });
    assert.equal((r.at(0).args.args as { wait_s: number }).wait_s, 3);
  }
});
