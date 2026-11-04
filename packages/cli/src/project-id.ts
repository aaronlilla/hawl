import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Per-agent id file, relative to the project folder. Never committed: `.hawl/` is git-excluded. */
export const idFilePath = (tool: string) => `.hawl/${tool}.json`;

/** Bytes of `.hawl/<tool>.json`. `hawl_home` is set only for local mode. */
export function idFileText(residentId: string, hawlHome?: string): string {
  const doc: Record<string, string> = { resident_id: residentId };
  if (hawlHome) doc.hawl_home = hawlHome;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export interface ProjectId {
  resident_id: string;
  hawl_home?: string;
}

/** Walk up from `startDir` to the first `.hawl/<tool>.json`. Null when none or unreadable. */
export function readProjectId(
  tool: string,
  startDir: string = process.cwd(),
): ProjectId | null {
  let dir = resolve(startDir);
  for (;;) {
    const f = join(dir, ".hawl", `${tool}.json`);
    if (existsSync(f)) {
      try {
        const j = JSON.parse(readFileSync(f, "utf8")) as Partial<ProjectId>;
        if (typeof j.resident_id === "string" && j.resident_id)
          return {
            resident_id: j.resident_id,
            ...(typeof j.hawl_home === "string" && { hawl_home: j.hawl_home }),
          };
      } catch {
        // unreadable: keep looking upward
      }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
