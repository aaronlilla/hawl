import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanText,
  flowOrder,
  type GuideTree,
  type JevRead,
  jevQuestions,
  newRoleId,
  type Pick,
  parseJevReply,
  RESERVED_ROLE_IDS,
  roleMatchQuestions,
  type SetupInput,
  sameWords,
  setupSkips,
  type Walk,
  walkSetup,
} from "./guide-tree.ts";
import { loadGuideTree } from "./guide-tree-file.ts";

/** The role cap, read where it lives: tree.json, next to the own-words role loop. */
const MAX_CHARTER_ROLES = loadGuideTree().trees.setup?.nodes.role_text_loop
  ?.max_roles as number;

const tree: GuideTree = loadGuideTree();

/** A Jev reply in the shape TypeSafe returns, parsed the way the relay parses it. */
function reply(
  raw: Record<
    string,
    [string, number] | { score: number; p: Record<string, number> }
  >,
): JevRead {
  const answers: Record<string, unknown> = {};
  for (const [q, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      const [choice, p] = v;
      answers[q] = { choice, confidence: p, probabilities: { [choice]: p } };
    } else {
      const top = Math.max(...Object.values(v.p));
      answers[q] = { score: v.score, confidence: top, probabilities: v.p };
    }
  }
  const parsed = parseJevReply({ answers });
  assert.ok(parsed);
  return { ok: true, answers: parsed };
}

/** The fields the charter card shows; the saved charter must equal them exactly. */
const cardOf = (c: Walk["charter"]) =>
  c && {
    purpose: c.purpose,
    roles: c.roles,
    flows: c.flows,
    classifier_mode: c.classifier_mode,
    agreements_consent: c.agreements_consent,
    end: c.end,
  };

/**
 * The person keeps every Recommended answer except the ones in `change`. Every replay also checks
 * that the flow shown at q_flow and the card shown at confirm are exactly what gets saved.
 */
function run(
  input: Omit<SetupInput, "picks">,
  change: Record<string, Pick> = {},
  t: GuideTree = tree,
): Walk {
  // Changes are given up front, so a skipped node's chip can be changed too.
  const picks: Record<string, Pick> = { ...change };
  const flowsShown: string[][] = [];
  let card: ReturnType<typeof cardOf> = null;
  for (let i = 0; i < 400; i++) {
    const w = walkSetup(t, { ...input, picks });
    if (!w.pending) {
      assert.ok(w.charter, "walk ends with a charter");
      for (const f of flowsShown)
        assert.deepEqual(f, flowOrder(w.charter.roles), "flow shown == saved");
      assert.deepEqual(card, cardOf(w.charter), "card shown == charter saved");
      return w;
    }
    if (w.pending.node === "q_flow") flowsShown.push(w.flow);
    if (w.pending.node === "confirm") card = cardOf(w.card);
    picks[w.pending.key] = w.pending.recommended;
  }
  throw new Error("walk did not finish");
}
const shown = (w: Walk) => w.steps.filter((s) => s.shown).map((s) => s.key);
const step = (w: Walk, key: string) => {
  const s = w.steps.find((x) => x.key === key);
  assert.ok(s, `step ${key}`);
  return s;
};

const NA = ["na", 0.9] as [string, number];
// Recorded Jev answers for the three walks in TREE.md (numbers copied from it).
const MAYA = reply({
  shape: ["solo_agents", 0.93],
  shape_rev: ["solo_agents", 0.92],
  people: { score: 0, p: { "1": 0.95, "2-3": 0.04 } },
  purpose: ["software_product", 0.71],
  role_pm: NA,
  role_developer: NA,
  role_qa: NA,
  role_designer: NA,
  role_other_named: NA,
  checker: ["unsure", 0.6],
  tool_claude_code: ["yes", 0.97],
  tool_codex: NA,
  tool_cursor: NA,
  tool_chat: NA,
});
const PRIYA_TEXT =
  "Tom does QA, Sam codes, I'm the PM. Our Claude Code agents should pass work to each other.";
