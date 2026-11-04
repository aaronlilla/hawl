import {
  createHash,
  createPublicKey,
  type KeyObject,
  verify,
  type webcrypto,
} from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  PC_APPROVAL_TTL_MS,
  type PcApprovalFields,
  pcApprovalText,
} from "@hawl/protocol/src/pc-approval.ts";

/**
 * The helper's own check of an owner's Allow for file_from_pc. It does not take the relay's
 * word: before reading a file it needs a WebAuthn assertion, made with the owner's passkey over
 * the exact request (request id, this helper, path, size, mtime, inode, recipient, expiry), and
 * verifies it here against public keys pinned on this PC.
 *
 * Threat model: a compromised relay can withhold approvals or refuse to deliver, but it cannot
 * forge one (it has no passkey), replay one (request id and op are recorded, and a counter never
 * repeats or goes back), stretch one (expiry is signed and capped), or swap keys: keys are pinned on first use
 * when this PC pairs, and a key added later is trusted only after the owner confirms it on this
 * PC (`hawl passkeys`). Limits: the first pairing trusts what the relay hands over (TOFU), and
 * the recipient is signed but delivery after upload is the relay's job.
 */

export type PinnedKey = {
  /** WebAuthn credential id, base64url. */
  id: string;
  /** COSE public key, base64 (as the web stores it). */
  cose: string;
  name: string;
  /** Highest signature counter seen. */
  counter: number;
};
export type Pins = {
  v: 1;
  /** Owner user id to the web origin the passkeys belong to and the pinned keys. */
  owners: Record<string, { origin: string; keys: PinnedKey[] }>;
  /** Helper (resident) wire id to its owner's user id, fixed at pairing. */
  residents: Record<string, string>;
  /** Request id to the ops already done with its approval, and the passkey and counter it came with. */
  used: Record<
    string,
    { exp: number; ops: string[]; cred?: string; counter?: number }
  >;
};

/** The owner's passkeys as the relay lists them (GET /v1/agent/passkeys). Untrusted. */
export type KeyListing = {
  owner_user_id: string;
  origin: string;
  keys: { id: string; public_key: string; name?: string }[];
};

const FILE = "passkeys.json";
const empty = (): Pins => ({ v: 1, owners: {}, residents: {}, used: {} });

export function readPins(stateDir: string): Pins {
  try {
    const p = JSON.parse(readFileSync(join(stateDir, FILE), "utf8")) as Pins;
    return p?.v === 1 ? p : empty();
  } catch {
    return empty();
  }
}

const LOCK_STALE_MS = 10_000;

/**
 * Run `fn` holding passkeys.json's lock, shared by every hawl process on this PC (the daemon and
 * `hawl passkeys`). Every read-modify-write of the file (pins, used ledger, counters) goes through
 * here, and `fn` is synchronous so the lock is held for milliseconds.
 * shortcut: a lock older than 10 s is taken as left by a crashed process; two processes clearing
 * the same stale lock at once could both enter. Upgrade to a real OS lock if that ever matters.
 */
export async function lockPins<T>(stateDir: string, fn: () => T): Promise<T> {
  const lock = join(stateDir, `${FILE}.lock`);
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // gone between the open and the stat
      }
      if (i > 1500)
        throw new Error(
          "another hawl process is holding this PC's passkey file. Try again.",
        );
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

