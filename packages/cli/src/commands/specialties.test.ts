import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "../test-tmp.ts";
import { join as pjoin } from "node:path";
import test from "node:test";
import { newTownFile, writeTownFile } from "../town-file.ts";
import { specialties } from "./specialties.ts";

/** A folder joined as res_A; the daemon stub answers `who` and records `profile_set`. */
function setup(joined = true, saved: string[] = ["qa"]) {
  const dir = mkdtempSync(pjoin(tmpdir(), "hawl-spec-"));
  if (joined) {
    const t = newTownFile("qa-yard");
    t.memberships.push({
      town_id: "t1",
      town_slug: "acme",
      relay_url: "https://relay.test",
      workers: [{ resident_id: "res_A", platform: "claude_code", kid: "k1" }],
    });
    writeTownFile(dir, t);
  }
  const lines: string[] = [];
  const sets: Record<string, unknown>[] = [];
  const deps = {
    stateDir: pjoin(dir, "state"),
    print: (l: string) => lines.push(l),
    daemon: () => ({
      call: async (_m: string, p: Record<string, unknown>) => {
        if (p.name === "profile_set") {
          sets.push(p);
          return { ok: true };
        }
        return {
          workers: [
            { resident_id: "res_B", specialties: ["other"] },
            { resident_id: "res_A", specialties: saved },
          ],
        };
      },
    }),
  };
  return { dir, lines, sets, deps };
}

test("no args prints this folder's agent specialties", async () => {
  const t = setup(true, ["qa", "testing"]);
  await specialties({ projectDir: t.dir }, t.deps);
  assert.ok(t.lines.some((l) => l.includes("qa, testing")));
  assert.ok(!t.lines.some((l) => l.includes("other")));
  assert.equal(t.sets.length, 0);
});

test("no args with none saved says how to set them", async () => {
  const t = setup(true, []);
  await specialties({ projectDir: t.dir }, t.deps);
  assert.ok(t.lines.some((l) => l.includes("hawl specialties")));
});

test("args save through profile_set: trimmed, capped at 10", async () => {
  const t = setup();
  const tags = Array.from({ length: 12 }, (_, i) => `t${i}`);
  await specialties(
    { projectDir: t.dir, tags: ` qa , testing,,${tags.join(",")}` },
    t.deps,
  );
  assert.equal(t.sets.length, 1);
  assert.deepEqual(t.sets[0], {
    resident_id: "res_A",
    name: "profile_set",
    args: { specialties: ["qa", "testing", ...tags.slice(0, 8)] },
  });
});

test("a folder that is not joined is a clear error", async () => {
  const t = setup(false);
  await assert.rejects(
    specialties({ projectDir: t.dir, tags: "qa" }, t.deps),
    /not connected to a site/,
  );
  await assert.rejects(
    specialties({ projectDir: t.dir }, t.deps),
    /not connected to a site/,
  );
  assert.equal(t.sets.length, 0);
});
