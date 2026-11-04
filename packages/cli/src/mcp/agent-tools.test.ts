import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseClientRequest } from "@hawl/protocol/src/envelope.ts";
import { newId } from "@hawl/protocol/src/ids.ts";
import type { DaemonLink } from "./server.ts";
import { fileGet, filesDir, runTool, send } from "./tool-run.ts";

const key = generateKeyPairSync("ed25519");
const FIL = "fil_01926f3a-0000-7000-8000-000000000003";
const SHA = "q".repeat(43);

function fake() {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const daemon: DaemonLink = {
    async call(op, args = {}) {
      calls.push({ op, args });
      if (op === "resolve")
        return {
          to: { kind: "worker", resident_id: newId("res") },
          conversation_id: null,
          reply_to: null,
        };
      if (op === "file_meta")
        return {
          file_id: args.file_id,
          name: "out.txt",
          mime: "text/plain",
          bytes: 12,
          sha256: SHA,
        };
      if (op === "file_download")
        return { path: "/p/.hawl/files/out.txt", sha256: SHA, name: "out.txt" };
      return { message_id: "msg_x", state: "queued" };
    },
  };
  const deps = {
    daemon,
    residentId: newId("res"),
    signer: { kid: "key_t", privateKey: key.privateKey },
  };
  return { calls, deps };
}

const signedOf = (calls: { op: string; args: Record<string, unknown> }[]) => {
  const sent = calls.find((c) => c.op === "send" || c.op === "send_tool");
  assert.ok(sent, "nothing was sent");
  return {
    op: sent.op,
    sent,
    cr: parseClientRequest(sent.args.client_request as string),
  };
};

test("dm_send with files signs one file part per id, after the text", async () => {
  const { calls, deps } = fake();
  await send(deps, "dm_send", {
    to: "alpha",
    text: "the notes",
    files: [FIL],
  });
  const meta = calls.find((c) => c.op === "file_meta");
  assert.equal(meta?.args.file_id, FIL);
  const { op, cr } = signedOf(calls);
  assert.equal(op, "send");
  assert.deepEqual(cr.content.parts, [
    { kind: "text", text: "the notes" },
    {
      kind: "file",
      file_id: FIL,
      name: "out.txt",
      mime: "text/plain",
      bytes: 12,
      sha256: SHA,
    },
  ]);
});

test("thread_reply with files signs the file parts as a reply", async () => {
  const { calls, deps } = fake();
  await send(deps, "thread_reply", {
    message_id: newId("msg"),
    text: "evidence attached",
    files: [FIL],
  });
  const { cr } = signedOf(calls);
  assert.equal(cr.intent, "reply");
  assert.equal(cr.content.parts[1]?.kind, "file");
});

test("a dm with no files never asks for file metadata", async () => {
  const { calls, deps } = fake();
  await send(deps, "dm_send", { to: "@alpha", text: "hi" });
  assert.equal(
    calls.some((c) => c.op === "file_meta"),
    false,
  );
  assert.deepEqual(signedOf(calls).cr.content.parts, [
    { kind: "text", text: "hi" },
  ]);
});

test("square_post and room_post sign the intent they were given, inform by default", async () => {
  for (const tool of ["square_post", "room_post"] as const) {
    const asked = fake();
    await send(asked.deps, tool, {
      room: "payments",
      text: "who has the contract?",
      intent: "ask",
    });
    assert.equal(signedOf(asked.calls).cr.intent, "ask", tool);
    const plain = fake();
    await send(plain.deps, tool, { room: "payments", text: "fyi" });
    assert.equal(signedOf(plain.calls).cr.intent, "inform", tool);
  }
});

