/** Every C-AIM screen as a pure function: model + size in, lines out. No I/O, so a snapshot is the same code path as the live screen. */
import type { Ask, Dispute, Msg, Person, SessionChip } from "../team.ts";
import {
  box,
  clip,
  fill,
  overlay,
  type Paint,
  pad,
  rule,
  split,
  strip,
  vlen,
} from "../tui/index.ts";

export type View =
  | "loading"
  | "home"
  | "chat"
  | "assistant"
  | "needs"
  | "help"
  | "question"
  | "dispute"
  | "rooms"
  | "signedout"
  | "down";

export interface Model {
  view: View;
  me: { name: string; presence: string };
  people: Person[];
  sessions: SessionChip[];
  asks: Ask[];
  /** Index into the selectable people (online ones). */
  sel: number;
  chatWith?: Person;
  thread?: Msg[];
  /** "Read 2:28 PM" under the thread; only when the relay says so (sample team only for now). */
  readAt?: string;
  input: string;
  assistant?: { where: string; lines: { glyph: string; text: string }[] };
  dispute?: Dispute | null;
  rooms?: { name: string; detail: string; huddle?: boolean }[];
  /** Loading steps: tick when done. */
  steps?: { text: string; done: boolean }[];
  lastConnected?: string;
  /** Free line under the body (sent, error). */
  notice?: string;
  /** Set by a key on the offline screens; the loop does the work. */
  act?: "start" | "signin" | "retry";
}

const isOnline = (p: Person) =>
  ["available", "busy", "away"].includes(p.presence);
/** People the cursor can land on: everyone online, in site order. */
export const selectable = (people: Person[]): Person[] =>
  people.filter(isOnline);

export function groups(people: Person[]) {
  const sites = [...new Set(people.map((p) => p.site))];
  return {
    sites: sites.map((name) => {
      const all = people.filter((p) => p.site === name);
      return { name, total: all.length, online: all.filter(isOnline) };
    }),
    offline: people.filter((p) => !isOnline(p)).length,
  };
}

const dot = (p: Paint, pr: string) =>
  pr === "available"
    ? p.green("●")
    : pr === "busy"
      ? p.red("●")
      : pr === "away"
        ? p.amber("●")
        : p.mute("○");
const presenceWord = (pr: string) =>
  pr === "available"
    ? "Available"
    : pr === "busy"
      ? "Do not disturb"
      : pr === "away"
        ? "Away"
        : pr === "invited"
          ? "Invited"
          : "Offline";

function keybar(p: Paint, w: number, view: View, hasAsks: boolean): string {
  const all: [string, string][] =
    view === "signedout"
      ? [
          ["Enter", "sign in"],
          ["q", "quit"],
        ]
      : view === "down"
        ? [
            ["Enter", "start Hawl"],
            ["q", "quit"],
          ]
        : [
            ["↑↓", "move"],
            ["Enter", view === "needs" && hasAsks ? "open" : "IM"],
            ["i", "info"],
            ...(hasAsks
              ? ([["1-3", "answer top ask"]] as [string, string][])
              : []),
            ["t", "sessions"],
            ["/", "find"],
            ["?", "help"],
            ["q", "quit"],
          ];
  const chip = (k: string, l: string) =>
    p.color ? `${p.key(` ${k} `)}${p.mute(` ${l}`)}` : `${k} ${l}`;
  // Narrow terminals keep the keys that matter first and drop the rest.
  const keep =
    w < 100
      ? new Set(["↑↓", "Enter", "1-3", "?", "start Hawl", "sign in", "q"])
      : null;
  const items = all.filter(([k, l]) => !keep || keep.has(k) || keep.has(l));
  let out = "";
  for (const [k, l] of items) {
    const next = `${out}${out ? "  " : ""}${chip(k, l)}`;
    if (vlen(next) > w - 1) break;
    out = next;
  }
  return out;
}

function header(m: Model, p: Paint, w: number): string {
  const right =
    m.view === "loading"
      ? `${m.me.name}  Signing on...`
      : m.view === "signedout"
        ? `${m.me.name} ○ Signed out`
        : m.view === "down"
          ? `${m.me.name} ○ Offline`
          : `${m.me.name} ● ${presenceWord(m.me.presence)}`;
  const live =
    m.view !== "signedout" && m.view !== "down" && m.view !== "loading";
  const chip = live && m.asks.length ? ` Needs you: ${m.asks.length} ` : "";
  // One navy band; the counter chip sits at its right edge in the alert colour.
  const bar = p.bar(split(" hawl", chip ? right : `${right} `, w - vlen(chip)));
  return chip ? bar + p.alert(chip) : bar;
}