const PRIYA = reply({
  shape: ["my_team", 0.95],
  shape_rev: ["my_team", 0.94],
  people: { score: 1, p: { "1": 0.05, "2-3": 0.88, "4-10": 0.07 } },
  purpose: ["software_product", 0.7],
  role_pm: ["yes", 0.92],
  role_developer: ["yes", 0.86],
  role_qa: ["yes", 0.93],
  role_designer: ["na", 0.9],
  role_other_named: ["no", 0.84],
  checker: ["pm_signs_off", 0.66],
  tool_claude_code: ["yes", 0.95],
  tool_codex: NA,
  tool_cursor: NA,
  tool_chat: NA,
});
const LENA = reply({
  shape: ["client_contractor", 0.62],
  shape_rev: ["client_contractor", 0.6],
  people: { score: 1, p: { "1": 0.3, "2-3": 0.55 } },
  purpose: ["client_project", 0.8],
  role_pm: NA,
  role_developer: NA,
  role_qa: NA,
  role_designer: NA,
  role_other_named: NA,
  checker: ["pm_signs_off", 0.84],
  tool_claude_code: NA,
  tool_codex: NA,
  tool_cursor: NA,
  tool_chat: NA,
});
const DOWN: JevRead = { ok: false, why: "timeout" };

describe("TREE.md walks with recorded Jev answers", () => {
  it("Walk 1 Maya: 4 taps, E_solo", () => {
    const w = run({
      open: "I run Claude Code in three repos and they keep stepping on each other.",
      read: MAYA,
    });
    assert.deepEqual(shown(w), [
      "q_solo_split",
      "q_auto",
      "q_agree_yes",
      "confirm",
    ]);
    assert.equal(w.taps, 4);
    assert.equal(step(w, "q_shape").shown, false);
    assert.equal(step(w, "q_shape").answer, "solo_agents");
    assert.deepEqual(step(w, "q_tools").answer, ["claude_code"]);
    assert.equal(w.charter?.end, "E_solo");
    assert.deepEqual(
      w.charter?.roles.map((r) => r.id),
      ["developer"],
    );
    console.log(
      `maya taps=${w.taps} questions=${w.questions} end=${w.charter?.end}`,
    );
  });

  it("Walk 2 Priya (S64): 4 taps, at most 6 questions, flow PM > Developer > QA > PM", () => {
    const w = run({ open: PRIYA_TEXT, read: PRIYA });
    assert.deepEqual(shown(w), ["q_flow", "q_auto", "q_agree_yes", "confirm"]);
    assert.equal(w.taps, 4);
    assert.ok(w.questions <= 6);
    for (const k of ["q_shape", "q_roles", "q_tools"])
      assert.equal(step(w, k).shown, false, k);
    assert.deepEqual(w.flow, ["pm", "developer", "qa", "pm"]);
    const c = w.charter;
    assert.ok(c);
    assert.equal(c.end, "E_team");
    assert.deepEqual(
      c.roles.map((r) => r.id),
      ["pm", "developer", "qa"],
    );
    assert.deepEqual(c.flows, [
      { from: "pm", to: "developer" },
      { from: "developer", to: "qa" },
      { from: "qa", to: "pm" },
    ]);
    assert.equal(c.classifier_mode, "route");
    assert.equal(c.agreements_consent, "yes");
    assert.equal(c.purpose, PRIYA_TEXT.slice(0, 120));
    console.log(
      `priya taps=${w.taps} questions=${w.questions} flow=${w.flow.join(">")}`,
    );
  });

  it("Walk 3 Lena, Jev unsure: 7 taps, q_checker skipped, E_client", () => {
    const w = run(
      {
        open: "We're building a store for a client and they review each release.",
        read: LENA,
        purpose: "Store build for Acme",
      },
      { q_tools: ["claude_code", "codex"] },
    );
    assert.deepEqual(shown(w), [
      "q_shape",
      "q_side",
      "q_tools",
      "q_auto",
      "q_agree_yes",
      "confirm",
    ]);
    assert.equal(step(w, "q_shape").recommended, "client_contractor");
    assert.equal(step(w, "q_side").recommended, "contractor");
    assert.equal(step(w, "q_checker").shown, false);
    assert.equal(step(w, "q_checker").answer, "pm_signs_off");
    assert.equal(w.taps, 7);
    assert.equal(w.charter?.end, "E_client");
    assert.equal(w.charter?.purpose, "Store build for Acme");
    const contractor = w.charter?.roles.find((r) => r.id === "contractor");
    assert.deepEqual(contractor?.hands_to, ["client"]);
    assert.equal(contractor?.checked_by, "client");
    console.log(`lena taps=${w.taps} questions=${w.questions}`);
  });

  it("Walk 3 with Jev down: every node shows with its default, 9 taps, same charter", () => {
    const up = run(
      {
        open: "We're building a store for a client and they review each release.",
        read: LENA,
        purpose: "Store build for Acme",
      },
      { q_tools: ["claude_code", "codex"] },
    );
    const w = run(
      {
        open: "We're building a store for a client and they review each release.",
        read: DOWN,
        purpose: "Store build for Acme",
      },
      { q_shape: "client_contractor", q_tools: ["claude_code", "codex"] },
    );
    assert.deepEqual(shown(w), [
      "q_shape",
      "q_side",
      "q_checker",
      "q_tools",
      "q_auto",
      "q_agree_yes",
      "confirm",
    ]);
    assert.ok(w.steps.every((s) => s.shown));
    assert.equal(step(w, "q_shape").recommended, "solo_agents");
    assert.equal(step(w, "q_checker").recommended, "pm_signs_off");
    assert.equal(w.taps, 9);
    assert.deepEqual(w.charter?.roles, up.charter?.roles);
    assert.deepEqual(w.charter?.flows, up.charter?.flows);
    console.log(`lena-down taps=${w.taps}`);
  });
});

