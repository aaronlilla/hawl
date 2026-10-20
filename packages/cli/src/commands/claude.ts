import { spawn as spawnProc } from "node:child_process";
import { CLAUDE_WAKE_COMMAND } from "../hosts/claude-code.ts";
import { findJoinedRoot } from "../resolve.ts";
import { winCommandLine } from "../shell.ts";
import { readTownFile } from "../town-file.ts";

/** The flag that turns Hawl's channel on for one Claude Code session (code.claude.com/docs/en/channels). */
export const CHANNEL_FLAG = "--dangerously-load-development-channels";
export const CHANNEL_SERVER = "server:hawl";

export interface ClaudeDeps {
  print?: (line: string) => void;
  cwd?: string;
  platform?: string;
  /** Start the process and resolve with its exit code. Default: spawn with the terminal attached. */
  run?: (command: string, args: string[]) => Promise<number>;
}

/**
 * `hawl claude [claude arguments]`: start Claude Code with Hawl's channel on, so a message that
 * arrives while Claude Code sits idle wakes it. It is exactly
 * `claude --dangerously-load-development-channels server:hawl <your arguments>`, printed first, so
 * nothing is hidden. Claude Code shows its own one-time warning dialog for that flag every launch;
 * pick "I am using this for local development". If wake is off for this folder
 * (`hawl wake off`), Claude Code starts plainly.
 */
export async function claude(
  argv: string[],
  deps: ClaudeDeps = {},
): Promise<number> {
  const print = deps.print ?? ((l) => process.stdout.write(`${l}\n`));
  const cwd = deps.cwd ?? process.cwd();
  const root = findJoinedRoot(cwd);
  const town = root ? readTownFile(root) : null;
  const wakeOn = town ? town.wake !== false : false;
  const args = wakeOn ? [CHANNEL_FLAG, CHANNEL_SERVER, ...argv] : argv;
  if (!root) {
    print(
      "This folder has not joined a Hawl site, so Claude Code starts as usual. Run `hawl join <site>` first to connect it.",
    );
  } else if (wakeOn) {
    print(`Starting: ${["claude", ...args].join(" ")}`);
    print(
      'Claude Code asks you to confirm the development channel once per start: choose "I am using this for local development".',
    );
  } else {
    print(
      "Wake is off for this folder, so Claude Code starts without Hawl's channel. Turn it on with `hawl wake on`.",
    );
  }
  const run = deps.run ?? defaultRun(deps.platform ?? process.platform);
  return run("claude", args);
}

function defaultRun(platform: string) {
  return (command: string, args: string[]): Promise<number> =>
    new Promise((resolve) => {
      // `claude` is a .cmd shim on Windows: one command string, no DEP0190 warning.
      const child =
        platform === "win32"
          ? spawnProc(winCommandLine(command, args), [], {
              stdio: "inherit",
              shell: true,
            })
          : spawnProc(command, args, { stdio: "inherit" });
      child.on("error", (e) => {
        process.stderr.write(
          `Could not start Claude Code (${e.message}). Is \`claude\` installed and on your PATH?\n`,
        );
        resolve(127);
      });
      child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
}

/** The same command a person can copy by hand, for the web done screen and the docs. */
export const WAKE_COMMAND_LONG = CLAUDE_WAKE_COMMAND;
