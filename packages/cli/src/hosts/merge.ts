import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { writeFileDurable } from "../daemon/fsutil.ts";

export type Json = Record<string, unknown>;

/** One thing we wrote, recorded in `.hawl/hawl.json` `written` (spec 16 §3.4). */
export interface WrittenEntry {
  path: string;
  key: string;
  sha256: string;
}

/** What a file held before and after we touched it, so an untouched file goes back byte for byte. */
export interface RestoreRecord {
  path: string;
  /** sha256 of the original bytes, or null when the file did not exist. */
  before: string | null;
  /** sha256 of the bytes we wrote. */
  after: string;
  /** Backup file name under the backup root, when the file existed. */
  backup?: string;
}

export type JsonOp =
  | { kind: "set"; key: string[]; value: unknown }
  | { kind: "append"; key: string[]; value: unknown };

export interface TomlBlock {
  /** Dotted name for the record, e.g. `mcp_servers.hawl`. */
  key: string;
  /** Table path that must not already exist. For `[[x]]` tables (`array`) it must be a list or absent. */
  table: string[];
  array?: boolean;
  text: string;
}

export interface FilePlan {
  /** As recorded: relative to the project folder, or `~/...` for user-scope files. */
  path: string;
  abs: string;
  before: string | null;
  after: string;
  entries: WrittenEntry[];
  skipped: { key: string; reason: string }[];
  changed: boolean;
}

export interface Dirs {
  projectDir: string;
  stateDir: string;
}

export const sha256 = (s: string | Uint8Array): string =>
  createHash("sha256").update(s).digest("hex");

/** Key-sorted JSON, so equal values hash equal. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Json;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const hashValue = (v: unknown) => sha256(canonical(v));

function getPath(doc: Json, key: string[]): unknown {
  let cur: unknown = doc;
  for (const k of key) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Json)[k];
  }
  return cur;
}

/** Parent object of `key`, optionally created on the way. Null when a non-object is in the way. */
function parentOf(doc: Json, key: string[], create: boolean): Json | null {
  let cur = doc;
  for (const k of key.slice(0, -1)) {
    if (cur[k] === undefined && create) cur[k] = {};
    const n = cur[k];
    if (!n || typeof n !== "object" || Array.isArray(n)) return null;
    cur = n as Json;
  }
  return cur;
}

export function renderJson(doc: Json): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function emptyPlan(path: string, abs: string, before: string | null): FilePlan {
  return {
    path,
    abs,
    before,
    after: before ?? "",
    entries: [],
    skipped: [],
    changed: false,
  };
}

/** Merge ops into a JSON file. Never overwrites a differing value; says what it skipped. */
export function planJson(
  path: string,
  abs: string,
  ops: JsonOp[],
  before: string | null,
): FilePlan {
  const plan = emptyPlan(path, abs, before);
  let doc: Json = {};
  if (before !== null && before.trim() !== "") {
    try {
      const parsed = JSON.parse(before) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("not an object");
      doc = parsed as Json;
    } catch {
      for (const op of ops)
        plan.skipped.push({
          key: op.key.join("."),
          reason: "file is not plain JSON; left alone",
        });
      return plan;
    }
  }
  for (const op of ops) {
    const name = op.key.join(".");
    const last = op.key[op.key.length - 1] as string;
    const have = parentOf(doc, op.key, false)?.[last];
    if (op.kind === "set") {
      if (have !== undefined) {
        if (canonical(have) === canonical(op.value))
          plan.entries.push({ path, key: name, sha256: hashValue(op.value) });
        else
          plan.skipped.push({
            key: name,
            reason: "already set to something else; not overwritten",
          });
        continue;
      }
      const p = parentOf(doc, op.key, true);
      if (!p) {
        plan.skipped.push({ key: name, reason: "parent is not an object" });
        continue;
      }
      p[last] = op.value;
      plan.entries.push({ path, key: name, sha256: hashValue(op.value) });
    } else {
      if (have !== undefined && !Array.isArray(have)) {
        plan.skipped.push({ key: name, reason: "not a list; not touched" });
        continue;
      }
      const list = (have as unknown[] | undefined) ?? [];
      const h = hashValue(op.value);
      if (!list.some((x) => hashValue(x) === h)) {
        const p = parentOf(doc, op.key, true);
        if (!p) {
          plan.skipped.push({ key: name, reason: "parent is not an object" });
          continue;
        }
        p[last] = [...list, op.value];
      }
      plan.entries.push({ path, key: `${name}[]`, sha256: h });
    }
  }
  if (plan.entries.length === 0) return plan;
  plan.after = renderJson(doc);
  plan.changed = plan.after !== before;
  return plan;
}

const withNewline = (s: string) => (s.endsWith("\n") ? s : `${s}\n`);

