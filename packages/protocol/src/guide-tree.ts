/**
 * The setup decision tree walker (G1), shared by the web guide, the Workstation and the relay.
 * Pure: `walkSetup(tree, input)` replays the tree from the Jev read and the person's picks so far
 * and returns every step, the first question still waiting for the person (or none), and, once the
 * walk ends, the charter draft. Call it again after each tap. No model writes a question, an option
 * or an answer; Jev only answers the narrow questions of a `jev_batch` node and code decides.
 *
 * Skip rule (TREE.md, the same for every node): skip only when Jev's confidence >= 0.8, the answer is
 * one of the node's options (never "unsure" or "na"), and for nodes with `order_check` the
 * reversed-order twin picks the same option. Otherwise the node shows and its Recommended is Jev's top
 * pick when that probability is >= 0.5, else `default_recommended`. Jev down or over budget: every
 * node shows with `default_recommended`. The Dispatcher mode, the agreements consent, the flow and
 * the charter card are never skipped.
 */

export type JevAnswer = {
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  score?: number;
};
/** One Jev batch result. `ok: false` is the Jev-down path (no key, timeout, error, cap). */
export type JevRead =
  | { ok: true; answers: Record<string, JevAnswer> }
  | { ok: false; why: string };
export type Pick = string | string[];
export type Source = "jev" | "person" | "default";

type Criteria = Record<string, string>;
export type JevQuestionDef = {
  type: "choice" | "score";
  instructions?: string;
  criteria?: Criteria;
  levels?: string[];
  order_check_of?: string;
  criteria_order?: string[];
  criteria_from?: string;
  extra?: Criteria;
};
export type TreeNode = {
  kind: string;
  say?: string;
  options?: Record<string, string>;
  default_recommended?: Pick;
  from_jev?: string | string[];
  order_check?: string;
  skip_if?: string;
  next?: string;
  branch?: Record<string, string>;
  next_by_shape?: Record<string, string>;
  makes_roles?: Record<string, string[] | string>;
  adds_roles?: Record<string, string[]>;
  map?: Record<string, string>;
  body?: string[];
  options_from?: string;
  /** Loop limits live in the tree next to the question they govern (role_text_loop, q_flow). */
  max_roles?: number;
  max_rounds?: number;
  /** The notice node shown when that limit is reached. */
  at_limit?: string;
  questions?: Record<string, JevQuestionDef>;
  max_chars?: number;
  recommended_if?: { when: string; pick: string }[];
};
export type LibraryRole = {
  label: string;
  owns: string[];
  hands_to: string[];
  checked_by: string;
  criteria: string;
};
export type GuideTree = {
  version: string;
  jev: { timeout_ms: number; threshold: number; state_max_chars: number };
  skip_rule: { never_skip: string[] };
  role_library: { roles: Record<string, LibraryRole>; work_kinds: string[] };
  trees: Record<string, { start: string; nodes: Record<string, TreeNode> }>;
};

export type Step = {
  /** Node id, plus `#<role>` inside a role loop and `~<n>` for a repeated round. */
  key: string;
  node: string;
  kind: string;
  shown: boolean;
  recommended: Pick;
  /** Unset while the step waits for the person. */
  answer?: Pick;
  source: Source;
  confidence?: number;
  /** Taps this step cost: 1 to accept a shown node, plus 1 per change from Recommended. */
  taps: number;
  /** Set when the step waits again because its answer was refused, and why. */
  reask?: "empty" | "too_long" | "not_an_option";
  /** The typed items that were refused (a list text answer), so the person can fix just those. */
  rejected?: string[];
};

export type CharterRole = {
  id: string;
  name: string;
  owns: string[];
  hands_to: string[];
  checked_by: string;
  library_id?: string;
};
export type CharterDraft = {
  purpose: string;
  roles: CharterRole[];
  flows: { from: string; to: string }[];
  classifier_mode: string;
  agreements_consent: string;
  tree_answers: Record<
    string,
    { answer: Pick; source: Source; confidence?: number }
  >;
  end: string;
};

export type SetupInput = {
  /** The opening sentence (may be empty). Only its first 120 chars become the purpose. */
  open: string;
  /** The `read_open` batch; null or `ok: false` means Jev down. */
  read: JevRead | null;
  /** `match_role_text` batches, keyed by the role's slug. */
  roleReads?: Record<string, JevRead | null>;
  /** The person's answers, keyed by step key. Text nodes take a string or string[]. */
  picks: Record<string, Pick>;
  /** The purpose as edited on the charter card. */
  purpose?: string;
  /**
   * Edit (W6): the saved team workflow's roles. A role in someone's own words (no library_id, e.g.
   * one a joiner added) stays on the card as saved when no question on this walk lists own-words
   * roles (the solo, client and chat paths): an edit never drops a role it could not show.
   * A kept role the walk makes again starts from its saved name, work, hand-off and checker, not the
   * library defaults, so an edit that changes nothing saves what was there; an own-words role typed
   * with a kept role's words keeps that role's id.
   */
  keep?: readonly CharterRole[];
};

export type Walk = {
  steps: Step[];
  pending: Step | null;
  taps: number;
  /** Questions shown to the person (skipped ones are chips, not questions). */
  questions: number;
  /** Role order of the flow as it stands (q_flow says it), from the same roles `card` holds. */
  flow: string[];
  /** The charter as it stands: what the charter card shows and, once confirmed, what is saved. */
  card: CharterDraft | null;
  charter: CharterDraft | null;
  /** Roles the person asked for that were not added: the charter already holds roleCap(tree). */
  over_cap: string[];
};

/** Own-property lookup: a key typed by a person ("constructor") never reaches Object.prototype. */
export function own<T>(
  o: Readonly<Record<string, T>> | undefined | null,
  k: string,
): T | undefined {
  return o && Object.hasOwn(o, k) ? o[k] : undefined;
}

