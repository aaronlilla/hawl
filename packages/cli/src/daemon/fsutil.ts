import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const TMP_PREFIX = ".tmp-";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows: mode bits are not enforced; the profile ACL applies.
  }
}

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Windows cannot open a directory for fsync.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Write a 0600 file so a reader sees either the old or the new content, never a torn one. */
export function writeFileDurable(
  path: string,
  data: string | Uint8Array,
): void {
  const dir = dirname(path);
  ensureDir(dir);
  const tmp = join(dir, `${TMP_PREFIX}${randomBytes(6).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    if (typeof data === "string") writeSync(fd, data);
    else writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dir);
}
