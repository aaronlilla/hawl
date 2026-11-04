/** Bare `hawl` in a terminal: the full-screen AIM-style buddy list (C-AIM-01..08, variant A). */
import { NotWired, openTeam, type Team } from "../team.ts";
import {
  type Key,
  type Paint,
  paint,
  parseKeys,
  Screen,
} from "../tui/index.ts";
import { type Model, renderAim, selectable, type View } from "./render.ts";

const ME = { name: "Aaron", presence: "available" };

/** Everything the screens need, read once per refresh. A missing piece degrades to empty, never a crash. */
export async function loadModel(
  team: Team,
  view: View = "home",
): Promise<Model> {
  const [me, people, sessions, asks, assistant, dispute, rooms] =
    await Promise.all([
      team.me(),
      team.people(),
      team.sessions().catch(() => []),
      team.asks().catch(() => []),
      team.assistant().catch(() => undefined),
      team.dispute().catch(() => null),
      team.rooms().catch(() => []),
    ]);
  return {
    view,
    me,
    people,
    sessions,
    asks,
    sel: 0,
    input: "",
    assistant,
    dispute,
    rooms,
  };
}

/** What a key does. Returns the next model, or null to quit. */
export async function onKey(
  m: Model,
  k: Key,
  team: Team,
): Promise<Model | null> {
  const who = selectable(m.people);
  const ch = k.name === "char" ? k.ch : "";
  if (k.name === "ctrl-c") return null;
  const top = m.asks[0];
  const answerIdx = !top
    ? -1
    : top.yesNo
      ? ["y", "n"].indexOf(ch)
      : /^[1-9]$/.test(ch)
        ? Number(ch) - 1
        : -1;
  const answers = !!top && answerIdx >= 0 && answerIdx < top.options.length;
  // In the question pop-up a key that answers is an answer; anything else starts a typed answer.
  const typing =
    m.view === "chat" ||
    m.view === "assistant" ||
    (m.view === "question" && (m.input !== "" || !answers));
  if (typing && (ch || k.name === "backspace")) {
    return {
      ...m,
      input: k.name === "backspace" ? m.input.slice(0, -1) : m.input + ch,
      notice: undefined,
    };
  }
  if (k.name === "esc")
    return m.view === "home"
      ? m
      : { ...m, view: "home", input: "", notice: undefined };
  if (m.view === "signedout" || m.view === "down") {
    if (ch === "q") return null;
    if (k.name === "enter" || ch === "r")
      return {
        ...m,
        act: ch === "r" ? "retry" : m.view === "down" ? "start" : "signin",
        notice:
          m.view === "down"
            ? "Starting Hawl..."
            : "Opening the sign-in page...",
      };
    return m;
  }
  // 1-3 (or y / n for a yes/no ask) answer the top question, wherever you are.
  if (top && !typing && answers) {
    return {
      ...m,
      view: m.view === "question" ? "home" : m.view,
      asks: m.asks.slice(1),
      notice: `Answered "${top.options[answerIdx]}" to ${top.from}.`,
    };
  }
  if (m.view === "question") {
    if (k.name === "enter" && top && m.input.trim())
      return {
        ...m,
        view: "home",
        asks: m.asks.slice(1),
        input: "",
        notice: `Answered "${m.input.trim()}" to ${top.from}.`,
      };
    return m;
  }
  if (m.view === "chat" || m.view === "assistant") {
    if (k.name === "enter" && m.input.trim()) {
      const to =
        m.view === "chat" ? (m.chatWith?.name ?? "") : "your assistant";
      const r = await team.send(to, m.input.trim());
      const thread =
        m.view === "chat"
          ? [
              ...(m.thread ?? []),
              { who: m.me.name, at: r.at, text: m.input.trim(), mine: true },
            ]
          : m.thread;
      return { ...m, input: "", thread, notice: `Sent to ${to} (${r.at})` };
    }
    return m;
  }
  switch (ch || k.name) {
    case "q":
      return m.view === "home" ? null : { ...m, view: "home" };
    case "up":
      return { ...m, sel: Math.max(0, m.sel - 1) };
    case "down":
      return { ...m, sel: Math.min(who.length - 1, m.sel + 1) };
    case "enter": {
      if (m.view === "needs" && top)
        return { ...m, view: "question", input: "", notice: undefined };
      const pe = who[m.sel];
      if (m.view !== "home" || !pe) return m;
      // No chat-history route for a person yet (MISSING-ROUTES.md): open the pane with what you send now.
      const thread = await team.thread(pe.name).catch((e) => {
        if (e instanceof NotWired) return [];
        throw e;
      });
      return {
        ...m,
        view: "chat",
        chatWith: pe,
        thread,
        readAt: team.fake ? "2:28 PM" : undefined,
        input: "",
        notice: undefined,
      };
    }
    case "i":
    case "a":
      return {
        ...m,
        notice: "Full info and ticket assignment open in the web app.",
      };
    case "n":
      return { ...m, view: "needs" };
    case "t":
      return { ...m, view: "assistant" };
    case "d":
      return { ...m, view: "dispute" };
    case "r":
      return { ...m, view: "rooms" };
    case "?":
      return { ...m, view: "help" };
    case "/":
      return { ...m, notice: "Type a name to find someone (coming next)." };
    default:
      return m;
  }
}