/** A loop limit from the tree (never a code constant): `key` on setup node `node`. */
function treeLimit(
  tree: GuideTree,
  node: string,
  key: "max_roles" | "max_rounds",
) {
  const v = tree.trees.setup?.nodes[node]?.[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
    throw new Error(`tree.json: setup.${node}.${key} is missing`);
  return v;
}
/** Most roles one charter holds, from tree.json (role_text_loop.max_roles). The relay refuses more. */
export const roleCap = (tree: GuideTree) =>
  treeLimit(tree, "role_text_loop", "max_roles");
/** Times the order can be changed, from tree.json (q_flow.max_rounds). */
export const flowRounds = (tree: GuideTree) =>
  treeLimit(tree, "q_flow", "max_rounds");

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The one normalize step for text a person typed (names, purposes, typed answers), in the walker
 * and the relay. It runs FIRST; every check (blank, duplicate, length, id) reads its result.
 * Lone surrogates (half an emoji) dropped; NFC; invisible format characters (zero-width, BOM, bidi
 * marks) dropped, except a joiner inside an emoji sequence; control characters (NUL, tabs, new
 * lines) and runs of spaces become one space; trimmed; cut to at most `max` code points on a
 * whole-character (grapheme) boundary. "" when no letter or number is left: such an answer is
 * nothing and is asked again.
 */
export function cleanText(text: string, max = Infinity): string {
  const clean = (t: string) =>
    t
      .replace(/\p{Cs}/gu, "")
      .normalize("NFC")
      .replace(/(?!\u200d(?=\p{Extended_Pictographic}))\p{Cf}/gu, "")
      .replace(/[\p{Cc}\s]+/gu, " ")
      // At most 8 marks on one character (no script needs more): a stack of 70 is not a name.
      .replace(/(\p{M}{8})\p{M}+/gu, "$1")
      .trim();
  let t = clean(text);
  if (Number.isFinite(max) && [...t].length > max) {
    let out = "";
    let n = 0;
    for (const { segment } of graphemes.segment(t)) {
      const len = [...segment].length;
      if (n + len > max) break;
      out += segment;
      n += len;
    }
    t = clean(out);
  }
  return /[\p{L}\p{N}]/u.test(t) ? t : "";
}

/** Longest purpose (the site main goal) and yard goal, in code points (the relay refuses longer). */
export const PURPOSE_MAX = 500;

/** What a text slot makes of an answer: the exact value stored, or why it is asked again. */
export type Accepted =
  | { ok: true; value: string }
  | { ok: false; why: "empty" | "too_long" };

/**
 * The one gate for text a person types into a slot (role name, own-words role, purpose): normalize,
 * cut to the slot's limit, then judge the FINAL value. "empty": nothing visible was typed.
 * "too_long": it had words, but none survive the cut (e.g. 60 "!" then "Editor"), so the person is
 * asked again. On ok, `value` is exactly what the card shows and the relay stores; nothing later
 * cuts, cleans or drops it.
 */
export function acceptText(
  raw: unknown,
  max: number,
  ellipsis = false,
): Accepted {
  if (typeof raw !== "string" || !cleanText(raw))
    return { ok: false, why: "empty" };
  const full = cleanText(raw);
  let value = cleanText(raw, max);
  if (ellipsis && value && [...full].length > max) {
    // Cut on a word boundary and say so: "...finished when the age" is a half word.
    const kept = cleanText(raw, max - 1);
    const atWord = /\s/u.test(full.slice(kept.length, kept.length + 1));
    const words = atWord ? kept : kept.replace(/\s+\S*$/u, "") || kept;
    const base = words.replace(/[\s,;:.-]+$/u, "");
    value = /[\p{L}\p{N}]/u.test(base) ? `${base}…` : "";
  }
  return value ? { ok: true, value } : { ok: false, why: "too_long" };
}
export const acceptName = (raw: unknown) => acceptText(raw, NAME_MAX);
export const acceptPurpose = (raw: unknown) =>
  acceptText(raw, PURPOSE_MAX, true);

/** Same words for duplicate checks: case and Unicode form (NFC/NFD, full-width) folded. */
export const sameWords = (t: string) => t.normalize("NFKC").toLowerCase();

/** A role id: lower case a-z 0-9 _, starts with a letter (never integer-like: see jevQuestions). */
export const ROLE_ID = /^[a-z][a-z0-9_]{0,39}$/;
/** Longest role name, in code points (the relay refuses longer). */
export const NAME_MAX = 60;
export const SKIP_THRESHOLD = 0.8;
export const RECOMMEND_MIN = 0.5;
const NOT_ANSWERS = new Set(["unsure", "na"]);
/** Library order for a new role's default hand-off (TREE.json q_hands_to). */
const HANDS_TO_ORDER = ["pm", "designer", "developer", "qa", "reviewer", "ops"];
/** Where a cyclic flow starts, in order (flowOrder); QA comes last, other roles just before it. */
const FLOW_START = ["pm", "designer", "developer", "reviewer"];
/** Library roles the opening read asks about: its `role_<id>` questions. */
const askedRoles = (tree: GuideTree) =>
  Object.keys(tree.trees.setup?.nodes.read_open?.questions ?? {})
    .filter(
      (q) => q.startsWith("role_") && own(tree.role_library.roles, q.slice(5)),
    )
    .map((q) => q.slice(5));
/** The longest role id (relay ID pattern) and the longest JSON number a confidence in [0, 1] takes. */
const MAX_ID = 40;
const LONGEST_CONFIDENCE = 1.2345678901234567e-100;

/**
 * The most `tree_answers` a finished walk can hold and their longest JSON, derived from the tree:
 * every asked node once, the own-words role loop once per role (at most roleCap(tree) typed
 * roles), and every flow change round over every role. Each entry is sized at its worst: the
 * longest key, every option of a multi choice as a max-length id, source "default" and the longest
 * confidence. The relay refuses anything bigger.
 */
export function treeAnswersLimit(tree: GuideTree): {
  entries: number;
  chars: number;
} {
  const nodes = tree.trees.setup?.nodes ?? {};
  const maxRoles = roleCap(tree);
  const rounds = flowRounds(tree);
  const asked = new Set([
    "choice",
    "multi_choice",
    "confirm",
    "charter_card",
    "notice",
  ]);
  const perRole = (nodes.role_text_loop?.body ?? []).filter((id) =>
    asked.has(nodes[id]?.kind ?? ""),
  );
  const flowBody = (nodes.q_hands_to_all?.body ?? []).filter((id) =>
    asked.has(nodes[id]?.kind ?? ""),
  );
  const id = "x".repeat(MAX_ID);
  const answer = (n: TreeNode | undefined): Pick =>
    n?.kind !== "multi_choice"
      ? id
      : Array(
          n.options
            ? Object.keys(n.options).length
            : n.options_from === "role_library.work_kinds"
              ? tree.role_library.work_kinds.length
              : maxRoles,
        ).fill(id);
  // One entry's share of the object's JSON: `"key":{...},`.
  const entry = (key: string, node: string) =>
    JSON.stringify({
      [key]: {
        answer: answer(nodes[node]),
        source: "default",
        confidence: LONGEST_CONFIDENCE,
      },
    }).length - 1;
  const lastRound = `~${rounds + 1}`;
  let entries = 0;
  let chars = 2;
  const add = (times: number, key: string, node: string) => {
    entries += times;
    chars += times * entry(key, node);
  };
  for (const [nid, n] of Object.entries(nodes))
    if (asked.has(n.kind) && !perRole.includes(nid)) add(1, nid, nid);
  for (const nid of perRole) add(maxRoles, `${nid}#${id}`, nid);
  for (const nid of flowBody)
    add(maxRoles * rounds, `${nid}#${id}${lastRound}`, nid);
  add(rounds, `q_flow${lastRound}`, "q_flow");
  return { entries, chars };
}

const answersOf = (r: JevRead | null | undefined) => (r?.ok ? r.answers : null);
/** A Jev number as a probability: outside 0..1 (or not a number) it is clamped, never stored raw. */
const unit = (x: number) => (Number.isNaN(x) ? 0 : Math.min(1, Math.max(0, x)));
const confOf = (a: JevAnswer | undefined) =>
  unit(
    a?.confidence ?? (a?.choice ? (own(a.probabilities, a.choice) ?? 0) : 0),
  );
const probOf = (a: JevAnswer | undefined) =>
  unit(a?.choice ? (own(a.probabilities, a.choice) ?? a.confidence ?? 0) : 0);
/** Jev is sure of `q`: confidence >= 0.8 and a real answer. */
const sure = (a: JevAnswer | undefined, t = SKIP_THRESHOLD) =>
  !!a?.choice && !NOT_ANSWERS.has(a.choice) && confOf(a) >= t;

export type ChoiceDecision = {
  skip: boolean;
  /** The skipped answer (when skip) or the Recommended one (when shown). */
  value: string;
  source: Source;
  confidence?: number;
};

/**
 * The skip rule for one choice question. `options` are the node's valid answers; `twin` is the
 * reversed-order answer for path-deciding nodes. `neverSkip` still uses Jev for Recommended.
 */
export function decideChoice(
  a: JevAnswer | undefined,
  options: readonly string[],
  fallback: string,
  o: {
    twin?: JevAnswer | undefined;
    orderCheck?: boolean;
    neverSkip?: boolean;
    /** The tree's jev.threshold. */
    threshold?: number;
  } = {},
): ChoiceDecision {
  const valid = !!a?.choice && options.includes(a.choice);
  const twinOk = !o.orderCheck || o.twin?.choice === a?.choice;
  if (valid && !o.neverSkip && twinOk && sure(a, o.threshold))
    return {
      skip: true,
      value: a?.choice as string,
      source: "jev",
      confidence: confOf(a),
    };
  if (valid && probOf(a) >= RECOMMEND_MIN)
    return {
      skip: false,
      value: a?.choice as string,
      source: "jev",
      confidence: confOf(a),
    };
  return { skip: false, value: fallback, source: "default" };
}

const same = (a: Pick, b: Pick) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((x) => b.includes(x))
    : a === b;
/** Changes from Recommended: one per item added or removed, or one for a different single pick. */
function changes(rec: Pick, pick: Pick): number {
  if (Array.isArray(rec) && Array.isArray(pick))
    return (
      pick.filter((x) => !rec.includes(x)).length +
      rec.filter((x) => !pick.includes(x)).length
    );
  return same(rec, pick) ? 0 : 1;
}

/** A role id from words people type: lower case, a-z 0-9 and _, at most 40 chars. */
export function roleSlug(text: string): string {
  return slugBase(text) || "role";
}

/** Latin letters lose their accents (Café -> cafe); anything else drops out. May be empty. */
const slugBase = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

/** Ids that mean something other than a role (choices, checkers). No role may have one. */
export const RESERVED_ROLE_IDS = [
  "watching",
  "new",
  "new_role",
  "none",
  "nobody",
  "owner",
  // JS object names: never a key a lookup could confuse with Object.prototype.
  "__proto__",
  "constructor",
  "prototype",
] as const;

/**
 * The one id function for a role made from words people type (walker, role match). Unique among
 * `taken`, never a reserved id, never a library id (a custom "QA" is not the library QA).
 * Words with no Latin letters become role_1, role_2, ...
 */
export function newRoleId(
  tree: GuideTree,
  name: string,
  taken: Iterable<string>,
): string {
  const used = new Set<string>([
    ...taken,
    ...RESERVED_ROLE_IDS,
    ...Object.keys(tree.role_library.roles),
  ]);
  // Ids start with a letter: "1" becomes role_1, so no id is ever an integer-like object key.
  const slug = slugBase(name);
  const base =
    slug && !/^[a-z]/.test(slug) ? `role_${slug}`.slice(0, 40) : slug;
  if (base && !used.has(base)) return base;
  const stem = base ? base.slice(0, 36) : "role";
  for (let i = base ? 2 : 1; ; i++)
    if (!used.has(`${stem}_${i}`)) return `${stem}_${i}`;
}

/**
 * The flow's role order: from the first role nobody hands to (else the first role), along each
 * role's first hand-off; a cycle stops at the first repeat, which is listed once more at the end.
 */
export function flowOrder(
  roles: readonly CharterRole[],
  first?: string,
): string[] {
  if (roles.length === 0) return [];
  const byId = new Map(roles.map((r) => [r.id, r]));
  const handed = new Set(roles.flatMap((r) => r.hands_to));
  // `first`: the role the person put on top of the order (a cycle has no role nobody hands to).
  // With no role nobody hands to (a cycle) the work starts where the library flow does, never at
  // whichever role was ticked first: PM, designer, developer, reviewer, other roles, then QA.
  const rank = (r: CharterRole) => {
    const k = FLOW_START.indexOf(r.id);
    return k < 0
      ? r.id === "qa"
        ? FLOW_START.length + 1
        : FLOW_START.length
      : k;
  };
  const fallback = [...roles].sort((a, b) => rank(a) - rank(b))[0];
  const start =
    (first ? byId.get(first) : undefined) ??
    roles.find((r) => !handed.has(r.id)) ??
    fallback;
  const seq: string[] = [];
  let cur: string | undefined = start?.id;
  while (cur && byId.has(cur)) {
    if (seq.includes(cur)) {
      seq.push(cur);
      break;
    }
    seq.push(cur);
    cur = byId.get(cur)?.hands_to[0];
  }
  return seq;
}

/** Every hand-off edge, in role order. This is what routing reads. */
export function flowEdges(
  roles: readonly CharterRole[],
): { from: string; to: string }[] {
  return roles.flatMap((r) => r.hands_to.map((to) => ({ from: r.id, to })));
}

/** Options with their descriptions, in the order Jev sees them. A list, never object key order. */
export type CriteriaList = [string, string][];

/**
 * The criteria object Jev receives, built from an ordered list. A JS object puts integer-like keys
 * ("1", "2") first whatever the insertion order, which would silently break the reversed-order
 * twin; this refuses any list whose order the object would not keep.
 */
function criteriaObject(list: CriteriaList): Criteria {
  const o: Criteria = Object.create(null);
  for (const [k, v] of list) o[k] = v;
  const keys = Object.keys(o);
  if (keys.length !== list.length || keys.some((k, i) => k !== list[i]?.[0]))
    throw new Error(
      `criteria order would change: ${list.map(([k]) => k).join(",")}`,
    );
  return o;
}

/**
 * The Jev questions of one `jev_batch` node; `dynamic` fills `criteria_from` questions as ordered
 * lists. A `<q>_rev` twin gets the same options reversed (or the tree's `criteria_order`, then any
 * option it leaves out, reversed).
 */
export function jevQuestions(
  node: TreeNode,
  dynamic: Record<string, CriteriaList> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const qs = node.questions ?? {};
  const listOf = (id: string, q: JevQuestionDef): CriteriaList | undefined => {
    const base = own(dynamic, id) ?? (q.criteria && Object.entries(q.criteria));
    if (!base) return undefined;
    const merged = new Map(base);
    for (const [k, v] of Object.entries(q.extra ?? {})) merged.set(k, v);
    return [...merged];
  };
  for (const [id, q] of Object.entries(qs)) {
    if (q.order_check_of) {
      const base = qs[q.order_check_of];
      const list = base && listOf(q.order_check_of, base);
      if (!base || !list) continue;
      const order = q.criteria_order ?? [];
      const twin: CriteriaList = [
        ...order.flatMap((k) => list.filter(([x]) => x === k)),
        ...list.filter(([k]) => !order.includes(k)).reverse(),
      ];
      out[id] = {
        type: "choice",
        instructions: base.instructions,
        criteria: criteriaObject(twin),
      };
      continue;
    }
    if (q.type === "score") {
      // shortcut: levels go as score criteria (the shape .claude/skills/human-use/jev.mjs sends).
      out[id] = {
        type: "score",
        instructions: q.instructions,
        criteria: q.levels,
      };
      continue;
    }
    const list = listOf(id, q);
    if (!list) continue;
    out[id] = {
      type: "choice",
      instructions: q.instructions ?? "Answer from the text.",
      criteria: criteriaObject(list),
    };
  }
  return out;
}

/**
 * The `match_role_text` batch for one role typed in the person's own words: the library roles and
 * the roles already added, plus the tree's extra choice `new`; `owns` over the work kinds.
 */
export function roleMatchQuestions(
  tree: GuideTree,
  added: readonly { id: string; name: string; owns: string[] }[],
): Record<string, unknown> {
  const node = tree.trees.setup?.nodes.match_role_text;
  if (!node) return {};
  const role: CriteriaList = Object.entries(tree.role_library.roles).map(
    ([id, r]) => [id, `${r.label}: ${r.criteria}`],
  );
  for (const r of added)
    if (!role.some(([id]) => id === r.id))
      role.push([r.id, `${r.name}: owns ${r.owns.join(", ")}.`]);
  const owns: CriteriaList = tree.role_library.work_kinds.map((k) => [
    k,
    k.replace("_", " "),
  ]);
  return jevQuestions(node, { role, owns });
}

/** Normalise a Jev reply (`{answers: {...}}`) into answers by question id. Null when unusable. */
export function parseJevReply(json: unknown): Record<string, JevAnswer> | null {
  const root = json as { answers?: unknown } | null;
  const a = (root?.answers ?? null) as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return null;
  const out: Record<string, JevAnswer> = Object.create(null);
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  for (const [id, raw] of Object.entries(a)) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== "object") continue;
    const ans: JevAnswer = {};
    if (typeof r.choice === "string") ans.choice = r.choice;
    const c = num(r.confidence);
    if (c !== undefined) ans.confidence = c;
    const s = num(r.score);
    if (s !== undefined) ans.score = s;
    if (r.probabilities && typeof r.probabilities === "object") {
      const p: Record<string, number> = Object.create(null);
      for (const [k, v] of Object.entries(r.probabilities))
        if (num(v) !== undefined) p[k] = v as number;
      ans.probabilities = p;
    }
    out[id] = ans;
  }
  return out;
}

