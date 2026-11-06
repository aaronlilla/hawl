/** Every plain-words CLI error in one place (C-CMD-12): a cross, what is wrong, the one fix, then the doctor line. */
import type { Style } from "./style.ts";

/** An error the CLI prints as `✗ message` plus its fix line. */
export class CliError extends Error {
  fix?: string;
  doctor: boolean;
  constructor(message: string, fix?: string, doctor = true) {
    super(message);
    this.fix = fix;
    this.doctor = doctor;
  }
}

export const notSignedIn = () =>
  new CliError("You are not signed in; run `hawl login`.");
export const serviceNotRunning = () =>
  new CliError("The hawl service isn't running; run `hawl service start`.");
export const pcOffline = (name: string, lastSeen: string) =>
  new CliError(
    `${name} is offline (last seen ${lastSeen}).`,
    "Turn it on to start sessions.",
  );

export function unknownCommand(st: Style, cmd: string, near?: string): string {
  return `${st.fail} "${cmd}" isn't a hawl command.${near ? ` Did you mean "${near}"?` : ""}\nRun hawl --help to see all commands.\n`;
}

/** Render a CliError (or any Error) the way every command shows it. */
export function formatError(st: Style, e: Error): string {
  const msg = e.message.replace(/\.$/, "");
  const fix = e instanceof CliError && e.fix ? `${e.fix}\n` : "";
  const doctor =
    e instanceof CliError && !e.doctor
      ? ""
      : st.dim("Still stuck? Run hawl doctor.");
  return `${st.fail} ${msg}.\n${fix}${doctor}${doctor ? "\n" : ""}`;
}

/** Is the helper's socket answering? Cheap check commands use before a daemon call. */
export async function requireService(
  call: (op: string) => Promise<unknown>,
): Promise<void> {
  try {
    await call("status");
  } catch {
    throw serviceNotRunning();
  }
}
