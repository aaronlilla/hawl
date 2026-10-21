import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ID_PREFIXES, isId, newId } from "./ids.ts";
import {
  isToolName,
  TOOL_NAMES,
  validate,
  validateToolArgs,
  validateToolResult,
  YARD_TOOL_NAMES,
} from "./validate.ts";

/** m2 F0 (contract 3.2, 3.6, 3.7): yard tool lists, new ids and the limits on the new schemas. */

const hnd = newId("hnd");
const crit = [{ id: "c1", text: "no crash on iOS 19", check: "device" }];
const job = {
  title: "Fix login crash",
  spec: "Crash on launch.",
  criteria: crit,
};

test("TOOL_NAMES is unchanged and the yard tools are a separate, disjoint list", () => {
  assert.equal(TOOL_NAMES.length, 19);
  assert.deepEqual(
    [...YARD_TOOL_NAMES],
    [
      "job_open",
      "job_status",
      "ledger_read",
      "menu_get",
      "menu_set",
      "work_start",
      "work_update",
      "ask_human",
      "approval_ask",
      "approval_use",
      "line_open",
      "artifact_get",
    ],
  );
  for (const t of YARD_TOOL_NAMES)
    assert.ok(!(TOOL_NAMES as readonly string[]).includes(t), t);
});

test("isToolName accepts both lists and nothing else", () => {
  for (const t of [...TOOL_NAMES, ...YARD_TOOL_NAMES])
    assert.equal(isToolName(t), true, t);
  for (const x of ["job_close", "", "JOB_OPEN", null, 3, undefined])
    assert.equal(isToolName(x), false, String(x));
});

test("validateToolArgs and validateToolResult take yard tools", () => {
  assert.ok(validateToolArgs("job_open", job).ok);
  assert.ok(!validateToolArgs("job_open", {}).ok);
  assert.ok(validateToolArgs("who", {}).ok, "old tools still work");
  assert.ok(validateToolResult("work_start", { card_id: newId("crd") }).ok);
  assert.ok(!validateToolResult("work_start", { card_id: hnd }).ok);
});

test("new id prefixes parse and match their common.schema patterns", () => {
  for (const p of ["crd", "dln", "hsk", "aap", "art", "chk"] as const) {
    assert.ok((ID_PREFIXES as readonly string[]).includes(p), p);
    const id = newId(p);
    assert.ok(isId(id, p), id);
    assert.ok(
      validate("tools/work_update.args", {
        card_id: newId("crd"),
        state: "done",
      }).ok,
    );
  }
  assert.ok(
    validateToolResult("line_open", { line_id: newId("dln"), state: "open" })
      .ok,
  );
  assert.ok(
    !validateToolResult("line_open", { line_id: newId("hnd"), state: "open" })
      .ok,
  );
  assert.ok(
    validateToolResult("ask_human", { status: "waiting", ask_id: newId("hsk") })
      .ok,
  );
  assert.ok(
    validateToolResult("approval_ask", {
      status: "waiting",
      approval_id: newId("aap"),
    }).ok,
  );
  assert.ok(
    !validateToolResult("approval_ask", {
      status: "waiting",
      approval_id: newId("act"),
    }).ok,
    "the old act_ prefix is not an agent action approval",
  );
});

test("job_open limits: title 120, spec 8000, criteria 1-10, idempotency key 64", () => {
  const ok = (a: unknown) => validateToolArgs("job_open", a).ok;
  assert.ok(ok({ ...job, title: "x".repeat(120) }));
  assert.ok(!ok({ ...job, title: "x".repeat(121) }));
  assert.ok(ok({ ...job, spec: "x".repeat(8000) }));
  assert.ok(!ok({ ...job, spec: "x".repeat(8001) }));
  assert.ok(!ok({ ...job, criteria: [] }));
  const ten = Array.from({ length: 10 }, (_, i) => ({
    id: `c${i}`,
    text: "t",
    check: "ci",
  }));
  assert.ok(ok({ ...job, criteria: ten }));
  assert.ok(
    !ok({ ...job, criteria: [...ten, { id: "c10", text: "t", check: "ci" }] }),
  );
  assert.ok(ok({ ...job, idempotency_key: "k".repeat(64) }));
  assert.ok(!ok({ ...job, idempotency_key: "k".repeat(65) }));
  assert.ok(!ok({ ...job, idempotency_key: "has space" }));
  assert.ok(ok({ ...job, to_yard: "y-1a2b3c4d", prefer: "@cc-ios" }));
  assert.ok(ok({ ...job, to_yard: newId("vil") }));
  assert.ok(!ok({ ...job, to_yard: newId("res") }), "a resident is not a yard");
  assert.ok(!ok({ ...job, capability: "-leading-dash" }));
  assert.ok(ok({ ...job, capability: `a${"b".repeat(62)}` }));
  assert.ok(!ok({ ...job, capability: `a${"b".repeat(63)}` }));
});