/** Nodes of the setup tree that Jev's read lets the walk skip (for the relay's reply). */
export function setupSkips(tree: GuideTree, read: JevRead | null): string[] {
  const nodes = tree.trees.setup?.nodes ?? {};
  const a = answersOf(read);
  if (!a) return [];
  const never = new Set(tree.skip_rule.never_skip);
  const t = tree.jev.threshold;
  const out: string[] = [];
  for (const [id, n] of Object.entries(nodes)) {
    if (id === "q_roles" && rolesDecision(a, n, t, askedRoles(tree)).skip)
      out.push(id);
    else if (id === "q_tools" && toolsDecision(a, n, t).skip) out.push(id);
    else if (
      n.kind === "choice" &&
      typeof n.from_jev === "string" &&
      !never.has(id) &&
      decideChoice(
        a[n.from_jev],
        Object.keys(n.options ?? {}),
        String(n.default_recommended),
        {
          twin: n.order_check ? a[n.order_check] : undefined,
          orderCheck: !!n.order_check,
          threshold: t,
        },
      ).skip
    )
      out.push(id);
  }
  return out;
}

type Multi = { skip: boolean; value: string[]; source: Source };

function rolesDecision(
  a: Record<string, JevAnswer> | null,
  n: TreeNode,
  t: number,
  asked: readonly string[],
): Multi {
  const dflt = (n.default_recommended as string[]) ?? [];
  if (!a) return { skip: false, value: dflt, source: "default" };
  const pre = asked.filter((r) => {
    const x = a[`role_${r}`];
    return x?.choice === "yes" && confOf(x) >= t;
  });
  const other = a.role_other_named;
  const noOther =
    (other?.choice === "no" || other?.choice === "na") && confOf(other) >= t;
  if (pre.length >= 2 && noOther)
    return { skip: true, value: [...pre], source: "jev" };
  return pre.length
    ? { skip: false, value: [...pre], source: "jev" }
    : { skip: false, value: dflt, source: "default" };
}