export function writePins(stateDir: string, p: Pins): void {
  const path = join(stateDir, FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Minimal CBOR for a COSE_Key: one map of int keys to ints or byte strings. */
function coseMap(b: Buffer): Map<number, number | Buffer> {
  let i = 0;
  const head = (): [number, number] => {
    const x = b[i++];
    if (x === undefined) throw new Error("short");
    let n = x & 31;
    if (n === 24) n = b.readUInt8(i++);
    else if (n === 25) {
      n = b.readUInt16BE(i);
      i += 2;
    } else if (n === 26) {
      n = b.readUInt32BE(i);
      i += 4;
    } else if (n > 23) throw new Error("cbor");
    return [x >> 5, n];
  };
  const item = (): number | Buffer => {
    const [m, n] = head();
    if (m === 0) return n;
    if (m === 1) return -1 - n;
    if (m === 2) {
      if (i + n > b.length) throw new Error("short");
      return b.subarray((i += n) - n, i);
    }
    throw new Error("cbor");
  };
  const [m, n] = head();
  if (m !== 5) throw new Error("cbor");
  const out = new Map<number, number | Buffer>();
  for (let k = 0; k < n; k++) {
    const key = item();
    if (typeof key !== "number") throw new Error("cbor");
    out.set(key, item());
  }
  return out;
}

/** COSE key (base64) to a Node key. ES256, RS256 and EdDSA: what passkeys use. */
export function coseKey(cose: string): { alg: number; key: KeyObject } {
  const m = coseMap(Buffer.from(cose, "base64"));
  const bx = (k: number) => {
    const v = m.get(k);
    if (!Buffer.isBuffer(v)) throw new Error("cose");
    return v.toString("base64url");
  };
  const kty = m.get(1);
  const alg = m.get(3);
  let jwk: webcrypto.JsonWebKey;
  if (kty === 2 && alg === -7 && m.get(-1) === 1)
    jwk = { kty: "EC", crv: "P-256", x: bx(-2), y: bx(-3) };
  else if (kty === 3 && alg === -257)
    jwk = { kty: "RSA", n: bx(-1), e: bx(-2) };
  else if (kty === 1 && alg === -8 && m.get(-1) === 6)
    jwk = { kty: "OKP", crv: "Ed25519", x: bx(-2) };
  else throw new Error("unsupported key");
  return {
    alg: alg as number,
    key: createPublicKey({ key: jwk, format: "jwk" }),
  };
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
const str = (v: unknown, max = 4096) =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

export const NOT_PAIRED =
  "this PC has no passkey of your owner's pinned yet. On that PC, your owner runs npx hawl.ai passkeys and confirms the passkey.";
export const UNTRUSTED_KEY =
  "it was approved with a passkey this PC does not trust yet. If your owner added a passkey, they confirm it on that PC with npx hawl.ai passkeys.";

/**
 * Check one approval for one op ("hash" or "put") on one request. Returns the refusal reason, or
 * null when it holds; on null the counter and the op are recorded in `pins` (the caller writes
 * them). Synchronous on purpose: no other frame can run between the check and the record.
 */
export function checkPcApproval(o: {
  pins: Pins;
  residentId: string;
  op: string;
  fields: Omit<PcApprovalFields, "exp" | "helper_id">;
  approval: unknown;
  now: number;
}): string | null {
  const owner = o.pins.residents[o.residentId];
  const ow = owner ? o.pins.owners[owner] : undefined;
  if (!ow || ow.keys.length === 0) return NOT_PAIRED;
  const a = (o.approval ?? {}) as Record<string, unknown>;
  const credId = str(a.credential_id, 1024);
  const cdj = str(a.client_data_json);
  const ad = str(a.authenticator_data);
  const sig = str(a.signature);
  const exp = a.exp;
  if (!credId || !cdj || !ad || !sig || typeof exp !== "number")
    return "it came without your owner's passkey approval, so nothing was read.";
  if (o.now > exp)
    return "your owner's approval ran out before the file was read. Ask again.";
  if (exp - o.now > PC_APPROVAL_TTL_MS + 60_000)
    return "the approval asked to last longer than 10 minutes, so it was refused.";
  const key = ow.keys.find((k) => k.id === credId);
  if (!key) return UNTRUSTED_KEY;
  const BAD =
    "your owner's passkey approval did not check out, so nothing was read.";
  try {
    const raw = Buffer.from(cdj, "base64url");
    const cd = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    const want = sha256(
      pcApprovalText({ ...o.fields, helper_id: o.residentId, exp }),
    ).toString("base64url");
    if (cd.type !== "webauthn.get" || cd.origin !== ow.origin) return BAD;
    if (cd.crossOrigin === true) return BAD;
    if (cd.challenge !== want)
      return "your owner approved a different file, size, PC or recipient, so nothing was read.";
    const auth = Buffer.from(ad, "base64url");
    if (auth.length < 37) return BAD;
    if (!auth.subarray(0, 32).equals(sha256(new URL(ow.origin).hostname)))
      return BAD;
    // User present and user verified: a real tap with the passkey's PIN or biometric.
    if (((auth[32] ?? 0) & 0x05) !== 0x05) return BAD;
    const { alg, key: pk } = coseKey(key.cose);
    const data = Buffer.concat([auth, sha256(raw)]);
    const s = Buffer.from(sig, "base64url");
    const ok =
      alg === -7
        ? verify("sha256", data, { key: pk, dsaEncoding: "der" }, s)
        : verify(alg === -8 ? null : "sha256", data, pk, s);
    if (!ok) return BAD;
    const counter = auth.readUInt32BE(33);
    const used = o.pins.used[o.fields.request_id];
    if (used?.ops.includes(o.op))
      return "that approval was already used, so it was not used again.";
    // The challenge binds each assertion to its own request, so approvals in flight at once may
    // arrive in any order. Within one request the counter must not go back (an older tap), and
    // two requests never share one non-zero counter (a cloned or replayed assertion).
    const seen = used
      ? used.cred !== undefined &&
        (used.cred !== credId || counter < (used.counter ?? 0))
      : counter > 0 &&
        Object.values(o.pins.used).some(
          (u) => u.cred === credId && u.counter === counter,
        );
    if (seen)
      return "that passkey approval was seen before (its counter did not go up), so nothing was read.";
    key.counter = Math.max(key.counter, counter);
    o.pins.used[o.fields.request_id] = {
      exp,
      ops: [...(used?.ops ?? []), o.op],
      cred: credId,
      counter: Math.max(used?.counter ?? 0, counter),
    };
    for (const [id, u] of Object.entries(o.pins.used))
      if (u.exp < o.now - 3_600_000) delete o.pins.used[id];
    return null;
  } catch {
    return BAD;
  }
}

/** Keys from a relay listing that parse; anything else is dropped. */
function usable(l: KeyListing): PinnedKey[] {
  const out: PinnedKey[] = [];
  for (const k of l.keys ?? []) {
    try {
      if (!str(k.id, 1024) || !str(k.public_key)) continue;
      coseKey(k.public_key);
      out.push({
        id: k.id,
        cose: k.public_key,
        name: k.name ?? "",
        counter: 0,
      });
    } catch {
      // not a key a passkey makes
    }
  }
  return out;
}

/** This helper's owner has at least one key pinned on this PC. */
export const hasKeys = (p: Pins, residentId: string) => {
  const owner = p.residents[residentId];
  return !!(owner && p.owners[owner]?.keys.length);
};

/**
 * Pairing, trust on first use: the first time this PC's helper runs as `residentId`, it records
 * that helper's owner and, if this PC has no keys for that owner yet, pins the owner's passkeys.
 * After that the relay's listing changes nothing here; new keys need `confirmKeys`.
 */
export async function pinOnFirstUse(
  stateDir: string,
  residentId: string,
  list: () => Promise<KeyListing>,
): Promise<"pinned" | "known"> {
  if (hasKeys(readPins(stateDir), residentId)) return "known";
  const l = await list();
  return lockPins(stateDir, () => {
    const p = readPins(stateDir);
    if (hasKeys(p, residentId)) return "known" as const;
    // Paired before the owner had a passkey: still unpaired, so the first keys listed are pinned.
    const owner = (p.residents[residentId] ??= l.owner_user_id);
    if (owner !== l.owner_user_id) return "known" as const;
    const ow = p.owners[owner];
    if (ow && ow.keys.length > 0) return "known" as const;
    p.owners[owner] = { origin: ow?.origin ?? l.origin, keys: usable(l) };
    writePins(stateDir, p);
    return "pinned" as const;
  });
}

export const fingerprint = (cose: string) =>
  sha256(Buffer.from(cose, "base64")).toString("base64url").slice(0, 16);

/**
 * `hawl passkeys`: the owner, at this PC, sees the keys the relay lists that this PC does not
 * trust yet and confirms them. Keys the owner removed are dropped (that only takes trust away).
 */
export async function confirmKeys(
  stateDir: string,
  residentIds: string[],
  l: KeyListing,
  confirm: (fresh: PinnedKey[], origin: string) => Promise<boolean>,
): Promise<{ added: number; removed: number }> {
  const listed = usable(l);
  const before = readPins(stateDir).owners[l.owner_user_id];
  const fresh = listed.filter(
    (k) => !(before?.keys ?? []).some((h) => h.id === k.id),
  );
  if (fresh.length > 0 && !(await confirm(fresh, before?.origin ?? l.origin)))
    return { added: 0, removed: 0 };
  // Read again after the prompt, under the lock: the helper may have used an approval meanwhile,
  // and its used record and counters must survive (or that approval could be replayed).
  return lockPins(stateDir, () => {
    const p = readPins(stateDir);
    const ow = p.owners[l.owner_user_id];
    const have = ow?.keys ?? [];
    const kept = have.filter((h) => listed.some((k) => k.id === h.id));
    const added = fresh.filter((k) => !have.some((h) => h.id === k.id));
    p.owners[l.owner_user_id] = {
      origin: ow?.origin ?? before?.origin ?? l.origin,
      keys: [...kept, ...added],
    };
    for (const r of residentIds) p.residents[r] ??= l.owner_user_id;
    writePins(stateDir, p);
    return { added: added.length, removed: have.length - kept.length };
  });
}
