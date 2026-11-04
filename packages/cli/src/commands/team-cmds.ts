/** `hawl board | chat | who | members | invite | share`: team commands (C-CMD-03..06, 10). Rich output; plain under NO_COLOR; `--json` on each. */

import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CliError } from "../cli-errors.ts";
import { colorEnabled, makeStyle, type Style, utf8Enabled } from "../style.ts";
import { openTeam, type Person, type Presence, type Team } from "../team.ts";
import { table } from "../tui/index.ts";

export interface Io {
  out: (s: string) => void;
  st: Style;
  team: Team;
  cwd: string;
}

export function stdStyle(argv: string[] = process.argv): Style {
  return makeStyle(
    colorEnabled({ env: process.env, argv, isTTY: !!process.stdout.isTTY }),
    utf8Enabled(process.platform, process.env),
  );
}

export async function stdIo(argv: string[]): Promise<Io> {
  return {
    out: (s) => process.stdout.write(`${s}\n`),
    st: stdStyle(argv),
    team: await openTeam(),
    cwd: process.cwd(),
  };
}

const arrow = (st: Style) => (st.bullet === "•" ? "→" : "->");
const json = (io: Io, v: unknown) => io.out(JSON.stringify(v, null, 2));

const WORD: Record<Presence, string> = {
  available: "online",
  busy: "busy",
  away: "away",
  offline: "offline",
  invited: "invited, not joined yet",
};
const STATUS: Record<Presence, string> = {
  available: "available",
  busy: "do not disturb",
  away: "away",
  offline: "offline",
  invited: "invited",
};

/** First site the folder joined, else the first one the team shows. */
async function siteOf(
  io: Io,
  wanted?: string,
): Promise<{ name: string; people: Person[] }> {
  const all = await io.team.people();
  let name = wanted;
  if (!name) {
    const { readTownFile } = await import("../town-file.ts");
    name = readTownFile(io.cwd)?.memberships[0]?.town_slug ?? all[0]?.site;
  }
  return { name: name ?? "local", people: all.filter((p) => p.site === name) };
}

/** `hawl who [--site s]` */
export async function who(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { site: { type: "string" }, json: { type: "boolean" } },
  });
  const s = await siteOf(io, values.site);
  if (values.json)
    return (
      json(io, {
        site: s.name,
        people: s.people.map((p) => ({
          name: p.name,
          status: p.presence,
          doing: p.text,
        })),
      }),
      0
    );
  const online = s.people.filter((p) =>
    ["available", "busy", "away"].includes(p.presence),
  ).length;
  io.out(`${io.st.bold(s.name)}: ${online} of ${s.people.length} online`);
  io.out("");
  for (const p of s.people) {
    const w = WORD[p.presence];
    const c =
      p.presence === "available"
        ? io.st.green
        : p.presence === "busy"
          ? io.st.red
          : p.presence === "away"
            ? io.st.yellow
            : io.st.dim;
    io.out(
      `${p.name.padEnd(9)}${p.text ? c(w.padEnd(16)) + io.st.dim(p.text) : c(w)}`,
    );
  }
  return 0;
}

/** `hawl members` */
export async function members(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { site: { type: "string" }, json: { type: "boolean" } },
  });
  const s = await siteOf(io, values.site);
  const me = await io.team.me();
  const real = s.people.filter((p) => p.presence !== "invited");
  const rows = [
    [me.name, "owner", "Dev", STATUS[me.presence]] as string[],
  ].concat(
    real.map((p) => [
      p.name,
      p.role ?? "member",
      p.work ?? "",
      STATUS[p.presence],
    ]),
  );
  const pending = s.people.filter((p) => p.presence === "invited");
  if (values.json)
    return (
      json(io, {
        site: s.name,
        members: rows.map(([name, role, work, status]) => ({
          name,
          role,
          work,
          status,
        })),
        pending: pending.map((p) => p.name),
      }),
      0
    );
  const t = table(["NAME", "ROLE", "WORK", "STATUS"], rows);
  io.out(io.st.dim(t.head));
  for (const r of t.rows) io.out(r);
  if (pending.length)
    io.out(
      io.st.dim(
        `${pending.length} pending invite${pending.length > 1 ? "s" : ""}: ${pending.map((p) => `${p.name.toLowerCase()}@${s.name}.dev`).join(", ")}`,
      ),
    );
  return 0;
}

/** `hawl invite <email> [--role member]` */
export async function invite(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { role: { type: "string" }, json: { type: "boolean" } },
    allowPositionals: true,
  });
  const email = positionals[0];
  if (!email) throw new Error("usage: hawl invite <email> [--role member]");
  const r = await io.team.invite(email, values.role ?? "member");
  if (values.json)
    return json(io, { email, role: values.role ?? "member", link: r.link }), 0;
  io.out(`${io.st.ok} Invite sent to ${io.st.bold(email)}`);
  io.out(`Open ${io.st.cyan(r.link)}`);
  io.out(io.st.dim("The link expires in 7 days."));
  return 0;
}

