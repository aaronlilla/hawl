/**
 * Terminal toolkit for the full-screen `hawl` (C-AIM) and the framed bits of command output.
 * No dependency: ANSI strings, a key reader, a diffing redraw and 80-column fitting.
 * Plain (no escape codes at all) when `color` is false (NO_COLOR, --no-color, not a terminal).
 */

const ESC = "\u001b";
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export const strip = (s: string): string => s.replace(ANSI, "");
/** Visible width. Every glyph the screens use is one cell wide. */
export const vlen = (s: string): number => [...strip(s)].length;

/** Cut to `w` visible cells, keeping escape codes; a cut adds an ellipsis. */
export function clip(s: string, w: number, ell = "…"): string {
  if (vlen(s) <= w) return s;
  let out = "";
  let n = 0;
  for (let i = 0; i < s.length && n < w - 1; ) {
    const m = /^\u001b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = String.fromCodePoint(s.codePointAt(i) ?? 32);
    out += cp;
    i += cp.length;
    n++;
  }
  return `${out}${ell}${s.includes(ESC) ? `${ESC}[0m` : ""}`;
}

/** Pad (or clip) to exactly `w` cells. */
export function pad(s: string, w: number, right = false): string {
  const c = clip(s, w);
  const gap = " ".repeat(Math.max(0, w - vlen(c)));
  return right ? gap + c : c + gap;
}

/** `left` at the start, `right` at the end of a `w`-wide line. */
export function split(left: string, right: string, w: number): string {
  const room = w - vlen(right) - 1;
  const l = clip(left, Math.max(0, room));
  return l + " ".repeat(Math.max(1, w - vlen(l) - vlen(right))) + right;
}

export interface Paint {
  color: boolean;
  utf8: boolean;
  bold: (s: string) => string;
  dim: (s: string) => string;
  /** muted text, not just dim: reads on dark and light */
  mute: (s: string) => string;
  green: (s: string) => string;
  red: (s: string) => string;
  amber: (s: string) => string;
  blue: (s: string) => string;
  /** Header bar (navy, white text). */
  bar: (s: string) => string;
  /** "Needs you" band (brown). */
  band: (s: string) => string;
  /** Needs-you counter chip. */
  alert: (s: string) => string;
  /** Selected row. */
  sel: (s: string) => string;
  /** Selected row while a pop-up has the focus (greyed bar). */
  selDim: (s: string) => string;
  /** Pop-up card background. */
  card: (s: string) => string;
  /** Key chip. */
  key: (s: string) => string;
}

const rgb =
  (
    fg: [number, number, number] | null,
    bg: [number, number, number] | null,
    bold = false,
  ) =>
  (s: string) => {
    const codes = [
      bold ? "1" : "",
      fg ? `38;2;${fg.join(";")}` : "",
      bg ? `48;2;${bg.join(";")}` : "",
    ]
      .filter(Boolean)
      .join(";");
    // Re-open after a nested reset so a band keeps its background behind coloured words.
    return `${ESC}[${codes}m${s.replaceAll(`${ESC}[0m`, `${ESC}[0;${codes}m`)}${ESC}[0m`;
  };

export function paint(color: boolean, utf8 = true): Paint {
  const id = (s: string) => s;
  if (!color)
    return {
      color,
      utf8,
      bold: id,
      dim: id,
      mute: id,
      green: id,
      red: id,
      amber: id,
      blue: id,
      bar: id,
      band: id,
      alert: id,
      sel: id,
      selDim: id,
      card: id,
      key: id,
    };
  return {
    color,
    utf8,
    bold: (s) => `${ESC}[1m${s}${ESC}[22m`,
    dim: (s) => `${ESC}[2m${s}${ESC}[22m`,
    mute: rgb([138, 133, 122], null),
    green: rgb([138, 216, 60], null),
    red: rgb([224, 82, 66], null),
    amber: rgb([240, 168, 48], null),
    blue: rgb([110, 168, 232], null),
    bar: rgb([245, 245, 245], [31, 47, 85], true),
    band: rgb([232, 116, 44], [58, 34, 20]),
    alert: rgb([255, 255, 255], [188, 58, 8], true),
    sel: rgb([24, 22, 18], [232, 222, 205], true),
    selDim: rgb([24, 22, 18], [138, 133, 122]),
    card: rgb(null, [36, 32, 26]),
    key: rgb([235, 230, 220], [52, 49, 44], true),
  };
}

/** One bar line, full width. Plain terminals get a `sel` marker instead of colour. */
export function fill(
  line: string,
  w: number,
  f: (s: string) => string,
): string {
  return f(pad(line, w));
}

/** `── Today ──` rule with a centred label. */
export function rule(label: string, w: number, utf8 = true): string {
  const ch = utf8 ? "─" : "-";
  const mid = label ? ` ${label} ` : "";
  const side = Math.max(0, w - mid.length);
  const l = Math.floor(side / 2);
  return ch.repeat(l) + mid + ch.repeat(side - l);
}

/** Aligned table; `cols` are the header names, `rows` plain strings. Columns grow to the widest cell. */
export function table(
  head: string[],
  rows: string[][],
  gap = 2,
): { head: string; rows: string[] } {
  const wid = head.map((h, i) =>
    Math.max(vlen(h), ...rows.map((r) => vlen(r[i] ?? ""))),
  );
  const line = (r: string[]) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : pad(c, (wid[i] ?? 0) + gap)))
      .join("");
  return { head: line(head), rows: rows.map(line) };
}

// ---- keys ----

export type Key =
  | {
      name:
        | "up"
        | "down"
        | "left"
        | "right"
        | "enter"
        | "esc"
        | "tab"
        | "backspace"
        | "ctrl-c";
    }
  | { name: "char"; ch: string };

/** Parse one stdin chunk into keys. Works with the Windows console (ENABLE_VIRTUAL_TERMINAL_INPUT) and Unix ttys. */
export function parseKeys(chunk: string): Key[] {
  const out: Key[] = [];
  for (let i = 0; i < chunk.length; ) {
    const c = chunk[i] as string;
    const rest = chunk.slice(i);
    const seq = /^\u001b(?:\[|O)([A-D])/.exec(rest);
    if (seq) {
      out.push({
        name: (["up", "down", "right", "left"] as const)[
          (seq[1] as string).charCodeAt(0) - 65
        ] as "up",
      });
      i += seq[0].length;
    } else if (c === ESC) {
      out.push({ name: "esc" });
      i++;
    } else if (c === "\r" || c === "\n") {
      out.push({ name: "enter" });
      i += c === "\r" && chunk[i + 1] === "\n" ? 2 : 1;
    } else if (c === "\t") {
      out.push({ name: "tab" });
      i++;
    } else if (c === "\u007f" || c === "\b") {
      out.push({ name: "backspace" });
      i++;
    } else if (c === "\u0003") {
      out.push({ name: "ctrl-c" });
      i++;
    } else if (c >= " ") {
      const cp = String.fromCodePoint(chunk.codePointAt(i) ?? 32);
      out.push({ name: "char", ch: cp });
      i += cp.length;
    } else i++;
  }
  return out;
}

// ---- screen ----

export interface ScreenIo {
  write: (s: string) => void;
  cols: () => number;
  rows: () => number;
}

/** Full-screen region redraw: only lines that changed are rewritten. */
export class Screen {
  private prev: string[] = [];
  private io: ScreenIo;
  constructor(io: ScreenIo) {
    this.io = io;
  }

  enter(): void {
    this.io.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J`);
  }

  leave(): void {
    this.io.write(`${ESC}[?25h${ESC}[?1049l`);
  }

  /** Draw `lines` (padded or cut to the terminal height). */
  draw(lines: string[]): void {
    const h = this.io.rows();
    let out = "";
    for (let y = 0; y < h; y++) {
      const l = lines[y] ?? "";
      if (this.prev[y] === l) continue;
      out += `${ESC}[${y + 1};1H${l}${ESC}[0m${ESC}[K`;
    }
    this.prev = Array.from({ length: h }, (_, y) => lines[y] ?? "");
    if (out) this.io.write(out);
  }

  /** Forget what is on screen (after a resize). */
  invalidate(): void {
    this.prev = [];
    this.io.write(`${ESC}[2J`);
  }
}

/** Frame a block of lines in a box (question pop-up). */
export function box(lines: string[], w: number, utf8 = true): string[] {
  const c = utf8
    ? { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
  const inner = w - 4;
  return [
    c.tl + c.h.repeat(w - 2) + c.tr,
    ...lines.map((l) => `${c.v} ${pad(l, inner)} ${c.v}`),
    c.bl + c.h.repeat(w - 2) + c.br,
  ];
}

/**
 * Lay `over` lines on top of `base` at column `x`, row `y` (default: centred, upper third). Covered base rows
 * lose their colour (the pop-up has the focus); `style(row)` picks how one row's remainder is painted.
 */
export function overlay(
  base: string[],
  over: string[],
  cols: number,
  dim: (s: string) => string = (s) => s,
  at?: {
    x?: number;
    y?: number;
    style?: (row: number) => ((s: string) => string) | undefined;
  },
): string[] {
  const w = Math.max(...over.map(vlen));
  const x = at?.x ?? Math.max(0, Math.floor((cols - w) / 2));
  const y = at?.y ?? Math.max(0, Math.floor((base.length - over.length) / 3));
  const out = [...base];
  over.forEach((o, i) => {
    if (y + i >= base.length) return;
    const b = [...strip(base[y + i] ?? "")];
    const d = at?.style?.(y + i) ?? dim;
    out[y + i] =
      `${d(pad(b.slice(0, x).join(""), x))}${o}${d(b.slice(x + w).join(""))}`;
  });
  return out;
}
