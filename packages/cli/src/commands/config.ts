import { findJoinedRoot } from "../resolve.ts";
import { readTownFile, writeTownFile } from "../town-file.ts";
import { JoinError } from "./join.ts";

/**
 * `hawl config stop-hook on|off`: whether mail aimed at this folder's agent keeps it working
 * (Stop) and shows up mid-task (PostToolUse). Stored in the folder's `.hawl/hawl.json`; the hook
 * reads it. Absent means on.
 */
export function setStopHook(
  opts: { projectDir: string; on: boolean },
  print: (l: string) => void = (l) => process.stdout.write(`${l}\n`),
): { on: boolean } {
  const root = findJoinedRoot(opts.projectDir);
  const town = root ? readTownFile(root) : null;
  if (!root || !town) throw new JoinError("this folder has no hawl membership");
  town.stop_hook = opts.on;
  writeTownFile(root, town);
  print(`stop-hook ${opts.on ? "on" : "off"}`);
  return { on: opts.on };
}
