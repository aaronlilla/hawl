import type { DaemonLink } from "../mcp/server.ts";

// Kept out of specialties.ts: that file imports join.ts, and join.ts needs these. The import
// cycle deadlocked esbuild's async module init in the bundle, so `hawl join/status/specialties`
// printed nothing (0.1.12 to 0.1.14).

/** "a, b ,,c" to ["a","b","c"], at most 10. Same rule for `join` and `hawl specialties`. */
export function parseSpecialties(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);
}

/** Save through the same `profile_set` the agent's own tool uses. */
export async function saveSpecialties(
  link: DaemonLink,
  rid: string,
  specialties: string[],
): Promise<void> {
  await link.call("tool", {
    resident_id: rid,
    name: "profile_set",
    args: { specialties },
  });
}

/** Saved tags per resident id, from the relay's `who`. Throws when the read fails. */
export async function readSpecialties(
  link: DaemonLink,
  rid: string,
  rids: string[],
): Promise<Map<string, string[]>> {
  const r = (await link.call("tool", {
    resident_id: rid,
    name: "who",
    args: {},
  })) as { workers?: { resident_id?: string; specialties?: string[] }[] };
  const out = new Map<string, string[]>();
  for (const w of r.workers ?? [])
    if (w.resident_id && rids.includes(w.resident_id))
      out.set(w.resident_id, w.specialties ?? []);
  return out;
}
