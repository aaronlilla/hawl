import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  scrypt,
} from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { b64url, fromB64url } from "@hawl/protocol/src/hash.ts";
import {
  importPrivateJwk,
  importPublicJwk,
  type Jwk,
  keyId,
  signEd25519,
} from "@hawl/protocol/src/sign.ts";
import { ensureDir, writeFileDurable } from "./fsutil.ts";

/** Private keys by account (the resident id). Spec 16 §3.4: keychain service `hawl`. */
export interface KeyStore {
  readonly kind: "keychain" | "passphrase-file" | "memory";
  get(account: string): Promise<Jwk | null>;
  set(account: string, privateJwk: Jwk): Promise<void>;
  delete(account: string): Promise<void>;
}

export const KEYCHAIN_SERVICE = "hawl";

interface KeyringEntry {
  setPassword(p: string): void;
  getPassword(): string | null;
  deletePassword(): boolean;
}
type EntryCtor = new (service: string, account: string) => KeyringEntry;

function loadEntry(): EntryCtor {
  const require = createRequire(import.meta.url);
  return (require("@napi-rs/keyring") as { Entry: EntryCtor }).Entry;
}

export class KeychainStore implements KeyStore {
  readonly kind = "keychain" as const;
  private readonly Entry: EntryCtor;
  constructor(Entry: EntryCtor = loadEntry()) {
    this.Entry = Entry;
  }
  private entry(account: string): KeyringEntry {
    return new this.Entry(KEYCHAIN_SERVICE, account);
  }
  async get(account: string): Promise<Jwk | null> {
    const raw = this.entry(account).getPassword();
    return raw ? (JSON.parse(raw) as Jwk) : null;
  }
  async set(account: string, privateJwk: Jwk): Promise<void> {
    this.entry(account).setPassword(JSON.stringify(privateJwk));
  }
  async delete(account: string): Promise<void> {
    try {
      this.entry(account).deletePassword();
    } catch {
      // already gone
    }
  }
}

export class MemoryKeyStore implements KeyStore {
  readonly kind = "memory" as const;
  private readonly m = new Map<string, Jwk>();
  async get(a: string) {
    return this.m.get(a) ?? null;
  }
  async set(a: string, k: Jwk) {
    this.m.set(a, k);
  }
  async delete(a: string) {
    this.m.delete(a);
  }
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function derive(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, SCRYPT, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * Headless fallback: 0600 file, scrypt + AES-256-GCM. keyutils is in-memory only
 * (spec 16 §3.4), so it is not used for persistence. Never inside a project folder.
 */
export class PassphraseFileStore implements KeyStore {
  readonly kind = "passphrase-file" as const;
  private readonly dir: string;
  private readonly passphrase: string;
  constructor(dir: string, passphrase: string) {
    this.dir = dir;
    this.passphrase = passphrase;
  }
  private file(account: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(account)) throw new Error("bad account id");
    return join(this.dir, `${account}.key`);
  }
  async get(account: string): Promise<Jwk | null> {
    const f = this.file(account);
    if (!existsSync(f)) return null;
    const rec = JSON.parse(readFileSync(f, "utf8")) as {
      salt: string;
      iv: string;
      tag: string;
      ct: string;
    };
    const key = await derive(this.passphrase, fromB64url(rec.salt));
    const d = createDecipheriv("aes-256-gcm", key, fromB64url(rec.iv));
    d.setAuthTag(fromB64url(rec.tag));
    d.setAAD(Buffer.from(account));
    const pt = Buffer.concat([d.update(fromB64url(rec.ct)), d.final()]);
    return JSON.parse(pt.toString("utf8")) as Jwk;
  }
  async set(account: string, privateJwk: Jwk): Promise<void> {
    ensureDir(this.dir);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await derive(this.passphrase, salt);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(account));
    const ct = Buffer.concat([
      c.update(JSON.stringify(privateJwk), "utf8"),
      c.final(),
    ]);
    writeFileDurable(
      this.file(account),
      JSON.stringify({
        v: 1,
        salt: b64url(salt),
        iv: b64url(iv),
        tag: b64url(c.getAuthTag()),
        ct: b64url(ct),
      }),
    );
  }
  async delete(account: string): Promise<void> {
    rmSync(this.file(account), { force: true });
  }
}

/**
 * Keychain first (proved usable with a set/get/delete probe). Without one, the passphrase
 * file if a passphrase is given. Otherwise refuse: never a silent weaker store.
 */
export async function openKeyStore(opts: {
  stateDir: string;
  passphrase?: string;
  keychain?: KeyStore;
}): Promise<KeyStore> {
  try {
    const kc = opts.keychain ?? new KeychainStore();
    const probe = `probe-${randomBytes(4).toString("hex")}`;
    let back: Jwk | null;
    try {
      await kc.set(probe, { kty: "probe" });
      back = await kc.get(probe);
    } finally {
      // never leave a probe in the keychain, even when the read-back throws
      await kc.delete(probe);
    }
    if (back?.kty === "probe") return kc;
  } catch {
    // fall through to the file store
  }
  if (opts.passphrase) {
    return new PassphraseFileStore(
      join(opts.stateDir, "keys"),
      opts.passphrase,
    );
  }
  throw new Error(
    "no usable OS keychain and no passphrase given (set HAWL_PASSPHRASE for headless use)",
  );
}

export interface Signer {
  kid: string;
  sign(data: Uint8Array): Buffer;
  publicKey: KeyObject;
}

/** New Ed25519 worker key. Returns the private JWK to store and its `key_` id. */
export function generateWorkerKey(): {
  privateJwk: Jwk;
  publicJwk: Jwk;
  kid: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" }) as Jwk;
  const publicJwk = publicKey.export({ format: "jwk" }) as Jwk;
  return { privateJwk, publicJwk, kid: keyId(publicJwk) };
}

/** The worker key as a local signing key, for a process that signs `client_request` itself. */
export async function loadLocalSigner(
  store: KeyStore,
  account: string,
): Promise<{ kid: string; privateKey: KeyObject } | null> {
  const jwk = await store.get(account);
  if (!jwk) return null;
  const { d: _d, ...pub } = jwk;
  return { kid: keyId(pub), privateKey: importPrivateJwk(jwk) };
}

export async function loadSigner(
  store: KeyStore,
  account: string,
): Promise<Signer | null> {
  const jwk = await store.get(account);
  if (!jwk) return null;
  const priv = importPrivateJwk(jwk);
  const { d: _d, ...pub } = jwk;
  return {
    kid: keyId(pub),
    publicKey: importPublicJwk(pub),
    sign: (data) => signEd25519(priv, data),
  };
}
