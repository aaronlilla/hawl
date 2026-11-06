import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "../test-tmp.ts";
import { join as pjoin } from "node:path";
import test from "node:test";
import { MemoryKeyStore } from "../daemon/keys.ts";
import { type JoinOpts, join } from "./join.ts";

const json = (o: unknown, status: number) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json" },
  });

const fakeRelay = (async (input: unknown) =>
  String(input).endsWith("/v1/join/start")
    ? json(
        {
          join_id: "jrq_1",
          user_code: "ABCD-EFGH",
          key_fingerprint: "7F3A-91C2",
          expires_in: 600,
        },
        201,
      )
    : json(
        {
          resident_id: "res_NEW",
          kid: "k1",
          town_id: "t1",
          relay_url: "https://relay.test",
          needs_owner_approval: false,
        },
        200,
      )) as typeof fetch;

type Call = { method: string; params: Record<string, unknown> };

/** A join into a temp home; the daemon stub records every call. `failTool` makes profile_set throw. */
function setup(
  answers: string[] = [],
  extra: Record<string, unknown> = {},
  failTool = false,
  /** What `who` reports for the new agent: its saved tags, or "fail" when the read throws. */
  existing: string[] | "fail" = [],
) {
  const root = mkdtempSync(pjoin(tmpdir(), "hawl-joinspec-"));
  const projectDir = pjoin(root, "payments-api");
  mkdirSync(projectDir, { recursive: true });
  const lines: string[] = [];
  const calls: Call[] = [];
  const asked: string[] = [];
  const deps = {
    home: root,
    stateDir: pjoin(root, "state"),
    keyStore: new MemoryKeyStore(),
    fetch: fakeRelay,
    print: (l: string) => lines.push(l),
    sleep: async () => {},
    ensureDaemon: async () => {},
    daemon: () => ({
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "tool" && params.name === "who") {
          if (existing === "fail") throw new Error("not approved yet");
          return {
            workers: [
              { resident_id: "res_OTHER", specialties: ["unrelated"] },
              { resident_id: "res_NEW", specialties: existing },
            ],
          };
        }
        if (method === "tool" && failTool) throw new Error("not approved yet");
        return { envelopes: [{ relay: { origin: "system" } }] };
      },
    }),
    skillsStore: { has: () => false, env: {} },
    isTTY: true,
    ask: async (q: string) => {
      if (!q.startsWith("What is this agent good at?")) return "y"; // the join's own questions
      asked.push(q);
      return answers.shift() ?? "";
    },
    ...extra,
  };
  const opts = (more: Partial<JoinOpts> = {}): JoinOpts => ({
    site: "acme",
    hosts: ["claude_code"],
    projectDir,
    skills: "none",
    ...more,
  });
  const saved = () =>
    calls.filter((c) => c.method === "tool" && c.params.name === "profile_set");
  return { deps, opts, lines, asked, saved };
}

test("at a keyboard join asks what the agent is good at and saves the tags with profile_set", async () => {
  const t = setup(["frontend, react , tests"]);
  await join(t.opts(), t.deps);
  assert.equal(t.asked.length, 1);
  assert.match(t.asked[0] as string, /What is this agent good at\?/);
  assert.equal(t.saved().length, 1);
  assert.deepEqual(t.saved()[0]?.params, {
    resident_id: "res_NEW",
    name: "profile_set",
    args: { specialties: ["frontend", "react", "tests"] },
  });
});

test("Enter takes the folder-name suggestion; 'skip' saves nothing", async () => {
  const a = setup([""]);
  await join(a.opts(), a.deps);
  assert.match(a.asked[0] as string, /payments, api/);
  assert.deepEqual(a.saved()[0]?.params.args, {
    specialties: ["payments", "api"],
  });

  const b = setup(["skip"]);
  await join(b.opts(), b.deps);
  assert.equal(b.saved().length, 0);
});

test("no question without a keyboard or with --yes", async () => {
  const a = setup([], { isTTY: false });
  await join(a.opts(), a.deps);
  const b = setup();
  await join(b.opts({ yes: true }), b.deps);
  for (const t of [a, b]) {
    assert.equal(t.asked.length, 0);
    assert.equal(t.saved().length, 0);
  }
});

test("--specialties saves without asking, even with --yes", async () => {
  const t = setup();
  await join(t.opts({ yes: true, specialties: "billing, stripe" }), t.deps);
  assert.equal(t.asked.length, 0);
  assert.deepEqual(t.saved()[0]?.params.args, {
    specialties: ["billing", "stripe"],
  });
});

test("a failed save does not fail the join; one hint line says how to set it later", async () => {
  const t = setup(["react"], {}, true);
  const r = await join(t.opts(), t.deps);
  assert.equal(r.resident_id, "res_NEW");
  assert.ok(
    t.lines.some((l) => l.includes("profile_set") && l.includes("react")),
  );
});

test("an agent that already has specialties is not asked and not overwritten", async () => {
  const t = setup(["frontend"], {}, false, ["qa", "testing"]);
  await join(t.opts(), t.deps);
  assert.equal(t.asked.length, 0);
  assert.equal(t.saved().length, 0);
  assert.ok(t.lines.some((l) => l.includes("qa, testing")));
});

test("--specialties still overwrites saved ones", async () => {
  const t = setup([], {}, false, ["qa"]);
  await join(t.opts({ specialties: "billing" }), t.deps);
  assert.equal(t.asked.length, 0);
  assert.deepEqual(t.saved()[0]?.params.args, { specialties: ["billing"] });
});

test("when the read fails the join asks as before", async () => {
  const t = setup(["react"], {}, false, "fail");
  await join(t.opts(), t.deps);
  assert.equal(t.asked.length, 1);
  assert.deepEqual(t.saved()[0]?.params.args, { specialties: ["react"] });
});

test("re-join of a connected folder: --specialties saves, no flag never asks or saves", async () => {
  const t = setup(["frontend"], {}, false, ["qa"]);
  await join(t.opts(), t.deps); // first join: has tags, nothing saved
  const r = await join(t.opts({ specialties: "billing, stripe" }), t.deps);
  assert.equal(r.already_joined, true);
  assert.equal(t.saved().length, 1);
  assert.deepEqual(t.saved()[0]?.params, {
    resident_id: "res_NEW",
    name: "profile_set",
    args: { specialties: ["billing", "stripe"] },
  });
  assert.ok(t.lines.some((l) => l.includes("billing, stripe")));

  const u = setup(["frontend"]);
  await join(u.opts({ specialties: "x" }), u.deps);
  const before = u.saved().length;
  const r2 = await join(u.opts(), u.deps);
  assert.equal(r2.already_joined, true);
  assert.equal(u.saved().length, before);
  assert.equal(u.asked.length, 0);
});
