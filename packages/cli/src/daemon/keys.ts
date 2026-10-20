import { spawnSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  scrypt,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/** What the OS calls its secret store, for the one plain line when we cannot use it. */
function keychainName(platform: string = process.platform): string {
  if (platform === "win32") return "Windows Credential Manager";
  if (platform === "darwin") return "the macOS Keychain";
  return "the system keyring";
}

export function keychainRefusedLine(platform?: string): string {
  return `Saved this agent's key in a file because ${keychainName(platform)} refused it.`;
}

/**
 * The secret that locks the key file when no passphrase was given: random, made once, kept next
 * to the keys with owner-only permissions. Weaker than the OS keychain, so it is only used when
 * the keychain refuses, and the person is told.
 */
export function machineSecret(stateDir: string, o: SecretDeps = {}): string {
  const dir = join(stateDir, "keys");
  const f = join(dir, ".machine-secret");
  const win = (o.platform ?? process.platform) === "win32";
  const run = o.run ?? runPowerShell;
  const read = (): string => {
    const raw = readFileSync(f, "utf8").trim();
    if (raw.startsWith(DPAPI_TAG))
      return fromBase64(run(UNPROTECT, raw.slice(DPAPI_TAG.length))).toString(
        "utf8",
      );
    // A plain secret from an earlier build: wrap it now on Windows (if DPAPI is there).
    if (win) {
      try {
        const blob = run(PROTECT, Buffer.from(raw, "utf8").toString("base64"));
        writeFileSync(f, `${DPAPI_TAG}${blob.trim()}\n`, { mode: 0o600 });
      } catch {
        // keep the plain file; it is already locked to the user
      }
    }
    return raw;
  };
  if (existsSync(f)) return read();
  mkdirSync(dir, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  try {
    writeSecret(f, secret, win, run, false);
  } catch {
    // someone else made it first: use theirs
    if (existsSync(f)) return read();
    throw new Error("could not write the key file secret");
  }
  return secret;
}

export interface SecretDeps {
  platform?: string;
  /** Runs one PowerShell script with `input` on stdin and returns its output (a test seam). */
  run?: (script: string, input: string) => string;
}

const DPAPI_TAG = "dpapi:v1:";
const PROTECT =
  "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const UNPROTECT =
  "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

function fromBase64(s: string): Buffer {
  return Buffer.from(s.trim(), "base64");
}

function runPowerShell(script: string, input: string): string {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input, encoding: "utf8", timeout: 20_000, windowsHide: true },
  );
  if (r.status !== 0 || !r.stdout.trim())
    throw new Error(`powershell failed: ${r.stderr?.trim() || r.status}`);
  return r.stdout.trim();
}

/**
 * On Windows the secret is wrapped with DPAPI for this user (CurrentUser scope), so the file is
 * useless to another account or another machine. If DPAPI is not there, a user-only ACL is the
 * minimum. Elsewhere the file is owner-only (0600).
 */
function writeSecret(
  f: string,
  secret: string,
  win: boolean,
  run: (script: string, input: string) => string,
  overwrite: boolean,
): void {
  let body = secret;
  if (win) {
    try {
      const blob = run(PROTECT, Buffer.from(secret, "utf8").toString("base64"));
      body = `${DPAPI_TAG}${blob.trim()}`;
    } catch {
      body = secret; // plain, then locked down below
    }
  }
  writeFileSync(f, `${body}\n`, { mode: 0o600, flag: overwrite ? "w" : "wx" });
  if (!win) return void chmodSync(f, 0o600);
  if (!body.startsWith(DPAPI_TAG)) lockToUser(f);
}

/**
 * Windows without DPAPI: only this user may touch the file. The user is named by SID (a bare
 * account name can resolve to nothing and lock everyone out), and the change is undone if the file
 * cannot be read back afterwards.
 */
function lockToUser(f: string): void {
  const who = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  const sid = /"(S-1-[0-9-]+)"/.exec(who.stdout ?? "")?.[1];
  if (!sid) return;
  const opts = { windowsHide: true, timeout: 10_000 } as const;
  spawnSync("icacls", [f, "/inheritance:r", "/grant:r", `*${sid}:F`], opts);
  try {
    readFileSync(f, "utf8");
  } catch {
    spawnSync("icacls", [f, "/reset"], opts);
  }
}

/**
 * The keychain with a file behind it. A write the keychain refuses, for any reason, goes to the
 * file instead (one plain line, once) and the join goes on. Reads and deletes check both.
 */
export class FallbackKeyStore implements KeyStore {
  readonly kind: KeyStore["kind"];
  private readonly primary: KeyStore;
  private readonly fallback: () => KeyStore;
  private readonly onFallback: ((line: string) => void) | undefined;
  private told = false;
  constructor(
    primary: KeyStore,
    fallback: () => KeyStore,
    onFallback?: (line: string) => void,
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.onFallback = onFallback;
    this.kind = primary.kind;
  }
  async get(account: string): Promise<Jwk | null> {
    try {
      const v = await this.primary.get(account);
      if (v) return v;
    } catch {
      // the keychain cannot be read: the file may still have it
    }
    return this.fallback().get(account);
  }
  async set(account: string, privateJwk: Jwk): Promise<void> {
    try {
      await this.primary.set(account, privateJwk);
      return;
    } catch {
      if (!this.told) this.onFallback?.(keychainRefusedLine());
      this.told = true;
    }
    await this.fallback().set(account, privateJwk);
  }
  async delete(account: string): Promise<void> {
    await this.primary.delete(account).catch(() => {});
    await this.fallback().delete(account);
  }
}

/**
 * Keychain first (proved usable with a set/get/delete probe), with a file behind it for any
 * write it refuses. When the keychain fails the probe, the passphrase file (or the machine
 * secret's file) with one plain line. `HAWL_KEYSTORE=file` skips the keychain entirely, for
 * tests and headless machines.
 */
export async function openKeyStore(opts: {
  stateDir: string;
  passphrase?: string;
  keychain?: KeyStore;
  /** One plain line when the key goes to a file because the keychain refused. */
  onFallback?: (line: string) => void;
  /** Skip the keychain. Default: HAWL_KEYSTORE=file. */
  fileOnly?: boolean;
}): Promise<KeyStore> {
  const dir = join(opts.stateDir, "keys");
  const file = (): KeyStore =>
    new PassphraseFileStore(
      dir,
      opts.passphrase || machineSecret(opts.stateDir),
    );
  if (opts.fileOnly ?? process.env.HAWL_KEYSTORE === "file") return file();
  let kc: KeyStore | undefined;
  try {
    kc = opts.keychain ?? new KeychainStore();
    const probe = `probe-${randomBytes(4).toString("hex")}`;
    let back: Jwk | null;
    try {
      await kc.set(probe, { kty: "probe" });
      back = await kc.get(probe);
    } finally {
      // never leave a probe in the keychain, even when the read-back throws
      await kc.delete(probe);
    }
    if (back?.kty === "probe")
      return new FallbackKeyStore(kc, file, opts.onFallback);
  } catch {
    // fall through to the file store
  }
  opts.onFallback?.(keychainRefusedLine());
  return file();
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
