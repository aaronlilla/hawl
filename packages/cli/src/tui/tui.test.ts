import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModel, onKey } from "../aim/index.ts";
import { renderAim, type View } from "../aim/render.ts";
import { CliError, formatError } from "../cli-errors.ts";
import { makeStyle } from "../style.ts";
import { fakeTeam } from "../team.ts";
import { clip, paint, parseKeys, strip, vlen } from "./index.ts";

test("parseKeys: arrows, enter, esc, chars, ctrl-c", () => {
  assert.deepEqual(parseKeys("\u001b[A\u001b[B\r\u001b1"), [
    { name: "up" },
    { name: "down" },
    { name: "enter" },
    { name: "esc" },
    { name: "char", ch: "1" },
  ]);
  assert.deepEqual(parseKeys("\u0003"), [{ name: "ctrl-c" }]);
});

test("clip keeps escape codes and cuts by visible cells", () => {
  const s = `\u001b[1mhello world\u001b[22m`;
  assert.equal(vlen(clip(s, 5)), 5);
  assert.equal(strip(clip(s, 5)), "hell…");
  assert.equal(clip("short", 9), "short");
});

test("every AIM screen fits 80 columns, and is free of escape codes in plain mode", async () => {
  const team = fakeTeam();
  const views: View[] = [
    "home",
    "needs",
    "help",
    "question",
    "assistant",
    "dispute",
    "rooms",
    "signedout",
    "down",
    "loading",
  ];
  for (const color of [false, true]) {
    const p = paint(color, true);
    for (const v of views) {
      const m = await loadModel(team, v);
      const lines = renderAim(
        { ...m, steps: [{ text: "service running", done: true }] },
        80,
        30,
        p,
      );
      assert.equal(lines.length, 30, v);
      for (const l of lines)
        assert.ok(vlen(l) <= 80, `${v} ${color}: ${vlen(l)} wide: ${strip(l)}`);
      if (!color)
        assert.equal(lines.join(""), strip(lines.join("")), `${v} plain`);
    }
  }
});

test("keys: 1 answers the top ask, Enter opens the chat, Esc comes back", async () => {
  const team = fakeTeam();
  let m = await loadModel(team);
  assert.equal(m.asks.length, 2);
  m = (await onKey(m, { name: "char", ch: "1" }, team)) ?? m;
  assert.equal(m.asks.length, 1);
  assert.match(m.notice ?? "", /Answered "All 3 regions"/);
  m = (await onKey(m, { name: "enter" }, team)) ?? m;
  assert.equal(m.view, "chat");
  assert.equal(m.chatWith?.name, "Riley");
  m = (await onKey(m, { name: "esc" }, team)) ?? m;
  assert.equal(m.view, "home");
  assert.equal(await onKey(m, { name: "char", ch: "q" }, team), null);
});

test("errors: cross, one fix, doctor line; plain under NO_COLOR", () => {
  const st = makeStyle(false, true);
  assert.equal(
    formatError(st, new CliError("You are not signed in; run `hawl login`.")),
    "✗ You are not signed in; run `hawl login`.\nStill stuck? Run hawl doctor.\n",
  );
});

test("pop-ups: the card's top edge sits on the selected row, the bar stays full width; system lines go right", async () => {
  const team = fakeTeam();
  for (const view of ["help", "question"] as const) {
    const m = await loadModel(team, view);
    const plain = renderAim(m, 120, 34, paint(false, true));
    const i = plain.findIndex((l) => l.startsWith(">"));
    assert.match(plain[i] ?? "", /Riley.*┌─+┐/, view);
    const col = renderAim(m, 120, 34, paint(true, true));
    assert.equal(vlen(col[i] ?? ""), 120, `${view}: bar spans the row`);
    assert.match(col[i] ?? "", /48;2;138;133;122/, view);
  }
  const chat = await loadModel(team, "chat");
  const sam = chat.people.find((x) => x.name === "Sam");
  const off = renderAim(
    { ...chat, chatWith: sam, thread: [] },
    120,
    34,
    paint(false, true),
  );
  assert.match(
    off.find((l) => l.includes("Sam is offline.")) ?? "",
    /^ {40,}Sam is offline\. .* signs on\.$/,
  );
});

test("real keys reach the chat pane without a history route, and the question pop-up from Needs you", async () => {
  const { NotWired } = await import("../team.ts");
  const team = {
    ...fakeTeam(),
    fake: false,
    thread: async () => {
      throw new NotWired("Chat history");
    },
  };
  let m = await loadModel(team);
  m = (await onKey(m, { name: "enter" }, team)) ?? m;
  assert.equal(m.view, "chat");
  assert.deepEqual(m.thread, []);
  assert.equal(m.readAt, undefined);
  assert.doesNotMatch(
    renderAim(m, 120, 34, paint(false, true)).join("\n"),
    /Read 2:28/,
  );
  m = (await onKey(m, { name: "esc" }, team)) ?? m;
  m = (await onKey(m, { name: "char", ch: "n" }, team)) ?? m;
  assert.equal(m.view, "needs");
  m = (await onKey(m, { name: "enter" }, team)) ?? m;
  assert.equal(m.view, "question");
  assert.match(
    renderAim(m, 120, 34, paint(false, true)).join("\n"),
    /asks you/,
  );
  // Esc answers later: the ask stays.
  const later = (await onKey(m, { name: "esc" }, team)) ?? m;
  assert.equal(later.view, "home");
  assert.equal(later.asks.length, 2);
  // A digit answers; other keys type an answer.
  const one = (await onKey(m, { name: "char", ch: "2" }, team)) ?? m;
  assert.match(one.notice ?? "", /Answered "US first"/);
  let t = (await onKey(m, { name: "char", ch: "o" }, team)) ?? m;
  t = (await onKey(t, { name: "char", ch: "k" }, team)) ?? t;
  t = (await onKey(t, { name: "enter" }, team)) ?? t;
  assert.match(t.notice ?? "", /Answered "ok" to shop-web/);
  assert.equal(t.asks.length, 1);
});

test("hawl share --list shows every folder this PC joined, and a stopped one as private", async () => {
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { newTownFile, addWorker, writeTownFile } = await import(
    "../town-file.ts"
  );
  const { rememberFolder } = await import("../folders.ts");
  const { socketTeam } = await import("../team.ts");
  const root = mkdtempSync(join(tmpdir(), "hawl-share-"));
  const state = join(root, "state");
  mkdirSync(state);
  const joined = (name: string, site: string) => {
    const dir = join(root, name);
    mkdirSync(dir);
    const t = newTownFile(name);
    addWorker(
      t,
      { town_id: "twn_1", town_slug: site, relay_url: "http://x" },
      { resident_id: `res_${name}`, platform: "claude_code", kid: "k" },
    );
    writeTownFile(dir, t);
    rememberFolder(state, dir);
    return dir;
  };
  const api = joined("shop-api", "acme");
  joined("shop-web", "acme");
  const stopped = join(root, "infra");
  mkdirSync(stopped);
  rememberFolder(state, stopped);
  assert.deepEqual(await socketTeam({} as never, api, state).shares(), [
    { folder: "shop-api", with: "acme" },
    { folder: "shop-web", with: "acme" },
    { folder: "infra", with: "private to you" },
  ]);
});