describe("skip rule boundaries", () => {
  const shapeAt = (p: number, twin = "my_team") =>
    reply({ shape: ["my_team", p], shape_rev: [twin, p] });
  const first = (read: JevRead) =>
    walkSetup(tree, { open: "x", read, picks: {} });

  it("0.79 shows (Recommended = Jev's pick), 0.80 skips", () => {
    const w79 = first(shapeAt(0.79));
    assert.equal(w79.pending?.key, "q_shape");
    assert.equal(w79.pending?.recommended, "my_team");
    const w80 = first(shapeAt(0.8));
    assert.notEqual(w80.pending?.key, "q_shape");
    assert.equal(step(w80, "q_shape").shown, false);
    console.log("0.79 shown, 0.80 skipped");
  });

  it("twin disagreeing shows the question even at 0.95", () => {
    const w = first(shapeAt(0.95, "solo_agents"));
    assert.equal(w.pending?.key, "q_shape");
  });

  it("below 0.5 Recommended falls back to default_recommended", () => {
    const w = first(
      reply({ shape: ["mixed", 0.4], shape_rev: ["mixed", 0.4] }),
    );
    assert.equal(w.pending?.recommended, "solo_agents");
  });

  it("an 'unsure' answer never skips", () => {
    const w = first(
      reply({ shape: ["unsure", 0.99], shape_rev: ["unsure", 0.99] }),
    );
    assert.equal(w.pending?.key, "q_shape");
  });

  it("Jev down: Priya's sentence shows every question with its default and still ends in a charter", () => {
    const w = run({ open: PRIYA_TEXT, read: DOWN });
    assert.ok(w.steps.every((s) => s.shown && s.source === "default"));
    const setup = tree.trees.setup?.nodes ?? {};
    for (const s of w.steps)
      assert.deepEqual(
        s.recommended,
        setup[s.node]?.default_recommended,
        s.key,
      );
    assert.ok(w.charter);
    assert.equal(w.charter.end, "E_solo");
  });

  it("never skips the Dispatcher mode, agreements consent, flow or charter card", () => {
    for (const read of [MAYA, PRIYA, LENA]) {
      const w = run({ open: "x", read });
      for (const k of ["q_auto", "q_agree_yes", "confirm"])
        assert.equal(step(w, k).shown, true, k);
    }
    assert.equal(step(run({ open: "x", read: PRIYA }), "q_flow").shown, true);
  });

  it("setupSkips lists what Priya's read skips", () => {
    assert.deepEqual(setupSkips(tree, PRIYA).sort(), [
      "q_roles",
      "q_shape",
      "q_tools",
    ]);
    assert.deepEqual(setupSkips(tree, DOWN), []);
  });
});