test("ask_town goes out as a signed request_action through the tool route", async () => {
  const { calls, deps } = fake();
  await send(deps, "ask_town", {
    text: "fix the flaky checkout test",
    task_type: "regression-test",
  });
  const { op, sent, cr } = signedOf(calls);
  assert.equal(op, "send_tool");
  assert.equal(sent.args.name, "ask_town");
  assert.equal(cr.intent, "request_action");
  assert.deepEqual(cr.content.parts, [
    { kind: "text", text: "fix the flaky checkout test" },
  ]);
  const resolve = calls.find((c) => c.op === "resolve");
  assert.equal(resolve?.args.tool, "ask_town");
});

test("file_get downloads into the project's .hawl/files, or save_to", async () => {
  const { calls, deps } = fake();
  const cwd = join("/work", "proj");
  const r = (await fileGet({ ...deps, cwd }, { file_id: FIL })) as {
    path: string;
  };
  assert.equal(r.path, "/p/.hawl/files/out.txt");
  const dl = calls.find((c) => c.op === "file_download");
  assert.equal(dl?.args.file_id, FIL);
  assert.equal(dl?.args.dir, filesDir({ cwd }));
  assert.equal(dl?.args.dir, join(cwd, ".hawl", "files"));
  assert.equal(dl?.args.save_to, undefined);
  await fileGet({ ...deps, cwd }, { file_id: FIL, save_to: "out/x.txt" });
  const second = calls.filter((c) => c.op === "file_download")[1];
  assert.equal(
    second?.args.save_to,
    resolve(cwd, ".hawl", "files", "out/x.txt"),
  );
});

const HND = "hnd_01a16b9c-26d4-717a-b0d4-4a096544cedd";

test("runTool: the pilot's handoff_get {id} and dm_send {message} run with the real field", async () => {
  const { calls, deps } = fake();
  const get = await runTool(deps, "handoff_get", { id: HND }, { contract: 99 });
  assert.ok(!get.isError, JSON.stringify(get));
  const tool = calls.find((c) => c.op === "tool");
  assert.deepEqual(tool?.args.args, { handoff_id: HND });
  const dm = await runTool(
    deps,
    "dm_send",
    { to: "@other-ctl", message: "Owner request" },
    { contract: 99 },
  );
  assert.ok(!dm.isError, JSON.stringify(dm));
  const { cr } = signedOf(calls);
  assert.deepEqual(cr.content.parts, [{ kind: "text", text: "Owner request" }]);
});

test("runTool: a bad yard call (ask_human) and a bad enum (handoff_update op) end with the hint", async () => {
  const { deps } = fake();
  const human = await runTool(
    deps,
    "ask_human",
    { question: "ok?", to: "nobody" },
    { contract: 99 },
  );
  assert.ok(human.isError);
  assert.match(human.content[0]?.text ?? "", /owner, requester/);
  assert.match(human.content[0]?.text ?? "", /expected \{question, to/);
  const op = await runTool(
    deps,
    "handoff_update",
    { handoff_id: HND, op: "bogus" },
    { contract: 99 },
  );
  assert.ok(op.isError);
  assert.match(op.content[0]?.text ?? "", /accept, decline, done, verify/);
  assert.match(op.content[0]?.text ?? "", /expected \{handoff_id, op/);
  const clash = await runTool(
    deps,
    "handoff_get",
    { id: "a", handoff_id: HND },
    { contract: 99 },
  );
  assert.match(clash.content[0]?.text ?? "", /expected \{handoff_id\}/);
});

test("runTool: a wrong field names the expected ones; agreement tools go to the relay like role_get", async () => {
  const { calls, deps } = fake();
  const bad = await runTool(
    deps,
    "handoff_get",
    { handoff: HND },
    { contract: 99 },
  );
  assert.ok(bad.isError);
  assert.match(bad.content[0]?.text ?? "", /expected \{handoff_id\}/);
  await runTool(
    deps,
    "agreement_get",
    { agreement_id: "agr_x" },
    { contract: 99 },
  );
  const sent = calls.find((c) => c.op === "send_tool");
  assert.equal(sent?.args.name, "agreement_get");
});
