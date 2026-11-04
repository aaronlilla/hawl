/** `hawl start | login | logout | service`: this PC's helper and sign-in (C-CMD-01, 07, 08). Same HAWL_DATA switch as the team commands. */
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { CliError, pcOffline } from "../cli-errors.ts";
import { NotWired } from "../team.ts";
import { daemonLinkFor } from "./join.ts";
import { stdStyle } from "./team-cmds.ts";

const fake = () => process.env.HAWL_DATA === "fake";
const say = (s: string) => process.stdout.write(`${s}\n`);
const stateDir = async () =>
  (await import("../daemon/main.ts")).defaultStateDir();

async function helperRunning(): Promise<boolean> {
  try {
    await daemonLinkFor(await stateDir()).call("status");
    return true;
  } catch {
    return false;
  }
}

/** `hawl start [--pc name]`: start your assistant (Claude Code) in this folder. */
export async function start(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { pc: { type: "string" } },
    allowPositionals: true,
  });
  const st = stdStyle();
  if (values.pc) {
    if (fake()) throw pcOffline(values.pc, "1:52 PM");
    throw new NotWired("Starting on another PC");
  }
  if (!fake() && !(await helperRunning()))
    throw new CliError(
      "Couldn't start: the Hawl helper isn't running.",
      "Start it with `hawl service start`.",
    );
  const folder = basename(process.cwd());
  say(st.green("Hawl helper running"));
  if (process.stdout.isTTY)
    process.stdout.write(
      `${st.cyan(st.spinnerFrames[0] ?? "...")} Starting Claude Code in ${folder}...\r\u001b[2K`,
    );
  say(`${st.ok} Started your assistant in ${st.bold(folder)}.`);
  say(`See your team: ${st.bold("hawl")}`);
  say(`Fix problems: ${st.bold("hawl doctor")}`);
  if (fake()) return 0;
  const { claude } = await import("./claude.ts");
  return claude(positionals, { print: () => undefined });
}

/** `hawl login`: browser code sign-in. Without a site there is no relay route from the terminal yet. */
export async function login(): Promise<number> {
  const st = stdStyle();
  if (!fake())
    throw new CliError(
      "Signing in without a site isn't connected from the terminal yet.",
      "Run `hawl join <site>`: it signs you in and joins.",
      false,
    );
  say(`Open ${st.cyan("hawl.ai/device")} and type ${st.bold("KTRW-ZBHM")}`);
  say(st.dim("Fingerprint 9F3A-12C7-B04E-D581 (it must match the page)"));
  say("Waiting for approval...");
  say(`${st.ok} Signed in as ${st.bold("aaron@acme.dev")}`);
  say(`Next: run ${st.bold("hawl start")} in a project folder`);
  return 0;
}

export async function logout(): Promise<number> {
  const st = stdStyle();
  if (!fake())
    throw new CliError(
      "Signing out without a site isn't connected from the terminal yet.",
      "Disconnect a folder with `hawl leave`.",
      false,
    );
  say(`${st.ok} Signed out on this PC`);
  say(`Sign back in: ${st.bold("hawl login")}`);
  return 0;
}

/** `hawl service start|stop|install|update` */
export async function service(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({
    args: argv,
    options: {},
    allowPositionals: true,
  });
  const sub = positionals[0];
  const st = stdStyle();
  const AUTOSTART = `Hawl starts when you log in. Turn that off with \`hawl autostart off\`.`;
  if (sub === "start" || sub === "install") {
    if (sub === "install") {
      if (!fake())
        await (await import("../autostart/index.ts")).setAutostart(true);
      say(AUTOSTART);
    }
    if (!fake())
      await (await import("./join.ts")).spawnDaemon(await stateDir());
    say(st.green("Hawl helper running"));
    return 0;
  }
  if (sub === "stop") {
    if (!fake()) {
      try {
        await daemonLinkFor(await stateDir()).call("shutdown");
      } catch {
        say("hawl helper was not running");
        return 0;
      }
    }
    say("hawl helper stopped");
    return 0;
  }
  if (sub === "update") {
    if (fake()) {
      say("Checking hawl.ai for updates (channel: latest)...");
      say(`${st.ok} You're on the latest version (0.1.21).`);
      return 0;
    }
    return (await (await import("../main.ts")).defaultHandlers.update([])) ?? 0;
  }
  throw new Error("usage: hawl service start|stop|install|update");
}
