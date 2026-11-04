import { setDebug } from "../daemon/log.ts";
import { defaultStateDir } from "../daemon/main.ts";
import type { JoinDeps } from "./join.ts";

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** `hawl debug on|off`: verbose helper log on this machine for 24 hours. Nothing is sent. */
export function debug(
  o: { on: boolean },
  deps: JoinDeps & { now?: () => number } = {},
): number | null {
  const print = deps.print ?? ((l) => process.stdout.write(`${l}\n`));
  const stateDir = deps.stateDir ?? defaultStateDir();
  const until = setDebug(stateDir, o.on, deps.now?.());
  print(
    until === null
      ? "Verbose logging is off."
      : `Verbose logging is on until ${fmtTime(until)}. It switches itself off after 24 hours.\nThe log stays on this machine (max 50 MB, 7 days). Nothing is sent unless you run: hawl doctor --send\nTurn it off now: hawl debug off`,
  );
  return until;
}