describe("own-words role (S61) and the question builder", () => {
  it("a typed role Jev calls new takes at most three more questions", () => {
    const w = run(
      {
        open: PRIYA_TEXT,
        read: PRIYA,
        roleReads: {
          data_wrangler: reply({
            role: ["new", 0.9],
            role_rev: ["new", 0.9],
            owns: ["research", 0.7],
          }),
        },
      },
      { q_roles: ["pm", "developer", "qa", "Data wrangler"] },
    );
    const loop = w.steps.filter((s) => s.key.endsWith("#data_wrangler"));
    assert.deepEqual(
      loop.filter((s) => s.shown).map((s) => s.node),
      ["q_owns", "q_hands_to", "q_checked_by"],
    );
    assert.deepEqual(step(w, "q_owns#data_wrangler").recommended, ["research"]);
    const r = w.charter?.roles.find((x) => x.id === "data_wrangler");
    assert.equal(r?.name, "Data wrangler");
    assert.deepEqual(r?.hands_to, ["pm"]);
  });

  it("a typed role Jev matches to a library role at 0.8 adds that role, no more questions", () => {
    const w = run(
      {
        open: "x",
        read: PRIYA,
        roleReads: {
          tester: reply({ role: ["qa", 0.9], role_rev: ["qa", 0.88] }),
        },
      },
      { q_roles: ["pm", "developer", "tester"] },
    );
    assert.equal(step(w, "q_role_match#tester").shown, false);
    assert.ok(!w.steps.some((s) => s.key === "q_owns#tester"));
    assert.deepEqual(
      w.charter?.roles.map((r) => r.id),
      ["pm", "developer", "qa"],
    );
  });

  it("builds the twin with the reversed criteria order", () => {
    const qs = jevQuestions(
      tree.trees.setup?.nodes.read_open ?? { kind: "x" },
    ) as Record<string, { criteria: Record<string, string> | string[] }>;
    assert.deepEqual(Object.keys(qs.shape_rev?.criteria ?? {}), [
      "unsure",
      "mixed",
      "pm_from_chat",
      "client_contractor",
      "my_team",
      "solo_agents",
    ]);
    assert.deepEqual(Object.keys(qs.shape?.criteria ?? {})[0], "solo_agents");
    assert.ok(Array.isArray(qs.people?.criteria));
    assert.equal(Object.keys(qs).length, 14);
  });
});