function band(m: Model, p: Paint, w: number): string[] {
  const a = m.asks[0];
  if (
    !a ||
    m.view === "signedout" ||
    m.view === "down" ||
    m.view === "loading" ||
    m.view === "needs"
  )
    return [];
  const keys = a.options.map(
    (o, i) => `${a.yesNo ? (i === 0 ? "y" : "n") : i + 1} ${o}`,
  );
  const more = m.asks.length - 1;
  const lines = [
    `${p.bold("?")} ${p.bold(a.from)} asks: ${a.text}`,
    `  ${keys.join("   ")}`,
    ...(more > 0
      ? [`  +${more} more: ${m.asks[1]?.from} asks (n: see all)`]
      : []),
  ];
  return lines.map((l) => fill(` ${clip(l, w - 2)}`, w, p.band));
}

function chips(m: Model, p: Paint, w: number): string[] {
  const glyph = (s: SessionChip["state"]) =>
    s === "ok" ? p.green("●") : s === "ask" ? p.amber("?") : p.blue("○");
  const out: string[] = [];
  let cur = " ";
  for (const c of m.sessions) {
    const item = `${glyph(c.state)} ${c.label}`;
    if (vlen(cur) + vlen(item) + 3 > w && vlen(cur) > 1) {
      out.push(cur);
      cur = " ";
    }
    cur += (vlen(cur) > 1 ? "   " : "") + item;
  }
  if (vlen(cur) > 1) out.push(cur);
  return out;
}

function personRow(pe: Person, selected: boolean, w: number, p: Paint): string {
  const unread = pe.unread ? `${p.utf8 ? "▣" : "#"}${pe.unread}` : "";
  const line = split(
    `   ${dot(p, pe.presence)} ${p.bold(pad(pe.name, 8))} ${p.mute(pe.text)}`,
    unread,
    w - 1,
  );
  if (!selected) return ` ${line}`;
  return p.color ? p.sel(pad(strip(line), w)) : `>${line}`;
}

function list(
  m: Model,
  p: Paint,
  w: number,
): { lines: string[]; selAt: number } {
  const g = groups(m.people);
  const sel = selectable(m.people)[m.sel];
  const out: string[] = [];
  let selAt = 0;
  out.push(` ${p.mute("Your sessions")}`, "", ...chips(m, p, w), "");
  for (const s of g.sites) {
    out.push(
      ` ${p.amber("▾")} ${p.bold(s.name)} ${p.mute(`${s.online.length} of ${s.total} online`)}`,
    );
    for (const pe of s.online) {
      if (pe === sel) selAt = out.length;
      out.push(personRow(pe, pe === sel, w, p));
    }
  }
  if (g.offline)
    out.push(
      ` ${p.amber("▸")} ${p.bold("Offline")} ${p.mute(`(${g.offline})`)}`,
    );
  return { lines: out, selAt };
}

function detail(pe: Person | undefined, p: Paint, w: number): string[] {
  if (!pe) return [];
  const row = (k: string, v: string) => ` ${p.mute(pad(k, 11))} ${v}`;
  return [
    ` ${dot(p, pe.presence)} ${p.bold(pe.name)}  ${p.mute(`${presenceWord(pe.presence)}${pe.localTime ? ` · ${pe.localTime}` : ""}`)}`,
    "",
    ...(pe.text ? [row("Right now", pe.text)] : []),
    ...(pe.sites ? [row("Sites", pe.sites)] : []),
    ...(pe.openTo ? [row("Open to", pe.openTo)] : []),
    ...(pe.live?.length
      ? [
          "",
          ` ${p.mute("Live now")}`,
          ...pe.live.map(
            (l) =>
              `   ${p.mute(l.glyph)} ${p.bold(l.label)} ${p.mute("·")} ${l.text}`,
          ),
        ]
      : []),
    ` ${p.mute(`When away, ${pe.name}'s assistant answers.`)}`,
    "",
    ` ${p.amber("Enter")} IM ${pe.name}   ${p.amber("i")} full info   ${p.amber("a")} assign a ticket`,
  ].map((l) => clip(l, w));
}

