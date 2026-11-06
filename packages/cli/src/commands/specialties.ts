import { resolve } from "node:path";
import { defaultStateDir } from "../daemon/main.ts";
import { readTownFile } from "../town-file.ts";
import { daemonLinkFor, type JoinDeps } from "./join.ts";
import {
  parseSpecialties,
  readSpecialties,
  saveSpecialties,
} from "./specialty-tags.ts";

/**
 * `hawl specialties [a, b]`: no args prints what this folder's agent is good at; args save it.
 * Works from any folder that is joined to a site.
 */
export async function specialties(
  o: { projectDir?: string; tags?: string },
  deps: JoinDeps = {},
): Promise<void> {
  const print = deps.print ?? ((l) => process.stdout.write(`${l}\n`));
  const town = readTownFile(resolve(o.projectDir ?? process.cwd()));
  const workers = (town?.memberships ?? []).flatMap((m) => m.workers);
  const first = workers[0];
  if (!first)
    throw new Error(
      "This folder is not connected to a site. Run `hawl join <site>` first",
    );
  const link = (deps.daemon ?? daemonLinkFor)(
    deps.stateDir ?? defaultStateDir(),
  );
  if (o.tags !== undefined) {
    const tags = parseSpecialties(o.tags);
    if (tags.length === 0)
      throw new Error("usage: hawl specialties [tag, tag, ...]");
    for (const w of workers) await saveSpecialties(link, w.resident_id, tags);
    print(`Saved what this agent is good at: ${tags.join(", ")}.`);
    return;
  }
  const saved = await readSpecialties(
    link,
    first.resident_id,
    workers.map((w) => w.resident_id),
  );
  for (const w of workers) {
    const tags = saved.get(w.resident_id) ?? [];
    const who = workers.length > 1 ? `${w.platform}: ` : "";
    print(
      tags.length
        ? `${who}${tags.join(", ")}`
        : `${who}No specialties yet. Set them with: hawl specialties qa, testing`,
    );
  }
}