/** Snapshot of one screen to a string, for proof and tests: `home`, `chat`, `chat-queued`, `narrow`, `signedout`... optionally `:COLSxROWS`. */
export async function snapshot(
  spec: string,
  team: Team,
  p: Paint,
): Promise<string> {
  const [name = "home", size = ""] = spec.split(":");
  const [c, r] = size.split("x").map(Number);
  const cols = c || (name === "narrow" ? 80 : 120);
  const rows = r || (name === "narrow" ? 34 : 30);
  const view = (
    name === "narrow" || name === "chat-queued"
      ? name === "narrow"
        ? "home"
        : "chat"
      : name
  ) as View;
  let m = await loadModel(team, view === "chat" ? "home" : view);
  if (name === "chat" || name === "chat-queued") {
    const pe = m.people.find(
      (x) => x.name === (name === "chat" ? "Riley" : "Sam"),
    );
    m = {
      ...m,
      view: "chat",
      chatWith: pe,
      thread: await team.thread(pe?.name ?? ""),
      readAt: team.fake ? "2:28 PM" : undefined,
    };
  }
  if (name === "loading")
    m = {
      ...m,
      me: ME,
      steps: [
        { text: "service running", done: true },
        { text: "signed in as Aaron", done: true },
        { text: "loading acme and northwind", done: false },
      ],
    };
  if (name === "down") m = { ...m, lastConnected: "2:12 PM" };
  return `${renderAim(m, cols, rows, p).join("\n")}\n`;
}

export async function runAim(
  env: Record<string, string | undefined> = process.env,
  io: { out: NodeJS.WriteStream; inp: NodeJS.ReadStream } = {
    out: process.stdout,
    inp: process.stdin,
  },
): Promise<number> {
  const color = !env.NO_COLOR && env.TERM !== "dumb";
  const p = paint(color, true);
  const team = await openTeam(env);
  const screen = new Screen({
    write: (s) => io.out.write(s),
    cols: () => io.out.columns || 80,
    rows: () => io.out.rows || 24,
  });
  let m: Model;
  try {
    m = await loadModel(team);
  } catch (e) {
    const msg = (e as Error).message;
    m = {
      view: /running|socket|ENOENT|ECONN/i.test(msg) ? "down" : "signedout",
      me: ME,
      people: [],
      sessions: [],
      asks: [],
      sel: 0,
      input: "",
    };
  }
  screen.enter();
  io.inp.setRawMode?.(true);
  io.inp.setEncoding("utf8");
  io.inp.resume();
  const draw = () =>
    screen.draw(renderAim(m, io.out.columns || 80, io.out.rows || 24, p));
  draw();
  return new Promise((resolve) => {
    const done = (code: number) => {
      io.inp.setRawMode?.(false);
      io.inp.pause();
      screen.leave();
      resolve(code);
    };
    io.out.on("resize", () => {
      screen.invalidate();
      draw();
    });
    io.inp.on("data", async (chunk: string) => {
      for (const k of parseKeys(chunk)) {
        const next = await onKey(m, k, team).catch((e: Error) => ({
          ...m,
          notice: e.message,
        }));
        if (next === null) return done(0);
        m = next;
      }
      draw();
      const act = m.act;
      if (act) {
        m = { ...m, act: undefined };
        if (act === "start") {
          const { spawnDaemon } = await import("../commands/join.ts");
          const { defaultStateDir } = await import("../daemon/main.ts");
          await spawnDaemon(defaultStateDir()).catch(() => undefined);
        } else if (act === "signin")
          await (await import("../open-url.ts")).openUrl(
            "https://hawl.ai/device",
          );
        m = await loadModel(team).catch(() => ({
          ...m,
          notice: "Still not reachable.",
        }));
        draw();
      }
    });
  });
}
