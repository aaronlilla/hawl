import { randomBytes } from "node:crypto";

/** Id prefixes: tech spec 16 §2.1 renames over 04 §1. Ids are UUIDv7, generated in the app. */
export const ID_PREFIXES = [
  "twn", // town (site)
  "res", // resident (worker)
  "vil", // village (yard)
  "usr", // user
  "chn", // channel / room
  "hnd", // handoff
  "rcp", // receipt
  "fil", // file
  "upl", // upload
  "jrq", // join request
  "msg", // message
  "cnv", // conversation
  "grt", // grant
  "apr", // message approval
  "act", // action approval
  "whk", // webhook / wake target
  "evt", // audit event
  "req", // request id
  "ses", // session
  "cxn", // connection
  "crd", // work card (m2)
  "dln", // direct line (m2)
  "hsk", // human ask (m2)
  "aap", // agent action approval: push to main, release, deploy (m2)
  "art", // job artifact (m2)
  "chk", // team check (m2)
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let lastMs = -1;
let lastSeq = 0;

/**
 * UUIDv7 (RFC 9562 §5.7): 48-bit unix ms, version 7, 12-bit rand_a used as a
 * monotonic counter within one millisecond, variant 10, 62 random bits.
 * Strictly increasing per process, so lexical order equals creation order.
 */
export function uuidv7(now: number = Date.now()): string {
  let ms = Math.floor(now);
  if (ms < lastMs) ms = lastMs;
  if (ms === lastMs) {
    lastSeq += 1;
    if (lastSeq > 0xfff) {
      ms += 1;
      lastSeq = randomBytes(2).readUInt16BE(0) & 0x1ff;
    }
  } else {
    lastSeq = randomBytes(2).readUInt16BE(0) & 0x1ff; // headroom for the counter
  }
  lastMs = ms;

  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | ((lastSeq >> 8) & 0x0f);
  b[7] = lastSeq & 0xff;
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function newId(prefix: IdPrefix, now?: number): string {
  return `${prefix}_${uuidv7(now)}`;
}

export interface ParsedId {
  prefix: IdPrefix;
  uuid: string;
  /** Creation time in unix ms, read from the UUIDv7 timestamp. */
  timeMs: number;
}

export function parseId(id: string, expected?: IdPrefix): ParsedId | null {
  const i = id.indexOf("_");
  if (i < 1) return null;
  const prefix = id.slice(0, i);
  const uuid = id.slice(i + 1);
  if (!(ID_PREFIXES as readonly string[]).includes(prefix)) return null;
  if (expected !== undefined && prefix !== expected) return null;
  if (!UUID_V7_RE.test(uuid)) return null;
  const timeMs = Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
  return { prefix: prefix as IdPrefix, uuid, timeMs };
}

export function isId(id: unknown, expected?: IdPrefix): id is string {
  return typeof id === "string" && parseId(id, expected) !== null;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function base32Crockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}