/** `hawl share [.] --site s | --list | --stop folder` */
export async function share(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      site: { type: "string" },
      list: { type: "boolean" },
      stop: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.list) {
    const rows = await io.team.shares();
    if (values.json) return json(io, rows), 0;
    const t = table(
      ["FOLDER", "SHARED WITH"],
      rows.map((r) => [r.folder, r.with]),
    );
    io.out(io.st.dim(t.head));
    for (const r of t.rows) io.out(r);
    return 0;
  }
  if (values.stop) {
    await io.team.unshare(
      values.stop,
      basename(io.cwd) === values.stop ? io.cwd : resolve(io.cwd, values.stop),
      values.site,
    );
    io.out(
      `${io.st.ok} Stopped sharing ${io.st.bold(values.stop)}. It is private to you again.`,
    );
    return 0;
  }
  if (!values.site) throw new Error("usage: hawl share <folder> --site <site>");
  const dir = resolve(io.cwd, positionals[0] ?? ".");
  const folder = basename(dir);
  const r = await io.team.share(folder, values.site, dir);
  if (values.json)
    return json(io, { folder, site: values.site, pending: r.pending }), 0;
  io.out(
    `${io.st.ok} ${io.st.bold(folder)} is shared with ${values.site}${r.pending ? " once its owner lets you in" : ""}`,
  );
  io.out(
    `People on ${values.site} can see your sessions in this folder. Files you send are scanned first.`,
  );
  if (r.restart)
    io.out("Restart your coding agent in this folder so it picks this up.");
  io.out(io.st.dim(`Stop sharing: hawl share --stop ${folder}`));
  return 0;
}

const PRIO_COLOR = (st: Style, p: string) =>
  p === "urgent" ? st.red : p === "high" ? st.yellow : (s: string) => s;

/** `hawl board [--all] | show <id> | create "<title>" [--prio p] | move <id> <column>` */
export async function board(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      all: { type: "boolean" },
      prio: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const [sub, a, b] = positionals;
  if (sub === "show") {
    if (!a) throw new Error("usage: hawl board show <id>");
    const t = await io.team.ticket(a);
    if (values.json) return json(io, t), 0;
    io.out(`${io.st.bold(`${t.id}:`)} ${t.title}`);
    io.out(
      `${io.st.dim("status:")} ${[t.column, t.prio, t.tags].filter(Boolean).join(", ")}`,
    );
    io.out(
      `${io.st.dim("owner:")} ${t.who}${t.askedBy ? ` (asked by ${t.askedBy})` : ""}`,
    );
    if (t.session) io.out(`${io.st.dim("session:")} ${t.session}`);
    if (t.body) io.out(t.body);
    return 0;
  }
  if (sub === "create") {
    if (!a)
      throw new Error(
        'usage: hawl board create "<title>" [--prio low|med|high|urgent]',
      );
    const r = await io.team.createTicket(a, values.prio ?? "med");
    if (values.json) return json(io, r), 0;
    io.out(`${io.st.ok} Created ${io.st.bold(r.id)} in ${r.column}`);
    return 0;
  }
  if (sub === "move") {
    if (!a || !b) throw new Error("usage: hawl board move <id> <column>");
    const r = await io.team.moveTicket(a, b);
    if (values.json) return json(io, { id: a, ...r }), 0;
    io.out(
      `${io.st.ok} ${io.st.bold(`${a}:`)} ${r.from} ${arrow(io.st)} ${r.to}`,
    );
    return 0;
  }
  if (sub !== undefined)
    throw new Error(
      "usage: hawl board [show <id> | create <title> | move <id> <column>]",
    );
  const { shown, total } = await io.team.board();
  const rows = values.all ? shown : shown.slice(0, 5);
  if (values.json) return json(io, { total, tickets: rows }), 0;
  const t = table(
    ["ID", "COLUMN", "PRIO", "WHO", "TITLE"],
    rows.map((r) => [r.id, r.column, r.prio, r.who, r.title]),
  );
  io.out(io.st.dim(t.head));
  rows.forEach((r, i) => {
    const line = t.rows[i] ?? "";
    // Colour the PRIO cell only: it starts after ID and COLUMN, which are padded to a fixed width.
    const idw = Math.max(2, ...rows.map((x) => x.id.length)) + 2;
    const cw = Math.max(6, ...rows.map((x) => x.column.length)) + 2;
    const pw = Math.max(4, ...rows.map((x) => x.prio.length)) + 2;
    io.out(
      line.slice(0, idw + cw) +
        PRIO_COLOR(io.st, r.prio)(line.slice(idw + cw, idw + cw + pw)) +
        line.slice(idw + cw + pw),
    );
  });
  io.out(io.st.dim(`${rows.length} of ${total} shown. All: hawl board --all`));
  return 0;
}

/** `hawl chat <name> "<text>" | <name> --history` */
export async function chat(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { history: { type: "boolean" }, json: { type: "boolean" } },
    allowPositionals: true,
  });
  const [to, ...text] = positionals;
  if (!to)
    throw new CliError(
      "Who should I message?",
      'Use: hawl chat <name> "<text>"',
      false,
    );
  if (values.history) {
    const th = await io.team.thread(to);
    if (values.json) return json(io, th), 0;
    const nw = Math.max(...th.map((m) => m.who.length)) + 2;
    for (const m of th)
      io.out(
        `${(m.mine ? io.st.bold : io.st.cyan)(m.who.padEnd(nw))}${io.st.dim(m.at.padStart(8))}  ${m.text}`,
      );
    return 0;
  }
  if (!text.length) throw new Error('usage: hawl chat <name> "<text>"');
  const r = await io.team.send(to, text.join(" "));
  if (values.json) return json(io, { to, at: r.at }), 0;
  io.out(`${io.st.ok} Sent to ${io.st.bold(to)} (${r.at})`);
  return 0;
}