function toolsDecision(
  a: Record<string, JevAnswer> | null,
  n: TreeNode,
  t: number,
): Multi {
  const dflt = (n.default_recommended as string[]) ?? [];
  if (!a) return { skip: false, value: dflt, source: "default" };
  // q_tools.from_jev names the tool_<option> questions.
  const fromJev = Array.isArray(n.from_jev) ? n.from_jev : [];
  const at = (min: number, sureOnly: boolean) =>
    fromJev
      .filter((q) => {
        const x = a[q];
        return x?.choice === "yes" && (sureOnly ? confOf(x) : probOf(x)) >= min;
      })
      .map((q) => q.replace(/^tool_/, ""));
  const sureTools = at(t, true);
  if (sureTools.length) return { skip: true, value: sureTools, source: "jev" };
  const likely = at(RECOMMEND_MIN, false);
  return likely.length
    ? { skip: false, value: likely, source: "jev" }
    : { skip: false, value: dflt, source: "default" };
}

/** Top level of a score answer (probabilities by level label, else the score as a level index). */
function scoreLevel(a: JevAnswer | undefined, levels: string[]): number {
  if (!a) return -1;
  if (a.probabilities) {
    let best = -1;
    let bestP = -1;
    levels.forEach((l, i) => {
      const p = a.probabilities?.[l] ?? -1;
      if (p > bestP) {
        best = i;
        bestP = p;
      }
    });
    if (bestP >= 0) return best;
  }
  return a.score === undefined ? -1 : Math.round(a.score);
}

