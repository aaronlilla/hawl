import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ContractError,
  type ContractKind,
  check,
  ReferenceGateway,
  roundTrip,
  type TaskState,
} from "./reference-gateway.ts";

const VECTORS = new URL("../vectors/", import.meta.url);
const load = (f: string) =>
  JSON.parse(readFileSync(new URL(f, VECTORS), "utf8"));

interface Case {
  name: string;
  valid: boolean;
  value: unknown;
}

for (const kind of [
  "menu",
  "heartbeat",
  "lifecycle",
] as const satisfies ContractKind[]) {
  const file = load(`${kind}.json`) as { schema: string; cases: Case[] };

  test(`${kind}: vector file names its schema and has valid and invalid cases`, () => {
    assert.equal(file.schema, kind);
    assert.ok(file.cases.some((c) => c.valid));
    assert.ok(file.cases.some((c) => !c.valid));
  });

  for (const c of file.cases) {
    test(`${kind}: ${c.valid ? "round-trips" : "rejects"} ${c.name}`, () => {
      if (c.valid) {
        assert.equal(check(kind, c.value), null);
        assert.deepEqual(roundTrip(kind, c.value), c.value);
      } else {
        assert.notEqual(check(kind, c.value), null);
        assert.throws(() => roundTrip(kind, c.value), ContractError);
      }
    });
  }
}

const menuCases = (load("menu.json") as { cases: Case[] }).cases;
const hbCases = (load("heartbeat.json") as { cases: Case[] }).cases;
const lcCases = (load("lifecycle.json") as { cases: Case[] }).cases;
const menu = (name: string) => menuCases.find((c) => c.name === name)?.value;
const hb = (name: string) =>
  hbCases.find((c) => c.name === name)?.value as Record<string, unknown>;

test("gateway publishes the menu it was given", () => {
  const m = menu("spec example, two capabilities");
  assert.deepEqual(new ReferenceGateway(m).publishMenu(), m);
});

test("gateway refuses an invalid menu", () => {
  assert.throws(
    () => new ReferenceGateway(menu("unknown visibility level")),
    ContractError,
  );
});

test("heartbeat: summary yard drops inner agents", () => {
  const g = new ReferenceGateway(menu("spec example, two capabilities"));
  const beat = {
    ...hb("spec example"),
    agents: [{ id: "a1", status: "busy" }],
  };
  assert.equal("agents" in g.heartbeat(beat), false);
});

test("heartbeat: full yard keeps inner agents", () => {
  const g = new ReferenceGateway(menu("full visibility, wildcard file type"));
  const beat = { ...hb("full visibility lists inner agents") };
  assert.equal(g.heartbeat(beat).agents?.length, 2);
});

test("heartbeat: wrong yard is refused", () => {
  const g = new ReferenceGateway(menu("minimal private yard, no capabilities"));
  assert.throws(() => g.heartbeat(hb("spec example")), ContractError);
});

const flows = load("flows.json") as {
  flows: Array<{ name: string; events: string[]; states: TaskState[] }>;
  illegal: Array<{ name: string; events: string[] }>;
};

function ev(spec: string, i: number): Record<string, unknown> {
  const [event, result] = spec.split(":");
  const base: Record<string, unknown> = {
    yard: "qa-yard",
    task_id: "t1",
    event,
    at: `2026-10-10T18:${String(i).padStart(2, "0")}:00Z`,
  };
  if (event === "done") {
    base.revision_sha = "0123456789abcdef0123456789abcdef01234567";
    base.evidence = [{ kind: "ci", ref: "https://ci.example.com/runs/42" }];
  }
  if (event === "verify") {
    base.revision_sha = "0123456789abcdef0123456789abcdef01234567";
    base.result = result;
  }
  if (event === "reassign") base.to = "other-yard";
  return base;
}

for (const f of flows.flows) {
  test(`flow: ${f.name}`, () => {
    const g = new ReferenceGateway(
      menu("minimal private yard, no capabilities"),
    );
    const seen = f.events.map((e, i) => g.apply(ev(e, i)));
    assert.deepEqual(seen, f.states);
  });
}

for (const f of flows.illegal) {
  test(`illegal: ${f.name}`, () => {
    const g = new ReferenceGateway(
      menu("minimal private yard, no capabilities"),
    );
    assert.throws(() => {
      f.events.forEach((e, i) => {
        g.apply(ev(e, i));
      });
    }, /transition:/);
  });
}

test("every valid lifecycle vector event is covered by a flow or a direct-line test", () => {
  const covered = new Set(
    flows.flows.flatMap((f) => f.events.map((e) => e.split(":")[0])),
  );
  const vectors = new Set(
    lcCases
      .filter((c) => c.valid)
      .map((c) => (c.value as { event: string }).event),
  );
  for (const e of vectors) {
    assert.ok(
      covered.has(e) || e.startsWith("direct_line_"),
      `event ${e} has no flow`,
    );
  }
});

test("direct line: open, approve, then a second open is allowed only after close", () => {
  const g = new ReferenceGateway(menu("minimal private yard, no capabilities"));
  g.apply(ev("offer", 0));
  g.apply(ev("accept", 1));
  const open = lcCases.find((c) => c.name === "direct_line_open")
    ?.value as Record<string, unknown>;
  const reject = lcCases.find(
    (c) => c.name === "direct_line_reject with reason",
  )?.value as Record<string, unknown>;
  const approve = lcCases.find((c) => c.name === "direct_line_approve")
    ?.value as Record<string, unknown>;
  assert.throws(() => g.apply(approve), /pending direct line/);
  g.apply(open);
  assert.throws(() => g.apply(open), /already requested/);
  g.apply(reject);
  g.apply(open);
  g.apply(approve);
  assert.equal(g.stateOf("t1"), "accepted");
});

test("direct line: needs an accepted task", () => {
  const g = new ReferenceGateway(menu("minimal private yard, no capabilities"));
  const open = lcCases.find((c) => c.name === "direct_line_open")?.value;
  assert.throws(() => g.apply(open), /accepted task/);
});
