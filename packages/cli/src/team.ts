/**
 * What the team commands and the full-screen `hawl` read and write. ONE switch picks the source:
 * HAWL_DATA=fake  fixed sample team (the design's Aaron / acme / northwind), no helper needed;
 * anything else   the helper's socket (the real daemon, or `hawl local`) through the tool path.
 * Routes the relay has no tool for yet throw `NotWired` and the command says so plainly.
 */
import { basename } from "node:path";
import { callTool, folderWorker, type Link } from "./api/tool-call.ts";
import { CliError, notSignedIn, serviceNotRunning } from "./cli-errors.ts";
import { readTownFile } from "./town-file.ts";

export type Presence = "available" | "busy" | "away" | "offline" | "invited";

export interface Person {
  name: string;
  presence: Presence;
  /** Away message or what they are doing. */
  text: string;
  site: string;
  unread: number;
  role?: string;
  work?: string;
  sites?: string;
  openTo?: string;
  localTime?: string;
  live?: { glyph: "▸" | "✳"; label: string; text: string }[];
}

export interface Ask {
  id: string;
  from: string;
  text: string;
  at: string;
  /** Number-key answers; a yes/no ask uses y and n. */
  options: string[];
  yesNo?: boolean;
  recommended?: number;
}

export interface Msg {
  who: string;
  at: string;
  text: string;
  mine?: boolean;
  /** "(Riley is away)" style tag on an assistant reply. */
  assistantOf?: string;
}

export interface Dispute {
  ticket: string;
  round: number;
  of: number;
  lines: { who: string; text: string }[];
  options: string[];
}

export interface SessionChip {
  label: string;
  state: "ok" | "ask" | "idle";
}

export interface Ticket {
  id: string;
  column: string;
  prio: "urgent" | "high" | "med" | "low";
  who: string;
  title: string;
  tags?: string;
  askedBy?: string;
  session?: string;
  body?: string;
}

export interface Team {
  readonly fake: boolean;
  me(): Promise<{ name: string; presence: Presence }>;
  people(): Promise<Person[]>;
  sessions(): Promise<SessionChip[]>;
  asks(): Promise<Ask[]>;
  thread(person: string): Promise<Msg[]>;
  assistant(): Promise<{
    where: string;
    lines: { glyph: "●" | "◌" | " "; text: string }[];
  }>;
  dispute(): Promise<Dispute | null>;
  rooms(): Promise<{ name: string; detail: string; huddle?: boolean }[]>;
  send(person: string, text: string): Promise<{ at: string }>;
  board(): Promise<{ shown: Ticket[]; total: number }>;
  ticket(id: string): Promise<Ticket>;
  createTicket(
    title: string,
    prio: string,
  ): Promise<{ id: string; column: string }>;
  moveTicket(id: string, to: string): Promise<{ from: string; to: string }>;
  invite(
    email: string,
    role: string,
  ): Promise<{ link: string; pending: string[] }>;
  shares(): Promise<{ folder: string; with: string }[]>;
  /** `dir` is the folder's path; sharing a folder with a site is joining it to the site. */
  share(
    folder: string,
    site: string,
    dir?: string,
  ): Promise<{ pending: boolean; restart: boolean }>;
  /** `site` is needed when the folder is shared with more than one. */
  unshare(folder: string, dir?: string, site?: string): Promise<void>;
}

export class NotWired extends CliError {
  constructor(what: string) {
    super(
      `${what} isn't connected to the relay from the terminal yet.`,
      "Use the web app for now.",
      false,
    );
  }
}

// ---- fixtures (the design's sample team) ----

