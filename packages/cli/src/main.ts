import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { COMMAND_HELP, suggest, TOP_HELP, usageLine } from "./help.ts";
import {
  colorEnabled,
  makeStyle,
  type Style,
  utf8Enabled,
  wrap,
} from "./style.ts";

declare const __HAWL_VERSION__: string | undefined;

/** Version baked in by the bundlers; falls back to package.json when run from source. */
export function cliVersion(): string {
  if (typeof __HAWL_VERSION__ === "string") return __HAWL_VERSION__;
  try {
    const f = fileURLToPath(new URL("../package.json", import.meta.url));
    return (JSON.parse(readFileSync(f, "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

/** Absolute path of the built entry (`dist/main.js`). CI-3 runs `node $HAWL_CLI`. */
export const HAWL_CLI: string = (() => {
  try {
    return fileURLToPath(new URL("../dist/main.js", import.meta.url));
  } catch {
    return resolve(process.argv[1] ?? "dist/main.js");
  }
})();

export const HELP = TOP_HELP;

/** A handler returns the exit code. `undefined` means a long-lived command: keep the process running. */
export type Handler = (argv: string[]) => Promise<number | undefined>;

export const COMMANDS = [
  "join",
  "leave",
  "claude",
  "wake",
  "config",
  "status",
  "doctor",
  "agents",
  "mcp",
  "hook",
  "daemon",
  "autostart",
  "local",
  "update",
  "skills",
] as const;
export type Command = (typeof COMMANDS)[number];
export type Handlers = Record<Command, Handler>;

export interface MainIo {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Output is a terminal (colour allowed). Default false. */
  isTTY?: boolean;
  /** Stdin is a terminal (a person is typing). Default false. */
  stdinIsTTY?: boolean;
  env?: Record<string, string | undefined>;
}

const stdIo: MainIo = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  isTTY: !!process.stdout.isTTY,
  stdinIsTTY: !!process.stdin.isTTY,
  env: process.env,
};

/** Bold the headings, usage word and command names; dim the last line (S-424). */
export function styleHelp(text: string, st: Style): string {
  if (!st.color) return text;
  const lines = text.replace(/\n$/, "").split("\n");
  const last = lines.length - 1;
  const out = lines.map((l, i) => {
    if (/^[A-Z][a-z]+$/.test(l)) return st.bold(l);
    if (l.startsWith("Usage:")) return `${st.bold("Usage:")}${l.slice(6)}`;
    if (i === last && l.startsWith("Help:")) return st.dim(l);
    const m = /^( {2}[a-z][a-z-]*(?: <[a-z]+>|\|\S+)?)( +)(.*)$/.exec(l);
    const head = m?.[1];
    return head === undefined ? l : st.bold(head) + l.slice(head.length);
  });
  return `${out.join("\n")}\n`;
}

function isUsageError(e: unknown): boolean {
  const code = (e as { code?: string }).code ?? "";
  return (
    code.startsWith("ERR_PARSE_ARGS") ||
    /^usage: /.test((e as Error).message ?? "")
  );
}

const PLUMBING = ["mcp", "hook", "daemon"];

/** Route argv (without node and script) to a handler. Returns the exit code, or undefined to keep running. */
export async function main(
  argv: string[],
  handlers: Handlers = defaultHandlers,
  io: MainIo = stdIo,
): Promise<number | undefined> {
  const env = io.env ?? {};
  const st = makeStyle(
    colorEnabled({ env, argv, isTTY: !!io.isTTY }),
    utf8Enabled(process.platform, env),
  );
  const [cmd, ...rest] = argv.filter((a) => a !== "--no-color");
  if (cmd === "--version" || cmd === "-v") {
    io.out(`${cliVersion()}\n`);
    return 0;
  }
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    io.out(styleHelp(TOP_HELP, st));
    return 0;
  }
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    const near = suggest(
      cmd,
      COMMANDS.filter((c) => !PLUMBING.includes(c)),
    );
    io.err(
      `${st.fail} "${cmd}" isn't a hawl command.${near ? ` Did you mean "${near}"?` : ""}\nRun hawl --help to see all commands.\n`,
    );
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(styleHelp(COMMAND_HELP[cmd] ?? usageLine(cmd), st));
    return 0;
  }
  if (cmd === "mcp" && io.stdinIsTTY) {
    io.err(
      `${st.fail} This command is started by your agent tool, not typed. See hawl doctor.\n`,
    );
    return 2;
  }
  try {
    return await handlers[cmd as Command](rest);
  } catch (e) {
    const msg = (e as Error).message.replace(/\.$/, "");
    if (isUsageError(e)) {
      const what = /^usage: /.test(msg) ? "Missing or wrong argument" : msg;
      io.err(wrap(`${st.fail} ${what}.\n${st.dim(usageLine(cmd))}\n`));
      return 2;
    }
    io.err(
      wrap(`${st.fail} ${msg}.\n${st.dim("Still stuck? Run hawl doctor.")}\n`),
    );
    return 1;
  }
}

type OptSpec = Record<
  string,
  { type: "string" | "boolean"; multiple?: boolean; short?: string }
>;

function parse<T extends OptSpec>(argv: string[], options: T) {
  return parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: true,
  });
}