/** Append TOML tables. An existing table of the same name is never edited. */
export function planToml(
  path: string,
  abs: string,
  blocks: TomlBlock[],
  before: string | null,
): FilePlan {
  const plan = emptyPlan(path, abs, before);
  let text = before ?? "";
  let doc: Json;
  try {
    doc = parseToml(text) as Json;
  } catch {
    for (const b of blocks)
      plan.skipped.push({
        key: b.key,
        reason: "file is not valid TOML; left alone",
      });
    return plan;
  }
  for (const b of blocks) {
    const body = withNewline(b.text);
    if (text.includes(body)) {
      plan.entries.push({ path, key: b.key, sha256: sha256(body) });
      continue;
    }
    const have = getPath(doc, b.table);
    const clash = b.array
      ? have !== undefined && !Array.isArray(have)
      : have !== undefined;
    if (clash) {
      plan.skipped.push({
        key: b.key,
        reason: "already defined in this file; not overwritten",
      });
      continue;
    }
    const sep = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    const next = `${text}${sep}${body}`;
    try {
      doc = parseToml(next) as Json;
    } catch {
      plan.skipped.push({
        key: b.key,
        reason: "result would not parse; skipped",
      });
      continue;
    }
    text = next;
    plan.entries.push({ path, key: b.key, sha256: sha256(body) });
  }
  if (plan.entries.length === 0) return plan;
  plan.after = text;
  plan.changed = text !== before;
  return plan;
}

/** Create a whole file only when it is absent. */
export function planNewFile(
  path: string,
  abs: string,
  content: string,
  before: string | null,
): FilePlan {
  const plan = emptyPlan(path, abs, before);
  if (before === null) {
    plan.after = content;
    plan.changed = true;
    plan.entries.push({ path, key: "(file)", sha256: sha256(content) });
  } else if (before === content) {
    plan.entries.push({ path, key: "(file)", sha256: sha256(content) });
  } else {
    plan.skipped.push({
      key: "(file)",
      reason: "file exists; not overwritten",
    });
  }
  return plan;
}

export function readIfExists(abs: string): string | null {
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/** Small line diff (LCS), `+`/`-` prefixed, two lines of context. */
export function diffLines(before: string | null, after: string): string {
  const a = (before ?? "").split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (dp[i] as number[])[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as number[])[j + 1] as number) + 1
          : Math.max(
              (dp[i + 1] as number[])[j] as number,
              (dp[i] as number[])[j + 1] as number,
            );
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (
      ((dp[i + 1] as number[])[j] as number) >=
      ((dp[i] as number[])[j + 1] as number)
    ) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  const keep = new Set<number>();
  out.forEach((l, k) => {
    if (l.startsWith("+ ") || l.startsWith("- "))
      for (
        let c = Math.max(0, k - 2);
        c <= Math.min(out.length - 1, k + 2);
        c++
      )
        keep.add(c);
  });
  const lines: string[] = [];
  let prev = -2;
  for (const k of [...keep].sort((x, y) => x - y)) {
    if (k !== prev + 1 && lines.length) lines.push("  ...");
    lines.push(out[k] as string);
    prev = k;
  }
  return lines.join("\n");
}

export function previewPlan(p: FilePlan): string {
  const head = `${p.path}${p.before === null ? " (new file)" : ""}`;
  const body = p.changed
    ? diffLines(p.before, p.after)
    : "  (already in place)";
  const skipped = p.skipped.map((s) => `  skipped ${s.key}: ${s.reason}`);
  return [head, body, ...skipped].join("\n");
}

/** Backups of original bytes: `.hawl/backup` in the folder, or the state dir for `~/` files. */
export function backupRoot(path: string, dirs: Dirs): string {
  return path.startsWith("~/")
    ? join(dirs.stateDir, "backup")
    : join(dirs.projectDir, ".hawl", "backup");
}

/** Write a planned file and return the restore record. */
export function applyPlan(p: FilePlan, dirs: Dirs): RestoreRecord | null {
  if (!p.changed) return null;
  let backup: string | undefined;
  if (p.before !== null) {
    backup = `${sha256(p.before).slice(0, 24)}.orig`;
    writeFileDurable(join(backupRoot(p.path, dirs), backup), p.before);
  }
  mkdirSync(dirname(p.abs), { recursive: true });
  writeFileSync(p.abs, p.after);
  return {
    path: p.path,
    before: p.before === null ? null : sha256(p.before),
    after: sha256(p.after),
    backup,
  };
}

export interface RemoveResult {
  removed: string[];
  kept: string[];
}

function pruneEmptyDirs(dir: string, stop: string): void {
  let d = dir;
  while (d.length > stop.length && d.startsWith(stop)) {
    try {
      rmdirSync(d);
    } catch {
      return;
    }
    d = dirname(d);
  }
}