const PEOPLE: Person[] = [
  {
    name: "Riley",
    presence: "available",
    text: "reviewing PR #44",
    site: "acme",
    unread: 3,
    role: "member",
    work: "Dev, QA",
    sites: "acme (Dev, QA) · northwind (Dev)",
    openTo: "Code review, Refunds, Go",
    localTime: "2:31 PM in Chicago",
    live: [
      { glyph: "▸", label: "shop-web · pr-44", text: "reviewing PR #44" },
      { glyph: "✳", label: "shop-web · refunds", text: "running refund tests" },
      { glyph: "▸", label: "ledger · main", text: "editing partial.go" },
    ],
  },
  {
    name: "Haiping",
    presence: "busy",
    text: "Heads down till 4",
    site: "acme",
    unread: 1,
    role: "member",
    work: "Dev",
  },
  {
    name: "Dana",
    presence: "away",
    text: "Lunch, back at 3",
    site: "acme",
    unread: 1,
    role: "member",
    work: "PM",
  },
  {
    name: "Sam",
    presence: "offline",
    text: "",
    site: "acme",
    unread: 0,
    role: "member",
    work: "QA",
  },
  { name: "Jo", presence: "invited", text: "", site: "acme", unread: 0 },
  {
    name: "Mei",
    presence: "available",
    text: "fixing the CSV import",
    site: "northwind",
    unread: 2,
    role: "member",
    work: "Dev",
  },
  {
    name: "Kai",
    presence: "available",
    text: "writing standup notes",
    site: "northwind",
    unread: 0,
    role: "member",
    work: "Dev",
  },
  {
    name: "Lee",
    presence: "offline",
    text: "",
    site: "northwind",
    unread: 0,
    role: "member",
    work: "Dev",
  },
  {
    name: "Ana",
    presence: "offline",
    text: "",
    site: "northwind",
    unread: 0,
    role: "member",
    work: "QA",
  },
];

const TICKETS: Ticket[] = [
  {
    id: "ACME-214",
    column: "In progress",
    prio: "urgent",
    who: "Aaron",
    title: "Move /v1 order callers to /v2",
  },
  {
    id: "ACME-219",
    column: "To do",
    prio: "high",
    who: "Aaron",
    title: "Retry failed refund webhooks",
    tags: "api refunds",
    askedBy: "Riley",
    session: "Your assistant, working",
    body: "Webhook retries 3 times with backoff, then records a failed refund.",
  },
  {
    id: "ACME-216",
    column: "In progress",
    prio: "high",
    who: "Aaron",
    title: "Update the checkout error copy",
  },
  {
    id: "ACME-213",
    column: "Checking",
    prio: "high",
    who: "Riley",
    title: "Show refund status on order",
  },
  {
    id: "ACME-220",
    column: "To do",
    prio: "med",
    who: "Riley",
    title: "Paginate the refunds list",
  },
];
const COLUMN_ALIAS: Record<string, string> = {
  backlog: "Backlog",
  todo: "To do",
  doing: "In progress",
  check: "Checking",
  checking: "Checking",
  done: "Done",
};
const TOTAL_TICKETS = 14;

const THREAD: Msg[] = [
  {
    who: "Aaron",
    at: "12:04 PM",
    text: "Is the refunds table migration merged?",
    mine: true,
  },
  {
    who: "Riley's assistant",
    at: "12:05 PM",
    text: "Yes, merged at 11:52 AM in shop-api · main.",
    assistantOf: "Riley is away",
  },
  { who: "Riley", at: "2:24 PM", text: "Back. Can you take ACME-219 today?" },
  {
    who: "Aaron",
    at: "2:26 PM",
    text: "Yes. My assistant took it and is on it now.",
    mine: true,
  },
];