test("job_open result always carries the routing explanation", () => {
  const explain = {
    via: "menu",
    skipped: [{ yard: "y-1a2b3c4d", why: "menu_closed" }],
  };
  assert.ok(
    validateToolResult("job_open", {
      decision: "routed",
      handoff_id: hnd,
      explain,
    }).ok,
  );
  assert.ok(
    !validateToolResult("job_open", { decision: "routed", handoff_id: hnd }).ok,
  );
  assert.ok(
    !validateToolResult("job_open", {
      decision: "routed",
      explain: {
        via: "menu",
        skipped: [{ yard: "y-1", why: "Free text, not a code" }],
      },
    }).ok,
  );
});

test("ask_human: 5 choices, wait 0-120 s, a question to the requester needs the job", () => {
  const ok = (a: unknown) => validateToolArgs("ask_human", a).ok;
  const base = { question: "Ship it?", to: "owner" };
  assert.ok(ok({ ...base, wait_s: 0 }));
  assert.ok(ok({ ...base, wait_s: 120 }));
  assert.ok(!ok({ ...base, wait_s: 121 }));
  assert.ok(ok({ ...base, choices: ["a", "b", "c", "d", "e"] }));
  assert.ok(!ok({ ...base, choices: ["a", "b", "c", "d", "e", "f"] }));
  assert.ok(!ok({ question: "Which OS?", to: "requester" }));
  assert.ok(ok({ question: "Which OS?", to: "requester", handoff_id: hnd }));
  assert.ok(
    !validateToolResult("ask_human", {
      status: "answered",
      ask_id: newId("hsk"),
    }).ok,
  );
});

test("approvals and lines: action enum, git sha, ttl 1-1440", () => {
  assert.ok(
    validateToolArgs("approval_ask", {
      action: "push_main",
      target: "main",
      sha: "a".repeat(40),
    }).ok,
  );
  assert.ok(
    !validateToolArgs("approval_ask", { action: "push", target: "main" }).ok,
  );
  assert.ok(
    !validateToolArgs("approval_ask", {
      action: "release",
      target: "x",
      sha: "abc",
    }).ok,
  );
  const line = (ttl: number) =>
    validateToolArgs("line_open", {
      handoff_id: hnd,
      to: "@qa",
      purpose: "repro",
      ttl_minutes: ttl,
    }).ok;
  assert.equal(line(0), false);
  assert.equal(line(1), true);
  assert.equal(line(1440), true);
  assert.equal(line(1441), false);
});

test("work cards are one short line, never a prompt", () => {
  const ok = (a: unknown) => validateToolArgs("work_start", a).ok;
  assert.ok(ok({ title: "x".repeat(80) }));
  assert.ok(!ok({ title: "x".repeat(81) }));
  assert.ok(!ok({ title: "two\nlines" }));
  assert.ok(!ok({ title: "t", prompt: "the user's words" }));
});