/** `sam`, `@sam` or a folder name like `my app` -> a valid local handle (`@sam`, `@my-app`). */
export function localHandle(raw: string): string {
  const name = raw
    .replace(/^@+/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return `@${name || "worker"}`;
}

function scopeOf(v: string | undefined): "global" | "project" | undefined {
  if (v === undefined) return undefined;
  if (v !== "global" && v !== "project")
    throw new Error('--skills-scope must be "global" or "project"');
  return v;
}

export const defaultHandlers: Handlers = {
  async join(argv) {
    const { values, positionals } = parse(argv, {
      host: { type: "string", multiple: true },
      local: { type: "boolean" },
      handle: { type: "string" },
      label: { type: "string" },
      "as-yard": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      "no-wait": { type: "boolean" },
      "no-open": { type: "boolean" },
      "no-browser": { type: "boolean" },
      skills: { type: "string" },
      "skills-scope": { type: "string" },
    });
    const skillsScope = scopeOf(values["skills-scope"]);
    if (values.local) {
      const { joinLocal } = await import("./commands/join-local.ts");
      const projectDir = process.cwd();
      const r = await joinLocal({
        projectDir,
        dir: process.env.HAWL_HOME,
        handle: localHandle(
          values.handle ?? (basename(projectDir) || "worker"),
        ),
        host: values.host?.[0] as
          | "claude_code"
          | "cursor"
          | "codex"
          | undefined,
      });
      const { selfInstall } = await import("./install/self-install.ts");
      const { setAutostart } = await import("./autostart/index.ts");
      const { defaultLocalDir } = await import("./local/log.ts");
      const dir = process.env.HAWL_HOME ?? defaultLocalDir();
      const { localHubRunning, spawnLocalHub } = await import(
        "./local/server.ts"
      );
      if (!(await localHubRunning(dir))) spawnLocalHub(dir);
      const installed = selfInstall();
      if (installed.warning) process.stderr.write(`${installed.warning}\n`);
      for (const f of r.projectSkills.removed)
        process.stdout.write(
          `Removed ${f} (an older hawl wrote it here; skills are optional now).\n`,
        );
      for (const k of r.projectSkills.kept)
        process.stdout.write(`Kept ${k}: changed since we wrote it\n`);
      {
        const { offerSkills } = await import("./commands/skills.ts");
        const { createInterface } = await import("node:readline/promises");
        await offerSkills(
          { projectDir, print: (l) => process.stdout.write(`${l}\n`) },
          {
            skills: values.skills,
            skillsScope,
            interactive: !values.yes && process.stdin.isTTY === true,
            ask: async (q) => {
              const rl = createInterface({
                input: process.stdin,
                output: process.stdout,
              });
              try {
                return await rl.question(q);
              } finally {
                rl.close();
              }
            },
          },
        );
      }
      try {
        await setAutostart(true, { command: "local", stateDir: dir });
      } catch (e) {
        process.stderr.write(`Autostart is off: ${(e as Error).message}.\n`);
      }
      process.stdout.write(
        `joined local as ${r.handle} (${r.resident_id}); config: ${r.config}\nLocal mode: your agents on this machine only. To add teammates, run \`npx hawl.ai join <site>\`.\n`,
      );
      return 0;
    }
    const site = positionals[0];
    if (!site) throw new Error("usage: hawl join <site-url|slug>");
    // No keyboard means yes (S-427), and so does --no-wait.
    const yes =
      values.yes === true ||
      values["no-wait"] === true ||
      process.stdin.isTTY !== true;
    if (values["no-wait"]) {
      const { joinNoWait } = await import("./commands/join.ts");
      await joinNoWait([
        "join",
        site,
        ...(values.host ?? []).flatMap((h) => ["--host", h]),
        "--yes",
      ]);
      return 0;
    }
    const { join } = await import("./commands/join.ts");
    await join(
      {
        site,
        hosts: values.host ?? [],
        projectDir: process.cwd(),
        yes,
        skills: values.skills,
        skillsScope,
        noOpen: values["no-open"] === true || values["no-browser"] === true,
      },
      { version: cliVersion() },
    );
    return 0;
  },
  async skills(argv) {
    const { values, positionals } = parse(argv, {
      global: { type: "boolean" },
      project: { type: "boolean" },
    });
    if (values.global && values.project)
      throw new Error("pick --global or --project, not both");
    const scope = values.project ? "project" : "global";
    const sub = positionals[0] ?? "list";
    const { skillsAdd, skillsList, skillsRemove, parseNames } = await import(
      "./commands/skills.ts"
    );
    const io = {
      projectDir: process.cwd(),
      print: (l: string) => process.stdout.write(`${l}\n`),
    };
    const names = parseNames(positionals.slice(1).join(",") || "all");
    if (sub === "list") skillsList(io);
    else if (sub === "add") skillsAdd(io, names, scope);
    else if (sub === "remove") skillsRemove(io, names, scope);
    else
      throw new Error(
        "usage: hawl skills list|add|remove [names|all] [--global|--project]",
      );
    return 0;
  },
  async leave(argv) {
    const { values } = parse(argv, {
      site: { type: "string" },
      all: { type: "boolean" },
    });
    const { leave } = await import("./commands/leave.ts");
    const r = await leave({
      projectDir: process.cwd(),
      site: values.site,
      all: values.all,
    });
    process.stdout.write(`left: ${r.left.join(", ") || "nothing"}\n`);
    return 0;
  },
  async claude(argv) {
    // Everything after `hawl claude` goes to Claude Code untouched.
    const { claude } = await import("./commands/claude.ts");
    return claude(argv);
  },
  async wake(argv) {
    const { positionals } = parse(argv, {});
    const mode = positionals[0];
    if (mode !== "on" && mode !== "off")
      throw new Error("usage: hawl wake on|off");
    const { wake } = await import("./commands/wake.ts");
    await wake({ projectDir: process.cwd(), on: mode === "on" });
    return 0;
  },
  async config(argv) {
    const { positionals } = parse(argv, {});
    const [key, mode] = positionals;
    if (
      (key !== "stop-hook" && key !== "wake") ||
      (mode !== "on" && mode !== "off")
    )
      throw new Error("usage: hawl config stop-hook|wake on|off");
    if (key === "wake") {
      const { findJoinedRoot } = await import("./resolve.ts");
      const { wake } = await import("./commands/wake.ts");
      await wake({
        projectDir: findJoinedRoot(process.cwd()) ?? process.cwd(),
        on: mode === "on",
      });
      return 0;
    }
    const { setStopHook } = await import("./commands/config.ts");
    setStopHook({ projectDir: process.cwd(), on: mode === "on" });
    return 0;
  },
  async status(argv) {
    const { values } = parse(argv, { json: { type: "boolean" } });
    const { status } = await import("./commands/status.ts");
    await status({ projectDir: process.cwd(), json: values.json });
    return 0;
  },
  async doctor(argv) {
    const { values } = parse(argv, { fix: { type: "boolean" } });
    const { doctor } = await import("./commands/doctor.ts");
    return (await doctor({ projectDir: process.cwd(), fix: values.fix }))
      .exitCode;
  },
  async agents(argv) {
    const { values } = parse(argv, { json: { type: "boolean" } });
    const { agents } = await import("./commands/agents.ts");
    return (await agents({ cwd: process.cwd(), json: values.json })).exitCode;
  },
  async mcp(argv) {
    const { values } = parse(argv, {
      host: { type: "string" },
      local: { type: "boolean" },
    });
    // Folder -> site -> worker (resolve.ts): nearest joined folder up from cwd, with
    // HAWL_RESIDENT_ID / HAWL_SITE as per-session overrides.
    const { readProjectId } = await import("./project-id.ts");
    const found = values.host ? readProjectId(values.host) : null;
    const route =
      values.host && !values.local
        ? (await import("./resolve.ts")).resolveRoute(process.cwd(), {
            host: values.host,
          })
        : null;
    const residentId =
      route?.resident_id ?? process.env.HAWL_RESIDENT_ID ?? found?.resident_id;
    if (!residentId) {
      if (values.host && !values.local) {
        // The machine-wide entry loads in every folder: outside a joined one it serves no
        // tools instead of failing, so the host shows no broken server.
        const { runUnjoinedMcp } = await import("./mcp/server.ts");
        runUnjoinedMcp();
        return undefined;
      }
      throw new Error(
        "no worker id: run `hawl join` in this folder (expected .hawl/<tool>.json)",
      );
    }
    if (values.local) {
      const { runLocalMcp } = await import("./local/server.ts");
      const { defaultLocalDir } = await import("./local/log.ts");
      runLocalMcp(
        process.env.HAWL_HOME ?? found?.hawl_home ?? defaultLocalDir(),
        residentId,
      );
      return undefined;
    }
    if (!values.host) throw new Error("usage: hawl mcp --host <h>");
    const { runMcp, daemonLink } = await import("./mcp/server.ts");
    // The MCP process signs its own messages with the worker key (spec 16 2.4); the daemon
    // never hands a private key out.
    const { defaultStateDir } = await import("./daemon/main.ts");
    const { loadLocalSigner, openKeyStore } = await import("./daemon/keys.ts");
    const store = await openKeyStore({
      stateDir: defaultStateDir(),
      passphrase: process.env.HAWL_PASSPHRASE,
    });
    const signer = (await loadLocalSigner(store, residentId)) ?? undefined;
    await runMcp({
      daemon: daemonLink(),
      residentId,
      host: values.host,
      ...(route && { cwd: route.root }),
      ...(signer ? { signer } : {}),
    });
    return undefined;
  },
  async hook(argv) {
    const { positionals, values } = parse(argv, {
      scope: { type: "string" },
    });
    const { runHook } = await import("./hook/hook.ts");
    try {
      // 2 only from the Wake waiter: Claude Code wakes the idle session on it.
      return await runHook(
        positionals[0] ?? "",
        positionals[1] ?? "",
        values.scope === "user" ? "user" : "project",
      );
    } catch {
      // a hook never fails the host
      return 0;
    }
  },
  async daemon(argv) {
    const { positionals } = parse(argv, { foreground: { type: "boolean" } });
    const action = positionals[0];
    if (action !== undefined && action !== "start" && action !== "stop")
      throw new Error("usage: hawl daemon [start|stop]");
    if (action !== undefined) {
      // The tray's Start and Stop. `start` runs the helper in the background and returns.
      const { daemonLinkFor, spawnDaemon } = await import("./commands/join.ts");
      const { defaultStateDir } = await import("./daemon/main.ts");
      const stateDir = defaultStateDir();
      if (action === "start") {
        await spawnDaemon(stateDir);
        process.stdout.write("hawl helper running\n");
        return 0;
      }
      try {
        await daemonLinkFor(stateDir).call("shutdown");
      } catch {
        process.stdout.write("hawl helper was not running\n");
        return 0;
      }
      process.stdout.write("hawl helper stopped\n");
      return 0;
    }
    const { startDaemon, DaemonRunningError } = await import(
      "./daemon/main.ts"
    );
    try {
      // Auto update only swaps the single-file binary; under node, execPath is node itself.
      const { detectSea } = await import("./install/self-install.ts");
      await startDaemon({
        version: cliVersion(),
        update: detectSea()
          ? {
              binPath: process.execPath,
              current: cliVersion(),
              os: process.platform,
              arch: process.arch,
              log: (l) => process.stderr.write(`${l}\n`),
              fetchManifest: async () =>
                (await fetch("https://hawl.ai/cli/manifest.json")).json(),
              download: async (url) =>
                new Uint8Array(await (await fetch(url)).arrayBuffer()),
            }
          : undefined,
      });
    } catch (e) {
      // Autostart and `hawl mcp` can both start one; the second exits cleanly.
      if (e instanceof DaemonRunningError) {
        process.stderr.write(`hawl: ${e.message}\n`);
        return 0;
      }
      throw e;
    }
    return undefined;
  },
  async autostart(argv) {
    const { positionals } = parse(argv, {});
    const mode = positionals[0];
    if (mode !== "on" && mode !== "off")
      throw new Error("usage: hawl autostart on|off");
    const { setAutostart } = await import("./autostart/index.ts");
    await setAutostart(mode === "on");
    process.stdout.write(`autostart ${mode}\n`);
    return 0;
  },
  async local() {
    const { localHubRunning, startLocalServer } = await import(
      "./local/server.ts"
    );
    const { defaultLocalDir } = await import("./local/log.ts");
    const dir = process.env.HAWL_HOME ?? defaultLocalDir();
    if (await localHubRunning(dir)) {
      process.stderr.write(`hawl local: already serving ${dir}\n`);
      return 0;
    }
    const s = await startLocalServer({ dir });
    process.stderr.write(`hawl local: serving ${dir}\n`);
    process.on("SIGINT", () => void s.close().then(() => process.exit(0)));
    return undefined;
  },
  async update(argv) {
    const { values } = parse(argv, {
      channel: { type: "string" },
      now: { type: "boolean" },
      check: { type: "boolean" },
    });
    const { runUpdate } = await import("./update/cmd.ts");
    const { defaultStateDir } = await import("./daemon/main.ts");
    return runUpdate(
      { ...values, channel: values.channel ?? "latest" },
      {
        stateDir: defaultStateDir(),
        binPath: process.execPath,
        current: cliVersion(),
        os: process.platform,
        arch: process.arch,
        fetchManifest: async () =>
          (await fetch("https://hawl.ai/cli/manifest.json")).json(),
        download: async (url) =>
          new Uint8Array(await (await fetch(url)).arrayBuffer()),
      },
      {
        out: (t) => process.stdout.write(t),
        err: (t) => process.stderr.write(t),
        isTTY: !!process.stdout.isTTY,
        env: process.env,
      },
    );
  },
};

// Runs when started as the entry: source, dist/main.js (version baked in) or the SEA binary.
if (import.meta.main || typeof __HAWL_VERSION__ === "string") {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== undefined) process.exit(code);
    },
    (e: Error) => {
      process.stderr.write(`hawl: ${e.message}\n`);
      process.exit(1);
    },
  );
}