export function fakeTeam(): Team {
  const tickets = TICKETS.map((t) => ({ ...t }));
  const shares = [
    { folder: "shop-api", with: "acme" },
    { folder: "shop-web", with: "acme" },
    { folder: "infra", with: "private to you" },
    { folder: "notes", with: "private to you" },
  ];
  return {
    fake: true,
    async me() {
      return { name: "Aaron", presence: "available" };
    },
    async people() {
      return PEOPLE;
    },
    async sessions() {
      return [
        { label: "Your assistant", state: "ok" },
        { label: "shop-api · orders-v2", state: "ok" },
        { label: "shop-web · checkout-copy", state: "ask" },
        { label: "infra · main", state: "idle" },
      ];
    },
    async asks() {
      return [
        {
          id: "a1",
          from: "shop-web",
          text: "Ship the new checkout copy to all 3 regions now?",
          at: "2:29 PM",
          options: ["All 3 regions", "US first", "Hold"],
          recommended: 2,
        },
        {
          id: "a2",
          from: "Dana's assistant",
          text: "Can you check the refunds help page before 4:00 PM?",
          at: "2:18 PM",
          options: ["Yes", "Not today"],
          yesNo: true,
        },
      ];
    },
    async thread(person) {
      return person.toLowerCase() === "sam"
        ? [
            {
              who: "Aaron",
              at: "2:30 PM",
              text: "Can you send me the import file when you are on?",
              mine: true,
            },
          ]
        : THREAD.map((m) => ({ ...m }));
    },
    async assistant() {
      return {
        where: "shop-api · main",
        lines: [
          { glyph: "●", text: "Watching the acme board." },
          { glyph: "●", text: "Took ACME-219 from Riley, 2:26 PM." },
          { glyph: "◌", text: "Editing refunds/webhook.ts" },
          { glyph: " ", text: "Working for 4 min" },
          {
            glyph: " ",
            text: "Riley 2:27 PM asked you: Is the retry fix in today?",
          },
          { glyph: "●", text: "Answered for you: yes, by 4:00 PM." },
        ],
      };
    },
    async dispute() {
      return {
        ticket: "ACME-215",
        round: 2,
        of: 3,
        lines: [
          { who: "Riley", text: "the retry should wait 3 times." },
          {
            who: "Riley's assistant",
            text: "3 retries match the payment provider's own limit.",
          },
          { who: "You", text: "5 retries, the provider allows it." },
          {
            who: "Your assistant",
            text: "5 retries still stay under the provider limit and fix the failing orders.",
          },
        ],
        options: ["Riley's way", "My way", "Talk it over"],
      };
    },
    async rooms() {
      return [
        { name: "acme room", detail: "3 here  2 unread" },
        {
          name: "Voice huddle · refunds",
          detail: "3 talking  Enter join",
          huddle: true,
        },
      ];
    },
    async send() {
      return { at: "2:28 PM" };
    },
    async board() {
      return { shown: tickets, total: TOTAL_TICKETS };
    },
    async ticket(id) {
      const t = tickets.find((x) => x.id.toLowerCase() === id.toLowerCase());
      if (!t)
        throw new CliError(`No ticket ${id}.`, "List them: hawl board", false);
      return t;
    },
    async createTicket(title, prio) {
      const id = "ACME-225";
      tickets.push({
        id,
        column: "Backlog",
        prio: (prio as Ticket["prio"]) || "med",
        who: "Aaron",
        title,
      });
      return { id, column: "Backlog" };
    },
    async moveTicket(id, to) {
      const t = await this.ticket(id);
      const col = COLUMN_ALIAS[to.toLowerCase()] ?? to;
      const from = t.column;
      t.column = col;
      return { from, to: col };
    },
    async invite() {
      return { link: "hawl.ai/i/k7f2-9xqm", pending: ["jo@acme.dev"] };
    },
    async shares() {
      return shares;
    },
    async share(folder, site) {
      shares.push({ folder, with: site });
      return { pending: false, restart: false };
    },
    async unshare(folder) {
      const s = shares.find((x) => x.folder === folder);
      if (s) s.with = "private to you";
    },
  };
}

// ---- the helper's socket ----

const PRESENCE: Record<string, Presence> = {
  online: "available",
  available: "available",
  working: "busy",
  busy: "busy",
  idle: "away",
  away: "away",
  offline: "offline",
};