function chatBody(m: Model, p: Paint, w: number): string[] {
  const pe = m.chatWith;
  if (!pe) return [];
  const offline = !isOnline(pe);
  const when = offline
    ? `Offline · last on 9:12 AM`
    : `${presenceWord(pe.presence)} · ${pe.text}`;
  const out = [
    ` ${dot(p, pe.presence)} ${p.bold(pe.name)}  ${p.mute(when)}`,
    "",
    ` To: ${p.bold(pe.name)} ▾${offline ? "" : `  ${p.mute(`(Tab: pick one of ${pe.name}'s sessions)`)}`}`,
    "",
    ` ${p.mute(rule("Today", Math.min(w - 2, 50), p.utf8))}`,
    "",
  ];
  const mine = (s: string) => p.bold(s);
  for (const t of m.thread ?? []) {
    if (t.assistantOf) {
      out.push(
        ` ${p.blue(t.who)} ${p.mute(`(${t.assistantOf}) ${t.at}`)}`,
        `   ${t.text}`,
        "",
      );
    } else
      out.push(
        ` ${t.mine ? mine(t.who) : p.blue(t.who)} ${p.mute(t.at)}  ${t.text}`,
        "",
      );
  }
  // System lines sit at the right edge, muted.
  if (offline)
    out.push(
      split(
        "",
        p.mute(
          `${pe.name} is offline. It reaches ${pe.name} when ${pe.name} signs on.`,
        ),
        w - 1,
      ),
    );
  else if (m.readAt) out.push(split("", p.mute(`Read ${m.readAt}`), w - 1));
  return out.map((l) => clip(l, w));
}

function assistantBody(m: Model, p: Paint, w: number): string[] {
  const a = m.assistant;
  return [
    ` ${p.bold("Your assistant")} ${p.mute(`· ${a?.where ?? ""}`)}`,
    "",
    ...(a?.lines.length ? a.lines : [{ glyph: " ", text: "Nothing yet." }]).map(
      (l) => {
        const g =
          l.glyph === "●" ? p.green("●") : l.glyph === "◌" ? p.amber("◌") : " ";
        return ` ${g} ${l.glyph === " " ? p.mute(l.text) : l.text}`;
      },
    ),
  ].map((l) => clip(l, w));
}

function needsBody(m: Model, p: Paint, w: number): string[] {
  const out = [` ${p.bold(`Needs you (${m.asks.length})`)}`, ""];
  for (const a of m.asks) {
    const keys = a.options
      .map((o, i) => `${a.yesNo ? (i === 0 ? "y" : "n") : i + 1} ${o}`)
      .join("   ");
    out.push(
      split(
        ` ${p.amber("?")} ${p.bold(a.from)} asks: ${a.text}`,
        `${p.mute(a.at)} `,
        w,
      ),
      `   ${p.amber(keys)}`,
      "",
    );
  }
  return out;
}

function disputeBody(m: Model, p: Paint, w: number): string[] {
  const d = m.dispute;
  if (!d) return [` ${p.mute("No disagreements.")}`];
  return [
    ` ${p.red("!")} ${p.bold(`Disagreement on ${d.ticket}`)}  ${p.mute(`Round ${d.round} of ${d.of}`)}`,
    "",
    ...d.lines.map((l) => ` ${p.blue(l.who)}: ${l.text}`),
    "",
    ` ${p.mute(`After round ${d.of} you and Riley decide.`)}`,
    "",
    ` ${d.options.map((o, i) => `${p.amber(String(i + 1))} ${o}`).join("   ")}`,
  ].map((l) => clip(l, w));
}

function roomsBody(m: Model, p: Paint, w: number): string[] {
  return [
    ` ${p.bold("Rooms")}`,
    "",
    ...(m.rooms ?? []).map(
      (r) =>
        ` ${p.amber("▸")} ${r.huddle ? p.bold(r.name) : r.name}  ${p.mute(r.detail)}`,
    ),
  ].map((l) => clip(l, w));
}

function offlineBody(m: Model, p: Paint): string[] {
  if (m.view === "signedout")
    return [
      "",
      ` ${p.amber("!")} ${p.bold("You are signed out of Hawl.")}`,
      " Sign in to see your teammates.",
      "",
      `   ${p.amber("Enter")} open the sign-in page in your browser`,
      `   ${p.amber("q")} quit`,
      "",
      ` ${p.mute("Your sessions keep running.")}`,
    ];
  return [
    "",
    ` ${p.amber("!")} ${p.bold("Hawl is not running on this PC.")}`,
    " Your sessions are fine, but teammates cannot reach you.",
    "",
    `   ${p.amber("Enter")} start Hawl`,
    `   ${p.amber("r")} try again`,
    `   ${p.amber("q")} quit`,
    "",
    ` ${p.mute(`Last connected ${m.lastConnected ?? "never"}.`)}`,
  ];
}

function loadingBody(m: Model, p: Paint): string[] {
  return [
    "",
    ` ${p.bold("Signing on to Hawl...")}`,
    ...(m.steps ?? []).map(
      (s) =>
        ` ${s.done ? p.green(p.utf8 ? "✓" : "ok") : p.amber("◌")} ${s.text}`,
    ),
  ];
}

