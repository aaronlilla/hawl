import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Envelope } from "@hawl/protocol/src/envelope.ts";
import { ensureDir, TMP_PREFIX, writeFileDurable } from "./fsutil.ts";

/**
 * `spool/<resident_id>/<seq>-<message_id>.json`, 0600, written then fsynced then renamed.
 * `put` returns only after the bytes are durable, so the caller may ACK after it (04 §5.3).
 */
export class Spool {
  private readonly dir: string;
  constructor(root: string, residentId: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(residentId))
      throw new Error("bad resident id");
    this.dir = join(root, residentId);
    ensureDir(this.dir);
    for (const f of readdirSync(this.dir)) {
      if (f.startsWith(TMP_PREFIX)) rmSync(join(this.dir, f), { force: true });
    }
  }

  private names(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json") && f !== "cursor.json")
      .sort();
  }

  private static name(seq: number, messageId: string): string {
    return `${String(seq).padStart(12, "0")}-${messageId}.json`;
  }

  private load(name: string): Envelope | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Envelope;
    } catch {
      return null; // a torn or foreign file is skipped, never delivered
    }
  }

  has(messageId: string): boolean {
    return this.names().some((n) => n.endsWith(`-${messageId}.json`));
  }

  /** Highest inbox_seq ever durably spooled; survives `remove`. */
  lastSeq(): number {
    const f = join(this.dir, "cursor.json");
    if (!existsSync(f)) return 0;
    try {
      return (JSON.parse(readFileSync(f, "utf8")) as { seq: number }).seq;
    } catch {
      return 0;
    }
  }

  put(env: Envelope): void {
    const { message_id } = env.relay;
    const { inbox_seq } = env.relay.delivery;
    if (this.has(message_id)) return;
    writeFileDurable(
      join(this.dir, Spool.name(inbox_seq, message_id)),
      JSON.stringify(env),
    );
    if (inbox_seq > this.lastSeq()) {
      writeFileDurable(
        join(this.dir, "cursor.json"),
        JSON.stringify({ seq: inbox_seq }),
      );
    }
  }

  list(): Envelope[] {
    return this.names().flatMap((n) => {
      const e = this.load(n);
      return e ? [e] : [];
    });
  }

  private marker(name: string): string {
    return join(this.dir, `${name}.read`);
  }

  unread(): Envelope[] {
    return this.names()
      .filter((n) => !existsSync(this.marker(n)))
      .flatMap((n) => {
        const e = this.load(n);
        return e ? [e] : [];
      });
  }

  markRead(messageIds: string[]): void {
    for (const n of this.names()) {
      if (messageIds.some((id) => n.endsWith(`-${id}.json`))) {
        writeFileSync(this.marker(n), "", { mode: 0o600 });
      }
    }
  }

  remove(messageId: string): void {
    for (const n of this.names()) {
      if (n.endsWith(`-${messageId}.json`)) {
        rmSync(join(this.dir, n), { force: true });
        rmSync(this.marker(n), { force: true });
      }
    }
  }

  /** `hawl leave`: delete the spool. */
  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