/** Walk the setup tree as far as the input allows. */
export function walkSetup(tree: GuideTree, input: SetupInput): Walk {
  const setup = tree.trees.setup;
  if (!setup) throw new Error("tree has no setup");
  const nodes = setup.nodes;
  const lib = tree.role_library.roles;
  const never = new Set(tree.skip_rule.never_skip);
  const threshold = tree.jev.threshold;
  const maxRoles = roleCap(tree);
  const a = answersOf(input.read);
  const steps: Step[] = [];
  const roles = new Map<string, CharterRole>();
  /** Hand-offs and checkers the person set themselves: derivation never changes them. */
  const explicitHands = new Map<string, string[]>();
  const explicitChecked = new Map<string, string>();
  const got: Record<string, Pick> = Object.create(null);
  /** Each own-words role's text -> the id it became (or the role it matched). */
  const typedIds = new Map<string, string>();
  /** Every per-role key handed out, matched roles included, so no two roles share one. */
  const allocated = new Set<string>();
  let pending: Step | null = null;
  /** Roles asked for past the cap: the walk lists them so the person is told, never dropped silently. */
  const overCap: string[] = [];
  const full = (name: string) => {
    if (roles.size < maxRoles) return false;
    if (!overCap.includes(name)) overCap.push(name);
    return true;
  };

  /** Every role-adding path goes through here or roleLoop, both behind `full`. */
  const kept = new Map((input.keep ?? []).map((k) => [k.id, k]));
  const addLibrary = (id: string) => {
    const r = own(lib, id);
    if (!r || roles.has(id) || full(r.label)) return;
    const k = kept.get(id);
    if (k?.library_id === id) {
      roles.set(id, { ...k, owns: [...k.owns], hands_to: [...k.hands_to] });
      // Saved values hold until an answer on this walk changes them.
      explicitHands.set(id, [...k.hands_to]);
      explicitChecked.set(id, k.checked_by);
      return;
    }
    roles.set(id, {
      id,
      name: r.label,
      owns: [...r.owns],
      hands_to: [...r.hands_to],
      checked_by: r.checked_by,
      library_id: id,
    });
  };

  /** Record one step; returns the answer, or undefined when it waits for the person. */
  const ask = (
    key: string,
    nodeId: string,
    d: { skip: boolean; value: Pick; source: Source; confidence?: number },
    /** The step's options as they stand now; unset where text goes (q_roles: see `typed`). */
    options?: readonly string[],
    /** q_roles: an item that is not a library id is a typed role name, accepted by acceptName. */
    typed = false,
  ): Pick | undefined => {
    const n = nodes[nodeId];
    const raw = own(input.picks, key);
    // A pick counts only if it still fits the step: the right shape (a list for a multi choice),
    // at least one item, and every item one of the options as they stand after earlier answers
    // changed, or (typed) a name acceptName takes. Anything refused leaves the step waiting again,
    // with the reason and the refused items; nothing is dropped quietly.
    let refused: Step["reask"];
    const rejected: string[] = [];
    let pick: Pick | undefined;
    if (raw !== undefined) {
      const items = Array.isArray(raw) ? raw : [raw];
      const out: string[] = [];
      for (const x of items) {
        if (typeof x === "string" && options?.includes(x)) out.push(x);
        else if (typed && typeof x === "string" && own(lib, x)) out.push(x);
        else if (typed) {
          const acc = acceptName(x);
          if (acc.ok) out.push(acc.value);
          else {
            refused ??= acc.why;
            rejected.push(String(x));
          }
        } else if (options) {
          refused ??= "not_an_option";
          rejected.push(String(x));
        } else out.push(x);
      }
      if (Array.isArray(raw) !== (n?.kind === "multi_choice"))
        refused ??= "not_an_option";
      else if (!out.length) refused ??= "empty";
      // A multi choice lists each option once, however often it was sent.
      if (!refused) pick = Array.isArray(raw) ? [...new Set(out)] : out[0];
    }
    const step: Step = {
      key,
      node: nodeId,
      kind: n?.kind ?? "choice",
      shown: !d.skip,
      recommended: d.value,
      source: d.source,
      taps: 0,
      ...(d.confidence === undefined ? {} : { confidence: d.confidence }),
    };
    if (pick !== undefined) {
      step.answer = pick;
      step.taps = d.skip ? changes(d.value, pick) : 1 + changes(d.value, pick);
      if (!same(pick, d.value)) step.source = "person";
    } else if (d.skip) {
      step.answer = d.value;
    } else {
      if (refused) step.reask = refused;
      if (rejected.length) step.rejected = rejected;
      steps.push(step);
      pending = step;
      return undefined;
    }
    steps.push(step);
    got[key] = step.answer as Pick;
    return step.answer;
  };

  const choiceNode = (id: string) => {
    const n = nodes[id] as TreeNode;
    const fromJev = typeof n.from_jev === "string" ? n.from_jev : undefined;
    let dflt = String(n.default_recommended);
    if (a && n.recommended_if) {
      const levels = nodes.read_open?.questions?.people?.levels ?? [];
      for (const r of n.recommended_if) {
        const m = /^people >= (.+)$/.exec(r.when);
        const min = m ? levels.indexOf(m[1] as string) : -1;
        if (min >= 0 && scoreLevel(a.people, levels) >= min) dflt = r.pick;
      }
    }
    const opts = Object.keys(n.options ?? {});
    if (!a || !fromJev)
      return ask(id, id, { skip: false, value: dflt, source: "default" }, opts);
    return ask(
      id,
      id,
      decideChoice(a[fromJev], opts, dflt, {
        twin: n.order_check ? a[n.order_check] : undefined,
        orderCheck: !!n.order_check,
        neverSkip: never.has(id) || n.skip_if === "never",
        threshold,
      }),
      opts,
    );
  };

  /** The own-words role loop (S61): match, else owns, hands to, checked by. */
  const roleLoop = (typed: string[]): boolean => {
    let handled = 0;
    // `typed` holds accepted names only (acceptName ran when they were answered): no cut here.
    for (const text of typed) {
      const same = sameWords(text);
      // The same words typed twice are one role (merged, and mapped to it in the answers).
      if (typedIds.has(same)) continue;
      // Past the cap the role is not added (listed in over_cap): the card shows what is saved.
      // At most roleCap(tree) typed roles are asked about, matched or new.
      if (full(text)) continue;
      if (handled >= maxRoles) {
        if (!overCap.includes(text)) overCap.push(text);
        continue;
      }
      handled++;
      const k = input.keep?.find(
        (x) =>
          x.library_id !== x.id &&
          sameWords(x.name) === same &&
          !roles.has(x.id) &&
          !allocated.has(x.id),
      );
      const slug =
        k?.id ?? newRoleId(tree, text, [...roles.keys(), ...allocated]);
      allocated.add(slug);
      const ra = answersOf(own(input.roleReads, slug));
      const options = [...Object.keys(lib), ...roles.keys(), "new"];
      const matchDefault = String(
        nodes.q_role_match?.default_recommended ?? "new",
      );
      const m = ask(
        `q_role_match#${slug}`,
        "q_role_match",
        ra
          ? decideChoice(ra.role, options, matchDefault, {
              twin: ra.role_rev,
              orderCheck: true,
              threshold,
            })
          : { skip: false, value: matchDefault, source: "default" },
        options,
      );
      if (m === undefined) return false;
      if (m !== "new") {
        if (own(lib, m as string)) {
          const had = roles.has(m as string);
          addLibrary(m as string);
          // Hawl matched it on its own (the person was not asked): the role keeps her words.
          const added = roles.get(m as string);
          if (
            !had &&
            added &&
            added.name === own(lib, m as string)?.label &&
            !steps.at(-1)?.shown
          )
            added.name = text;
        }
        typedIds.set(same, m as string);
        continue;
      }
      const ownsDefault = (nodes.q_owns?.default_recommended as
        | string[]
        | undefined) ?? ["other"];
      const ownsJev =
        ra &&
        decideChoice(ra.owns, tree.role_library.work_kinds, "", {
          neverSkip: true,
        });
      const owns = ask(
        `q_owns#${slug}`,
        "q_owns",
        ownsJev?.value
          ? { ...ownsJev, value: [ownsJev.value] }
          : { skip: false, value: ownsDefault, source: "default" },
        tree.role_library.work_kinds,
      );
      if (owns === undefined) return false;
      const others = [...roles.keys()].filter((r) => r !== slug);
      const hand =
        HANDS_TO_ORDER.find((r) => others.includes(r)) ?? others[0] ?? "nobody";
      const handsTo = ask(
        `q_hands_to#${slug}`,
        "q_hands_to",
        { skip: false, value: hand, source: "default" },
        [...others, "nobody"],
      );
      if (handsTo === undefined) return false;
      const checked = ask(
        `q_checked_by#${slug}`,
        "q_checked_by",
        {
          skip: false,
          value: handsTo === "nobody" ? "nobody" : (handsTo as string),
          source: "default",
        },
        [...others, "owner", "nobody"],
      );
      if (checked === undefined) return false;
      roles.set(slug, {
        id: slug,
        name: text,
        owns: [...(owns as string[])],
        hands_to: handsTo === "nobody" ? [] : [handsTo as string],
        checked_by: checked as string,
      });
      typedIds.set(same, slug);
      // The person answered both: derivation leaves them as they are.
      explicitHands.set(slug, handsTo === "nobody" ? [] : [handsTo as string]);
      explicitChecked.set(slug, checked as string);
    }
    return true;
  };

  /** The roles as they will be saved. The only derivation: the card, q_flow and the save use it. */
  const derive = (): CharterRole[] => {
    const ids = new Set(roles.keys());
    // A library default can point at a role this charter lacks (developer -> qa in "one builds,
    // one reviews"). Follow the library chain to the next present role; else a present role
    // that reviews or tests checks it, and work goes to that checker.
    const chain = (
      start: string,
      self: string,
      field: "hands_to" | "checked_by",
    ) => {
      const seen = new Set<string>();
      for (let cur: string | undefined = start; cur && !seen.has(cur); ) {
        if (cur === self) return undefined;
        if (ids.has(cur)) return cur;
        seen.add(cur);
        const l: LibraryRole | undefined = own(lib, cur);
        cur = field === "hands_to" ? l?.hands_to[0] : l?.checked_by;
      }
      return undefined;
    };
    const reviewerFor = (self: string) =>
      [...roles.values()].find(
        (x) => x.id !== self && x.owns.includes("review"),
      )?.id ??
      [...roles.values()].find((x) => x.id !== self && x.owns.includes("tests"))
        ?.id;
    const signer = [...roles.values()].find((x) =>
      x.owns.includes("sign_off"),
    )?.id;
    const list = [...roles.values()].map((r) => {
      const keepHands = explicitHands.get(r.id);
      const keepChecked = explicitChecked.get(r.id);
      let checked =
        ids.has(r.checked_by) ||
        r.checked_by === "owner" ||
        r.checked_by === "nobody"
          ? r.checked_by
          : (chain(r.checked_by, r.id, "checked_by") ??
            reviewerFor(r.id) ??
            "nobody");
      // q_checker (client or contractor sites): apply the person's answer to who checks.
      if (got.q_checker === "self" && checked !== "nobody") checked = "owner";
      if (got.q_checker === "pm_signs_off" && signer && r.id !== signer)
        checked = signer;
      if (
        keepChecked !== undefined &&
        keepChecked !== r.id &&
        (ids.has(keepChecked) ||
          keepChecked === "owner" ||
          keepChecked === "nobody")
      )
        checked = keepChecked;
      const hands = (keepHands ?? r.hands_to)
        .map((h) =>
          h !== r.id && ids.has(h)
            ? h
            : (chain(h, r.id, "hands_to") ??
              (ids.has(checked) ? checked : undefined)),
        )
        .filter((h): h is string => !!h && h !== r.id);
      // A client with no contractor on the site is the one who asks for work: it starts the chain
      // by handing to the PM (else the first other role), unless the person chose a hand-off.
      if (
        r.id === "client" &&
        !hands.length &&
        keepHands === undefined &&
        !got.q_external
      ) {
        const to = ids.has("pm") ? "pm" : [...ids].find((x) => x !== r.id);
        if (to) hands.push(to);
      }
      return { ...r, hands_to: [...new Set(hands)], checked_by: checked };
    });
    // Mixed site with an outside client: the end of the team's flow delivers to the client, who
    // signs it off. The end is the PM, else the final checker, else the role that hands to no one.
    const ext = got.q_external;
    if ((ext === "client" || ext === "both") && ids.has("client")) {
      const team = list.filter(
        (r) => r.id !== "client" && r.id !== "contractor",
      );
      const end =
        team.find((r) => r.id === "pm") ??
        team.find(
          (r) =>
            (r.checked_by === "nobody" || r.checked_by === "owner") &&
            team.some((x) => x.checked_by === r.id),
        ) ??
        team.find((r) => r.hands_to.length === 0);
      if (end) {
        if (!explicitHands.has(end.id))
          end.hands_to = [...new Set([...end.hands_to, "client"])];
        if (!explicitChecked.has(end.id)) end.checked_by = "client";
      }
    }
    // Nothing on the card names a role it lacks, whatever earlier (or edited) answers said.
    for (const r of list) {
      r.hands_to = r.hands_to.filter((h) => h !== r.id && ids.has(h));
      if (
        !(ids.has(r.checked_by) || ["owner", "nobody"].includes(r.checked_by))
      )
        r.checked_by = "nobody";
    }
    return list;
  };

  const draft = (): CharterDraft => {
    const list = derive();
    // Appended after derivation, so the path's own roles derive exactly as they did when saved.
    if (!steps.some((s) => s.node === "q_roles" || s.node === "role_text")) {
      for (const k of input.keep ?? [])
        if (!k.library_id && !list.some((r) => r.id === k.id)) {
          if (list.length >= maxRoles) {
            if (!overCap.includes(k.name)) overCap.push(k.name);
          } else
            list.push({ ...k, owns: [...k.owns], hands_to: [...k.hands_to] });
        }
      const ids = new Set(list.map((r) => r.id));
      for (const r of list) {
        r.hands_to = r.hands_to.filter((h) => ids.has(h));
        if (
          !(ids.has(r.checked_by) || ["owner", "nobody"].includes(r.checked_by))
        )
          r.checked_by = "nobody";
      }
    }
    // The person's chosen first role (q_flow_first, set by a reorder) goes on top, so a saved
    // cycle still starts where they put it.
    const top = list.findIndex(
      (r) => r.id === own(input.picks, "q_flow_first"),
    );
    if (top > 0) list.unshift(...list.splice(top, 1));
    const tree_answers: CharterDraft["tree_answers"] = {};
    for (const s of steps)
      if (s.kind !== "text" && s.answer !== undefined)
        tree_answers[s.key] = {
          // Own-words roles in q_roles become their role ids: typed text stays in roles[].name only.
          answer:
            s.node === "q_roles" && Array.isArray(s.answer)
              ? [
                  ...new Set(
                    s.answer
                      .map((r) =>
                        own(lib, r) ? r : typedIds.get(sameWords(r)),
                      )
                      .filter((r): r is string => !!r),
                  ),
                ]
              : s.answer,
          source: s.source,
          ...(s.confidence === undefined ? {} : { confidence: s.confidence }),
        };
    const shape = got.q_shape as string;
    return {
      purpose,
      roles: list,
      flows: flowEdges(list),
      classifier_mode: (got.q_auto as string) ?? "route",
      agreements_consent: (got.q_agree_yes as string) ?? "yes",
      tree_answers,
      end: own(nodes.end_by_shape?.map, shape) ?? "E_solo",
    };
  };

  const result = (done: boolean): Walk => {
    const card = roles.size ? draft() : null;
    return {
      steps,
      pending,
      taps: steps.reduce((t, s) => t + s.taps, 0),
      questions: steps.filter((s) => s.shown).length,
      flow: card
        ? flowOrder(card.roles, String(own(input.picks, "q_flow_first") ?? ""))
        : [],
      card,
      charter: done ? card : null,
      over_cap: [...overCap],
    };
  };

  // The purpose: the opening text (or the card's edit of it, key "purpose"), through the one purpose
  // gate. A retyped text arrives as a pick under the same key. Words that do not survive the cut:
  // that text is asked again, never cut to nothing. Nothing typed: no purpose (the open is optional).
  const purposeKey =
    input.purpose !== undefined || own(input.picks, "purpose") !== undefined
      ? "purpose"
      : "open";
  const purposeRaw =
    own(input.picks, purposeKey) ??
    (purposeKey === "purpose" ? input.purpose : input.open);
  const purposeAcc = acceptPurpose(purposeRaw);
  const purpose = purposeAcc.ok ? purposeAcc.value : "";
  if (!purposeAcc.ok && purposeAcc.why === "too_long") {
    pending = {
      key: purposeKey,
      node: "open",
      kind: "text",
      shown: true,
      recommended: "",
      source: "default",
      taps: 0,
      reask: "too_long",
      rejected: [String(purposeRaw)],
    };
    steps.push(pending);
    return result(false);
  }

  let id: string | undefined = setup.start;
  let flowRound = 1;
  let roleLimitShown = false;
  // Safety stop on node visits: every node once per order-change round, plus one.
  const visits = Object.keys(nodes).length * (flowRounds(tree) + 2);
  for (let guard = 0; id && guard < visits; guard++) {
    const n: TreeNode | undefined = own(nodes, id);
    if (!n) break;
    // A loop limit reached: its notice shows instead (never a quietly swapped answer).
    if (id === "q_flow" && n.at_limit && flowRound > flowRounds(tree)) {
      id = n.at_limit;
      continue;
    }
    const roleLimit = nodes.role_text_loop?.at_limit;
    if (id === "confirm" && roleLimit && overCap.length && !roleLimitShown) {
      roleLimitShown = true;
      id = roleLimit;
      continue;
    }
    const shape = got.q_shape as string | undefined;
    if (n.kind === "text" || n.kind === "jev_batch") {
      id = n.next;
      continue;
    }
    if (id === "role_text_loop") {
      const typed =
        (got.q_roles as string[] | undefined)?.filter((r) => !own(lib, r)) ??
        [];
      if (got.q_solo_split === "own_words") {
        const raw = own(input.picks, "role_text");
        const items = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
        const acc = items.map((x) => acceptName(x));
        const bad = acc.flatMap((x, i) => (x.ok ? [] : [[x.why, items[i]]]));
        if (!items.length || bad.length) {
          pending = {
            key: "role_text",
            node: "role_text",
            kind: "text",
            shown: true,
            recommended: [],
            source: "default",
            taps: 0,
            ...(raw === undefined
              ? {}
              : {
                  reask: (bad[0]?.[0] ?? "empty") as Step["reask"],
                  rejected: bad.map(([, x]) => String(x)),
                }),
          };
          steps.push(pending);
          return result(false);
        }
        typed.push(...acc.flatMap((x) => (x.ok ? [x.value] : [])));
      }
      if (!roleLoop(typed)) return result(false);
      id = own(n.next_by_shape, shape ?? "") ?? "q_tools";
      continue;
    }
    if (id === "q_hands_to_all") {
      const all = derive();
      for (const r of all) {
        const rec = r.hands_to[0] ?? "nobody";
        const v = ask(
          `q_hands_to#${r.id}~${flowRound}`,
          "q_hands_to",
          { skip: false, value: rec, source: "default" },
          [...all.map((x) => x.id).filter((x) => x !== r.id), "nobody"],
        );
        if (v === undefined) return result(false);
        if (v !== rec)
          explicitHands.set(r.id, v === "nobody" ? [] : [v as string]);
      }
      flowRound++;
      id = "q_flow";
      continue;
    }
    if (n.kind === "branch") break;

    let ans: Pick | undefined;
    if (id === "q_roles") {
      // Roles the relay ticked from named people (role_client for "Mara asks for work") count too.
      const asked = askedRoles(tree);
      for (const k of Object.keys(a ?? {}))
        if (
          k.startsWith("role_") &&
          own(lib, k.slice(5)) &&
          !asked.includes(k.slice(5))
        )
          asked.push(k.slice(5));
      const d = rolesDecision(a, n, threshold, asked);
      ans = ask(id, id, d, undefined, true);
      if (ans !== undefined) for (const r of ans as string[]) addLibrary(r);
    } else if (id === "q_tools") {
      ans = ask(
        id,
        id,
        toolsDecision(a, n, threshold),
        Object.keys(n.options ?? {}),
      );
    } else if (id === "q_flow" || id === "confirm") {
      const key = id === "q_flow" && flowRound > 1 ? `q_flow~${flowRound}` : id;
      ans = ask(
        key,
        id,
        {
          skip: false,
          value: String(n.default_recommended),
          source: "default",
        },
        Object.keys(n.options ?? {}),
      );
    } else {
      ans = choiceNode(id);
    }
    if (ans === undefined) return result(false);

    const one = Array.isArray(ans) ? ans[0] : ans;
    const made = own(n.makes_roles, one as string);
    if (Array.isArray(made)) for (const r of made) addLibrary(r);
    for (const r of own(n.adds_roles, one as string) ?? []) addLibrary(r);

    if (id === "q_solo_split" && one === "own_words") id = "role_text_loop";
    else if (id === "confirm") id = undefined;
    else id = own(n.branch, one as string) ?? own(n.branch, "*") ?? n.next;
  }
  return result(!pending);
}