function helpCard(p: Paint): string[] {
  const rows: [string, string][] = [
    ["↑ ↓", "move through people"],
    ["Enter", "send an IM to the person"],
    ["i", "Get Info"],
    ["1 2 3", "answer the top item in Needs you"],
    ["n", "see everything in Needs you"],
    ["t", "your sessions"],
    ["a", "assign a ticket"],
    ["/", "find someone"],
    ["?", "this help"],
    ["q", "quit"],
  ];
  return [
    "",
    p.bold("Keys"),
    "",
    ...rows.map(([k, d]) => `${p.amber(pad(k, 8))} ${d}`),
    "",
    p.mute("Esc closes"),
    "",
  ];
}

function questionCard(a: Ask, p: Paint): string[] {
  return [
    "",
    `${p.amber("?")} ${p.bold(a.from)} asks you  ${p.mute(a.at)}`,
    "",
    a.text,
    "",
    ...a.options.map(
      (o, i) =>
        `${p.amber(a.yesNo ? (i === 0 ? "y" : "n") : String(i + 1))} ${o}${a.recommended === i + 1 ? `  ${p.mute("(recommended)")}` : ""}`,
    ),
    "",
    p.mute("or type an answer and press Enter · Esc answers later"),
    "",
  ];
}

/** The whole screen: `rows` lines of exactly `cols` cells where a bar or band fills the line. */
export function renderAim(
  m: Model,
  cols: number,
  rows: number,
  p: Paint,
): string[] {
  const w = Math.max(40, cols);
  const top = [header(m, p, w), ...band(m, p, w)];
  const wide = w >= 100;
  let body: string[];
  let selAt = -1;
  const popup = m.view === "help" || m.view === "question";
  switch (m.view) {
    case "loading":
      body = loadingBody(m, p);
      break;
    case "signedout":
    case "down":
      body = offlineBody(m, p);
      break;
    case "chat":
      body = chatBody(m, p, w);
      break;
    case "assistant":
      body = assistantBody(m, p, w);
      break;
    case "needs":
      body = needsBody(m, p, w);
      break;
    case "dispute":
      body = disputeBody(m, p, w);
      break;
    case "rooms":
      body = roomsBody(m, p, w);
      break;
    default: {
      // A pop-up has the focus: the list goes full width (bar included) and is greyed behind the card.
      const lw = wide && !popup ? Math.floor(w * 0.46) : w;
      const { lines: left, selAt: at } = list(m, p, lw);
      selAt = at;
      if (!wide || popup) body = left;
      else {
        const right = detail(selectable(m.people)[m.sel], p, w - lw - 1);
        const bar = p.mute(p.utf8 ? "│" : "|");
        body = Array.from(
          { length: Math.max(left.length, right.length) },
          (_, i) => `${pad(left[i] ?? "", lw)}${bar}${right[i] ?? ""}`,
        );
      }
    }
  }
  const showInput =
    m.view === "chat" || m.view === "assistant" || m.view === "question";
  const bottom = [
    ...(m.notice ? [` ${m.notice}`] : []),
    ...(showInput
      ? [
          ` ${p.utf8 ? "▌" : ">"}${m.input || p.mute(m.view === "question" ? "Type an answer" : `Message ${m.view === "chat" ? (m.chatWith?.name ?? "") : "your assistant"}`)}`,
        ]
      : []),
    ` ${keybar(p, w - 1, m.view, m.asks.length > 0)}`,
  ];
  const room = Math.max(0, rows - top.length - bottom.length);
  const lines = [
    ...top,
    ...body.slice(0, room),
    ...Array.from({ length: Math.max(0, room - body.length) }, () => ""),
    ...bottom,
  ];
  if (popup && (m.view === "help" || m.asks[0])) {
    const card =
      m.view === "help" ? helpCard(p) : questionCard(m.asks[0] as Ask, p);
    const framed = box(card, m.view === "help" ? 62 : 66, p.utf8).map((l) =>
      p.card(l),
    );
    const row = top.length + selAt;
    const grey = (l: string, i: number) =>
      p.color
        ? i === row
          ? p.selDim(pad(strip(l), w))
          : i >= top.length && i < top.length + body.length
            ? p.mute(strip(l))
            : l
        : l;
    const dimmed = lines.map(grey);
    const x = Math.min(
      Math.max(0, w - vlen(framed[0] as string)),
      Math.floor(w * 0.42),
    );
    const y = Math.max(0, Math.min(row, lines.length - framed.length));
    return overlay(dimmed, framed, w, p.mute, {
      x,
      y,
      style: (i) => (p.color && i === row ? p.selDim : undefined),
    });
  }
  return lines;
}