test("handoff and handoff_update accept the m2 additions and nothing looser", () => {
  assert.ok(
    validateToolArgs("handoff", {
      task_type: "device-test-ios",
      title: "t",
      spec: "s",
      criteria: crit,
    }).ok,
  );
  const upd = (evidence: unknown, op = "done") =>
    validateToolArgs("handoff_update", { handoff_id: hnd, op, evidence }).ok;
  assert.ok(
    validateToolArgs("handoff_update", { handoff_id: hnd, op: "sign_off" }).ok,
  );
  assert.ok(
    upd({
      artifacts: [
        {
          kind: "github_artifact",
          url: "https://github.com/a/b/actions/runs/1/artifacts/2",
        },
      ],
    }),
  );
  assert.ok(upd({ artifacts: [{ kind: "file", file_id: newId("fil") }] }));
  assert.ok(!upd({ artifacts: [{ kind: "file", url: "https://x.test" }] }));
  assert.ok(upd({ device: { platform: "android", result: "fail" } }, "reject"));
  assert.ok(!upd({ device: { platform: "android" } }, "reject"));
  assert.ok(upd({ cost_usd: 0 }));
  assert.ok(!upd({ cost_usd: -0.01 }));
});

test("ledger and yard shapes: published card fields only, null means unknown", () => {
  const ledger = {
    as_of: "2026-10-18T09:00:00Z",
    site: {
      id: newId("twn"),
      yard_rule: "enforced",
      classifier_mode: "suggest",
    },
    yards: [
      {
        id: newId("vil"),
        slug: "y-1a2b3c4d",
        display_name: "Haiping's yard",
        owner_display: "Haiping",
        mine: false,
        state: "busy",
        last_contact_at: null,
        foreman: null,
        heartbeat: null,
        slots_free: 0,
        visibility: "summary",
        capabilities: [],
        cards: [{ state: null, capability: null, title: null, repo: null }],
      },
    ],
    jobs: [],
    hints: [
      {
        kind: "likely_next",
        capability: "device-test-android",
        yard: "y-1a2b3c4d",
        after: "card",
      },
    ],
  };
  assert.ok(validate("ledger", ledger).ok);
  assert.ok(validateToolResult("ledger_read", ledger).ok);
  const guessed = structuredClone(ledger);
  (guessed.yards[0] as Record<string, unknown>).cards = [{ state: "working" }];
  assert.ok(
    !validate("ledger", guessed).ok,
    "a card must state every field, null when unknown",
  );
  assert.ok(
    validate("yard", {
      yard: {
        id: newId("vil"),
        slug: "y-1a2b3c4d",
        display_name: "Aaron's yard",
        kind: "gateway",
      },
      station: null,
      sites: [],
    }).ok,
  );
});

/** Gateway-contract heartbeat: protocol keeps an identical copy (it cannot import that package). */
const readJson = (rel: string) =>
  JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
const GATEWAY_HEARTBEAT =
  "../../gateway-contract/schemas/heartbeat.schema.json";
const PROTOCOL_HEARTBEAT = "../schemas/heartbeat.schema.json";
const hbVectors = (
  readJson("../../gateway-contract/vectors/heartbeat.json") as {
    cases: { name: string; valid: boolean; value: unknown }[];
  }
).cases;

test("protocol heartbeat schema matches the gateway-contract one exactly, apart from $id", () => {
  const { $id: gid, ...g } = readJson(GATEWAY_HEARTBEAT);
  const { $id: pid, ...p } = readJson(PROTOCOL_HEARTBEAT);
  assert.equal(
    gid,
    "https://hawl.ai/gateway-contract/schemas/heartbeat.schema.json",
  );
  assert.equal(pid, "https://hawl.ai/protocol/schemas/heartbeat.schema.json");
  assert.deepEqual(p, g);
});

test("every gateway-contract heartbeat vector gets the same answer from protocol", () => {
  assert.equal(hbVectors.filter((c) => !c.valid).length, 5);
  for (const c of hbVectors)
    assert.equal(validate("heartbeat", c.value).ok, c.valid, c.name);
});

