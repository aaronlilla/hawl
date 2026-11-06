import { existsSync, mkdirSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { dirname, join, parse } from "node:path";

const joined = (dir: string): boolean => {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".hawl"))) return true;
    if (dirname(d) === d) return false;
  }
};

/**
 * Test temp root that sits outside every joined folder. The product walks up
 * from a folder to the nearest `.hawl/`, so a temp dir inside a joined checkout
 * would find the real membership (and `config stop-hook` would write to it).
 * shortcut: falls back to a dir at the drive root, fine for CI and this PC.
 */
export function tmpdir(): string {
  const base = osTmpdir();
  if (!joined(base)) return base;
  const alt = join(parse(base).root, "hawl-test-tmp");
  mkdirSync(alt, { recursive: true });
  if (joined(alt)) throw new Error(`no temp dir outside a joined folder: ${alt}`);
  return alt;
}
