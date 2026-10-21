/** Terminal style rules T2, T3, T5 (docs/18-experience/screens/KL-terminal-agent.md). */

export interface StyleEnv {
  env: Record<string, string | undefined>;
  argv: string[];
  isTTY: boolean;
  /** False for legacy consoles that are not UTF-8: plain ok/x/! symbols. */
  utf8?: boolean;
}

/** NO_COLOR set and not empty, --no-color, or output not a terminal: no colour. */
export function colorEnabled(e: StyleEnv): boolean {
  if (e.argv.includes("--no-color")) return false;
  if ((e.env.NO_COLOR ?? "") !== "") return false;
  if (e.env.TERM === "dumb") return false;
  return e.isTTY;
}

export function utf8Enabled(
  platform: string,
  env: Record<string, string | undefined>,
): boolean {
  if (platform !== "win32") return true;
  return !!(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === "ON");
}

export interface Style {
  color: boolean;
  ok: string;
  fail: string;
  warn: string;
  bullet: string;
  spinnerFrames: string[];
  bold: (s: string) => string;
  dim: (s: string) => string;
  green: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function makeStyle(color: boolean, utf8 = true): Style {
  const w = (open: number, close: number) => (s: string) =>
    color ? `\u001b[${open}m${s}\u001b[${close}m` : s;
  const green = w(32, 39);
  const red = w(31, 39);
  const yellow = w(33, 39);
  return {
    color,
    ok: green(utf8 ? "✓" : "ok"),
    fail: red(utf8 ? "✗" : "x"),
    warn: yellow("!"),
    bullet: utf8 ? "•" : "-",
    spinnerFrames: utf8 ? SPIN : ["..."],
    bold: w(1, 22),
    dim: w(2, 22),
    green,
    red,
    yellow,
    cyan: w(36, 39),
  };
}

export function styleFor(e: StyleEnv): Style {
  return makeStyle(colorEnabled(e), e.utf8 ?? true);
}

/** Wrap prose at `width` columns. Lines that start with 4+ spaces (commands) stay whole. */
export function wrap(text: string, width = 78): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= width || /^ {4}/.test(line)) return line;
      const indent = /^\s*/.exec(line)?.[0] ?? "";
      const out: string[] = [];
      let cur = indent;
      for (const word of line.trim().split(/\s+/)) {
        if (cur.trim() && cur.length + 1 + word.length > width) {
          out.push(cur);
          cur = indent + word;
        } else cur += (cur.trim() ? " " : "") + word;
      }
      out.push(cur);
      return out.join("\n");
    })
    .join("\n");
}