test("the ledger and ledger_read take only a contract heartbeat (or null)", () => {
  const ledger = (heartbeat: unknown) => ({
    as_of: "2026-10-18T09:00:00Z",
    site: { id: newId("twn"), yard_rule: "shadow", classifier_mode: "suggest" },
    yards: [
      {
        id: newId("vil"),
        slug: "qa-yard",
        display_name: "QA's yard",
        owner_display: "Haiping",
        mine: false,
        state: "online",
        last_contact_at: null,
        foreman: null,
        heartbeat,
        slots_free: 1,
        visibility: "summary",
        capabilities: [],
        cards: [],
      },
    ],
    jobs: [],
    hints: [],
  });
  for (const c of hbVectors) {
    assert.equal(
      validate("ledger", ledger(c.value)).ok,
      c.valid,
      `ledger: ${c.name}`,
    );
    assert.equal(
      validateToolResult("ledger_read", ledger(c.value)).ok,
      c.valid,
      `ledger_read: ${c.name}`,
    );
  }
  assert.ok(validate("ledger", ledger(null)).ok);
  assert.ok(!validate("ledger", ledger({})).ok);
});

/** Gateway-contract menu: protocol keeps an identical copy, plus a draft form for agents. */
const GATEWAY_MENU = "../../gateway-contract/schemas/menu.schema.json";
const RELAY_FILLED = ["yard", "owner", "display_name"];
const menuVectors = (
  readJson("../../gateway-contract/vectors/menu.json") as {
    cases: { name: string; valid: boolean; value: unknown }[];
  }
).cases;

test("protocol menu schema matches the gateway-contract one exactly, apart from $id", () => {
  const { $id: gid, ...g } = readJson(GATEWAY_MENU);
  const { $id: pid, ...p } = readJson("../schemas/menu.schema.json");
  assert.equal(
    gid,
    "https://hawl.ai/gateway-contract/schemas/menu.schema.json",
  );
  assert.equal(pid, "https://hawl.ai/protocol/schemas/menu.schema.json");
  assert.deepEqual(p, g);
});

test("menu-draft is the gateway menu with only $id, title and the relay-filled required fields changed", () => {
  const g = readJson(GATEWAY_MENU);
  const d = readJson("../schemas/menu-draft.schema.json");
  assert.deepEqual(d, {
    ...g,
    $id: "https://hawl.ai/protocol/schemas/menu-draft.schema.json",
    title:
      "Gateway menu, draft (yard, owner and display_name are filled by the relay)",
    required: (g.required as string[]).filter((r) => !RELAY_FILLED.includes(r)),
  });
});

test("every gateway-contract menu vector gets the same answer from menu, menu_set and menu_get", () => {
  assert.ok(menuVectors.filter((c) => !c.valid).length >= 9);
  const got = (menu: unknown) => ({
    published: null,
    revision: 0,
    draft: null,
    draft_revision: 0,
    stations: [],
    ...(menu as object),
  });
  for (const c of menuVectors) {
    assert.equal(validate("menu", c.value).ok, c.valid, `menu: ${c.name}`);
    assert.equal(
      validateToolArgs("menu_set", { menu: c.value }).ok,
      c.valid,
      `menu_set: ${c.name}`,
    );
    assert.equal(
      validateToolResult("menu_get", got({ published: c.value, revision: 1 }))
        .ok,
      c.valid,
      `menu_get published: ${c.name}`,
    );
    assert.equal(
      validateToolResult("menu_get", got({ draft: c.value, draft_revision: 1 }))
        .ok,
      c.valid,
      `menu_get draft: ${c.name}`,
    );
  }
});

test("a draft may leave out the relay-filled fields; a published menu may not", () => {
  const draft = {
    visibility: "summary",
    capabilities: [
      { id: "ios-change", description: "Change the iOS app", approval: "auto" },
    ],
  };
  assert.ok(validateToolArgs("menu_set", { menu: draft }).ok);
  assert.ok(validate("menu-draft", draft).ok);
  assert.ok(!validate("menu", draft).ok);
  const page = { revision: 1, draft: null, draft_revision: 0, stations: [] };
  assert.ok(!validateToolResult("menu_get", { ...page, published: draft }).ok);
  assert.ok(
    validateToolResult("menu_get", {
      ...page,
      published: null,
      draft,
      draft_revision: 1,
    }).ok,
  );
  assert.ok(
    !validateToolArgs("menu_set", { menu: { ...draft, visibility: "public" } })
      .ok,
  );
});