describe("presets and answers reach the charter (re-judge)", () => {
  type Want = Record<string, [string[], string]>;
  const roleMap = (w: Walk) =>
    Object.fromEntries(
      (w.charter?.roles ?? []).map((r) => [r.id, [r.hands_to, r.checked_by]]),
    );
  // Every path that adds roles from a preset, replayed with Jev down so each answer is a person's tap.
  const cases: [string, Record<string, Pick>, Want][] = [
    [
      "solo per_folder",
      { q_shape: "solo_agents", q_solo_split: "per_folder" },
      { developer: [[], "nobody"] },
    ],
    [
      "solo builder_reviewer",
      { q_shape: "solo_agents", q_solo_split: "builder_reviewer" },
      {
        developer: [["reviewer"], "reviewer"],
        reviewer: [["developer"], "nobody"],
      },
    ],
    [
      "solo plan_build_test",
      { q_shape: "solo_agents", q_solo_split: "plan_build_test" },
      {
        pm: [["developer"], "nobody"],
        developer: [["qa"], "qa"],
        qa: [["pm"], "pm"],
      },
    ],
    [
      "chat, my team builds",
      { q_shape: "pm_from_chat", q_who_builds: "my_team" },
      {
        pm: [["developer"], "nobody"],
        developer: [["qa"], "qa"],
        qa: [["pm"], "pm"],
      },
    ],
    [
      "chat, a contractor builds",
      { q_shape: "pm_from_chat", q_who_builds: "contractor" },
      {
        client: [["contractor"], "nobody"],
        contractor: [["client"], "client"],
      },
    ],
    [
      "chat, nobody yet",
      { q_shape: "pm_from_chat", q_who_builds: "not_yet" },
      { pm: [["developer"], "nobody"], developer: [["pm"], "pm"] },
    ],
    [
      "mixed, outside contractor",
      { q_shape: "mixed", q_external: "contractor" },
      {
        pm: [["developer"], "nobody"],
        developer: [["qa"], "qa"],
        qa: [["pm"], "pm"],
        contractor: [["qa"], "qa"],
      },
    ],
    [
      "mixed, outside client: PM delivers to the client, who signs it off",
      { q_shape: "mixed", q_external: "client" },
      {
        pm: [["developer", "client"], "client"],
        developer: [["qa"], "qa"],
        qa: [["pm"], "pm"],
        client: [[], "nobody"],
      },
    ],
    [
      "mixed, outside client, no PM: the final checker delivers to the client",
      { q_shape: "mixed", q_roles: ["developer", "qa"], q_external: "client" },
      {
        developer: [["qa"], "qa"],
        qa: [["developer", "client"], "client"],
        client: [[], "nobody"],
      },
    ],
    [
      "mixed, outside client, no PM and no checker: the role that hands to no one delivers",
      {
        q_shape: "mixed",
        q_roles: ["designer", "developer"],
        q_external: "client",
      },
      {
        designer: [["developer"], "nobody"],
        developer: [["client"], "client"],
        client: [[], "nobody"],
      },
    ],
    [
      "mixed, both",
      { q_shape: "mixed", q_external: "both" },
      {
        pm: [["developer", "client"], "client"],
        developer: [["qa"], "qa"],
        qa: [["pm"], "pm"],
        client: [["contractor"], "nobody"],
        contractor: [["client"], "client"],
      },
    ],
    [
      "client side, client signs off",
      { q_shape: "client_contractor", q_side: "client" },
      {
        client: [["contractor"], "nobody"],
        contractor: [["client"], "client"],
      },
    ],
    [
      "contractor side, I check my own agents",
      { q_shape: "client_contractor", q_side: "contractor", q_checker: "self" },
      { contractor: [["client"], "owner"], client: [["contractor"], "nobody"] },
    ],
    [
      "contractor side, someone other than the doer",
      {
        q_shape: "client_contractor",
        q_side: "contractor",
        q_checker: "another_person",
      },
      {
        contractor: [["client"], "client"],
        client: [["contractor"], "nobody"],
      },
    ],
  ];
  for (const [name, change, want] of cases)
    it(name, () => {
      const w = run({ open: "", read: DOWN }, change);
      for (const [k, v] of Object.entries(change))
        assert.deepEqual(step(w, k).answer, v, k);
      assert.deepEqual(roleMap(w), want);
    });

  it("q_checker 'self' skipped by Jev still applies: Lena with the chip changed", () => {
    const w = run({ open: "x", read: LENA }, { q_checker: "self" });
    assert.equal(
      w.charter?.roles.find((r) => r.id === "contractor")?.checked_by,
      "owner",
    );
  });
});