/** Tool-backed team: `who`, `handoff_list`, `dm_send` through the helper (real daemon or `hawl local`). */
export function socketTeam(
  link: Link,
  projectDir: string,
  stateDir?: string,
): Team {
  const rid = folderWorker(projectDir);
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    if (!rid) throw notSignedIn();
    const r = await callTool(
      link,
      { residentId: rid, cwd: projectDir },
      name,
      args,
    );
    if (!r.ok)
      throw /daemon is not running/.test(r.error)
        ? serviceNotRunning()
        : new CliError(r.error);
    return r.result as Record<string, unknown>;
  };
  const wired = (what: string) => async (): Promise<never> => {
    throw new NotWired(what);
  };
  return {
    fake: false,
    async me() {
      const st = (await link.call("status").catch(() => {
        throw serviceNotRunning();
      })) as { workers: { resident_id: string; handle?: string }[] };
      const w = st.workers.find((x) => x.resident_id === rid) ?? st.workers[0];
      return {
        name: w?.handle?.replace(/^@/, "") ?? "You",
        presence: "available",
      };
    },
    async people() {
      const r = (await tool("who")) as {
        workers?: {
          handle: string;
          status?: string;
          working_on?: string;
          owner_display?: string;
        }[];
      };
      return (r.workers ?? []).map((w) => ({
        name: w.handle.replace(/^@/, ""),
        presence: PRESENCE[(w.status ?? "").toLowerCase()] ?? "available",
        text: w.working_on ?? "",
        site: w.owner_display ?? "local",
        unread: 0,
      }));
    },
    async sessions() {
      return [];
    },
    async asks() {
      return [];
    },
    async assistant() {
      return { where: projectDir.split(/[\/]/).pop() ?? "", lines: [] };
    },
    async dispute() {
      return null;
    },
    async rooms() {
      return [];
    },
    thread: wired("Chat history"),
    async send(person, text) {
      await tool("dm_send", {
        to: person.startsWith("@") ? person : `@${person}`,
        text,
      });
      return {
        at: new Date().toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        }),
      };
    },
    async board() {
      const r = (await tool("handoff_list")) as {
        handoffs?: {
          handoff_id: string;
          state: string;
          title: string;
          assignee?: string;
        }[];
      };
      const all = r.handoffs ?? [];
      return {
        total: all.length,
        shown: all.slice(0, 5).map((h) => ({
          id: h.handoff_id,
          column: h.state,
          prio: "med" as const,
          who: h.assignee ?? "",
          title: h.title,
        })),
      };
    },
    ticket: wired("Ticket details"),
    createTicket: wired("Creating tickets"),
    moveTicket: wired("Moving tickets"),
    invite: wired("Inviting people"),
    // Folders this PC joined (folders.json, written by join) plus this one; the relay has no per-PC list.
    async shares() {
      const sd =
        stateDir ?? (await import("./daemon/main.ts")).defaultStateDir();
      const { liveFolders, rememberFolder } = await import("./folders.ts");
      if (readTownFile(projectDir)?.memberships.length)
        rememberFolder(sd, projectDir);
      return liveFolders(sd).map((d) => {
        const town = readTownFile(d);
        return {
          folder: town?.folder_label || basename(d),
          with:
            town?.memberships.map((m) => m.town_slug).join(", ") ||
            "private to you",
        };
      });
    },
    async share(folder, site, dir) {
      const { join } = await import("./commands/join.ts");
      // Joins the folder to the site: no questions, no tool updates, no machine-level install.
      const r = await join({
        site,
        hosts: [],
        projectDir: dir ?? projectDir,
        folderLabel: folder,
        folderOnly: true,
        installTools: "none",
        skills: "none",
      });
      return { pending: r.needs_owner_approval, restart: r.written > 0 };
    },
    async unshare(folder, dir, site) {
      const { leave } = await import("./commands/leave.ts");
      await leave({ projectDir: dir ?? projectDir, ...(site ? { site } : {}) });
    },
  };
}

/** The one switch. `link` is only needed when HAWL_DATA is not `fake`. */
export async function openTeam(
  env: Record<string, string | undefined> = process.env,
  projectDir = process.cwd(),
): Promise<Team> {
  if (env.HAWL_DATA === "fake") return fakeTeam();
  const { daemonLinkFor } = await import("./commands/join.ts");
  const { defaultStateDir } = await import("./daemon/main.ts");
  return socketTeam(
    daemonLinkFor(defaultStateDir()),
    projectDir,
    defaultStateDir(),
  );
}