/** Drop objects and lists we emptied. */
function prune(o: Json): void {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (Array.isArray(v) && v.length === 0) delete o[k];
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      prune(v as Json);
      if (Object.keys(v as Json).length === 0) delete o[k];
    }
  }
}

/**
 * Cut the TOML block whose text hashes to `sha`, with the blank line we put before it.
 * Blocks are runs of lines from one table header up to the next header.
 */
function cutBlock(text: string, sha: string): string | null {
  const lines = text.split("\n");
  const offs: number[] = [];
  const heads: number[] = [];
  let off = 0;
  lines.forEach((l, i) => {
    offs.push(off);
    if (/^\s*\[/.test(l)) heads.push(i);
    off += l.length + 1;
  });
  for (let a = 0; a < heads.length; a++) {
    for (let b = a; b < heads.length; b++) {
      const s = offs[heads[a] as number] as number;
      const e =
        b + 1 < heads.length
          ? (offs[heads[b + 1] as number] as number)
          : text.length;
      const chunk = text.slice(s, e);
      const body = withNewline(chunk.replace(/\n+$/, ""));
      if (sha256(body) !== sha) continue;
      const trimmedEnd = s + chunk.replace(/\n+$/, "").length + 1;
      const from = s >= 2 && text.slice(s - 2, s) === "\n\n" ? s - 1 : s;
      return (
        text.slice(0, from) + text.slice(Math.min(trimmedEnd, text.length))
      );
    }
  }
  return null;
}

/**
 * Take back what we wrote. A file nobody touched since goes back to its original bytes (or is
 * deleted if we created it). A file that changed loses only entries whose hash still matches.
 */
export function removeEntries(
  abs: string,
  path: string,
  entries: WrittenEntry[],
  restore: RestoreRecord | undefined,
  dirs: Dirs,
): RemoveResult {
  const res: RemoveResult = { removed: [], kept: [] };
  if (!existsSync(abs)) return res;
  const now = readFileSync(abs, "utf8");
  const all = entries.map((e) => e.key);

  if (restore && sha256(now) === restore.after) {
    if (restore.before === null) {
      rmSync(abs);
      pruneEmptyDirs(dirname(abs), dirs.projectDir);
      res.removed.push(...all);
      return res;
    }
    const f = restore.backup
      ? join(backupRoot(path, dirs), restore.backup)
      : null;
    const orig = f && existsSync(f) ? readFileSync(f, "utf8") : null;
    if (f && orig !== null && sha256(orig) === restore.before) {
      writeFileSync(abs, orig);
      rmSync(f, { force: true });
      res.removed.push(...all);
      return res;
    }
  }

  if (entries.some((e) => e.key === "(file)")) {
    for (const e of entries) {
      if (sha256(now) === e.sha256) {
        rmSync(abs);
        pruneEmptyDirs(dirname(abs), dirs.projectDir);
        res.removed.push(e.key);
      } else res.kept.push(e.key);
    }
    return res;
  }

  if (abs.endsWith(".toml")) {
    let text = now;
    for (const e of entries) {
      const cut = cutBlock(text, e.sha256);
      if (cut === null) res.kept.push(e.key);
      else {
        text = cut;
        res.removed.push(e.key);
      }
    }
    if (text.trim() === "" && restore?.before === null) {
      rmSync(abs);
      pruneEmptyDirs(dirname(abs), dirs.projectDir);
    } else writeFileSync(abs, text);
    return res;
  }

  let doc: Json;
  try {
    doc = JSON.parse(now) as Json;
  } catch {
    res.kept.push(...all);
    return res;
  }
  for (const e of entries) {
    const isAppend = e.key.endsWith("[]");
    const key = (isAppend ? e.key.slice(0, -2) : e.key).split(".");
    const parent = parentOf(doc, key, false);
    const last = key[key.length - 1] as string;
    const have = parent?.[last];
    if (!parent || have === undefined) {
      res.kept.push(e.key);
    } else if (isAppend && Array.isArray(have)) {
      const rest = have.filter((x) => hashValue(x) !== e.sha256);
      if (rest.length === have.length) res.kept.push(e.key);
      else {
        parent[last] = rest;
        res.removed.push(e.key);
      }
    } else if (!isAppend && hashValue(have) === e.sha256) {
      delete parent[last];
      res.removed.push(e.key);
    } else res.kept.push(e.key);
  }
  prune(doc);
  if (Object.keys(doc).length === 0 && restore?.before === null) {
    rmSync(abs);
    pruneEmptyDirs(dirname(abs), dirs.projectDir);
  } else writeFileSync(abs, renderJson(doc));
  return res;
}