describe("re-judge 3: extra choices, card == saved, explicit edits, tree fields", () => {
  it("match_role_text questions carry the tree's extra 'new' choice, twin too", () => {
    const qs = roleMatchQuestions(tree, []) as Record<
      string,
      { criteria: Record<string, string> }
    >;
    assert.ok(qs.role?.criteria.new, "role offers new");
    assert.ok(qs.role_rev?.criteria.new, "twin offers new");
    assert.ok(qs.role?.criteria.pm && qs.role?.criteria.contractor);
    assert.deepEqual(
      Object.keys(qs.owns?.criteria ?? {}),
      tree.role_library.work_kinds,
    );
    const node = tree.trees.setup?.nodes.match_role_text ?? { kind: "x" };
    const direct = jevQuestions(node, { role: [["pm", "PM"]] }) as Record<
      string,
      { criteria: Record<string, string> }
    >;
    assert.deepEqual(Object.keys(direct.role?.criteria ?? {}), ["pm", "new"]);
  });

  it("a person's hand-off edit is kept: no client link added over it", () => {
    const w = run(
      { open: "", read: DOWN },
      {
        q_shape: "mixed",
        q_external: "client",
        q_flow: "change",
        "q_hands_to#pm~1": "qa",
      },
    );
    const pm = w.charter?.roles.find((r) => r.id === "pm");
    assert.deepEqual(pm?.hands_to, ["qa"]);
  });

  it("keeping every Recommended hand-off after 'change' saves the same roles as 'yes'", () => {
    const base = { q_shape: "mixed", q_external: "client" };
    const yes = run({ open: "", read: DOWN }, base);
    const changed = run(
      { open: "", read: DOWN },
      { ...base, q_flow: "change" },
    );
    assert.deepEqual(changed.charter?.roles, yes.charter?.roles);
  });

  it("reads jev.threshold from the tree", () => {
    const t = structuredClone(tree);
    t.jev.threshold = 0.9;
    const read = reply({
      shape: ["my_team", 0.85],
      shape_rev: ["my_team", 0.85],
    });
    assert.equal(
      walkSetup(tree, { open: "x", read, picks: {} }).pending?.key !==
        "q_shape",
      true,
    );
    assert.equal(
      walkSetup(t, { open: "x", read, picks: {} }).pending?.key,
      "q_shape",
    );
  });

  it("reads q_owns default_recommended from the tree", () => {
    const t = structuredClone(tree);
    const owns = t.trees.setup?.nodes.q_owns;
    assert.ok(owns);
    owns.default_recommended = ["docs"];
    const w = walkSetup(t, {
      open: "x",
      read: DOWN,
      picks: {
        q_shape: "my_team",
        q_roles: ["pm", "Data wrangler"],
        "q_role_match#data_wrangler": "new",
      },
    });
    assert.equal(w.pending?.key, "q_owns#data_wrangler");
    assert.deepEqual(w.pending?.recommended, ["docs"]);
  });
});

describe("re-judge 4: role ids are unique and never reserved", () => {
  const ids = (w: Walk) => w.charter?.roles.map((r) => [r.id, r.name]);

  it("two non-Latin names get two distinct ids and both are saved", () => {
    const w = run(
      { open: "", read: DOWN },
      { q_shape: "my_team", q_roles: ["pm", "开发", "测试"] },
    );
    assert.deepEqual(ids(w), [
      ["pm", "PM"],
      ["role_1", "开发"],
      ["role_2", "测试"],
    ]);
    assert.deepEqual(w.charter?.tree_answers.q_roles?.answer, [
      "pm",
      "role_1",
      "role_2",
    ]);
  });

  it("names that slug the same, a library name and a reserved word never collide", () => {
    const w = run(
      { open: "", read: DOWN },
      {
        q_shape: "my_team",
        q_roles: ["pm", "Data wrangler", "data-wrangler", "QA", "Watching"],
      },
    );
    assert.deepEqual(
      w.charter?.roles.map((r) => r.id),
      ["pm", "data_wrangler", "data_wrangler_2", "qa_2", "watching_2"],
    );
  });

  it("newRoleId: one function for every generated id", () => {
    assert.equal(newRoleId(tree, "Café Ops", []), "cafe_ops");
    assert.equal(newRoleId(tree, "开发", []), "role_1");
    assert.equal(newRoleId(tree, "开发", ["role_1"]), "role_2");
    assert.equal(newRoleId(tree, "Developer", []), "developer_2");
    for (const r of RESERVED_ROLE_IDS)
      assert.notEqual(newRoleId(tree, r, []), r);
  });
});

/** Tricky role names: non-Latin, duplicates, library names in other cases, reserved, JS names. */
export const TRICKY = [
  "开发",
  "测试",
  "开发",
  "Data wrangler",
  "data wrangler",
  "QA",
  "Qa",
  "qa",
  "Watching",
  "new",
  "none",
  "owner",
  "nobody",
  "constructor",
  "__proto__",
  "prototype",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "  ",
  "",
  "x".repeat(200),
  "Café Ops",
];

describe("re-judge 5: per-role keys and own-property lookups", () => {
  it("a typed role matched to a library role keeps its key: no second role_1", () => {
    const sure = (c: string) =>
      reply({ role: [c, 0.9], role_rev: [c, 0.9], owns: ["other", 0.6] });
    const w = run(
      {
        open: "",
        read: DOWN,
        roleReads: { role_1: sure("qa"), role_2: sure("new") },
      },
      { q_shape: "my_team", q_roles: ["pm", "测试", "财务"] },
    );
    const keys = w.steps.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length, "step keys unique");
    assert.equal(step(w, "q_role_match#role_1").answer, "qa");
    assert.equal(step(w, "q_role_match#role_2").answer, "new");
    assert.deepEqual(
      w.charter?.roles.map((r) => [r.id, r.name]),
      [
        ["pm", "PM"],
        ["qa", "测试"], // matched on its own: the role keeps the owner's words
        ["role_2", "财务"],
      ],
    );
  });

  it("a role named constructor (or any JS prototype name) does not throw", () => {
    const w = run(
      { open: "", read: DOWN },
      { q_shape: "my_team", q_roles: ["pm", "constructor", "__proto__"] },
    );
    assert.deepEqual(
      w.charter?.roles.map((r) => r.id),
      ["pm", "constructor_2", "proto"],
    );
  });

  it("fuzz: every tricky name gives one valid, unique, non-reserved role", () => {
    // Blank names are refused and the step asks again, naming them; the person removes them.
    const first = walkSetup(tree, {
      open: "",
      read: DOWN,
      picks: { q_shape: "my_team", q_roles: ["pm", ...TRICKY] },
    });
    assert.equal(first.pending?.key, "q_roles");
    assert.equal(first.pending?.reask, "empty");
    assert.deepEqual(first.pending?.rejected, ["  ", ""]);
    const kept = TRICKY.filter((t) => !first.pending?.rejected?.includes(t));
    const w = run(
      { open: "", read: DOWN },
      { q_shape: "my_team", q_roles: ["pm", ...kept] },
    );
    const keys = w.steps.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length, "step keys unique");
    const roles = w.charter?.roles ?? [];
    const ids = roles.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "ids unique");
    for (const r of roles) {
      assert.match(r.id, /^[a-z][a-z0-9_]{0,39}$/);
      assert.ok(!(RESERVED_ROLE_IDS as readonly string[]).includes(r.id), r.id);
      assert.ok(r.name.trim() && r.name.length <= 60, r.id);
    }
    // "qa" itself is the library QA; the rest count once per same words (case, Unicode form).
    const typed = new Set(
      TRICKY.filter((t) => t !== "qa")
        .map((t) => sameWords(cleanText(t, 60)))
        .filter(Boolean),
    );
    assert.equal(roles.length, Math.min(MAX_CHARTER_ROLES, 2 + typed.size));
    const answer = w.charter?.tree_answers.q_roles?.answer as string[];
    assert.deepEqual([...answer].sort(), [...ids].sort());
  });
});
