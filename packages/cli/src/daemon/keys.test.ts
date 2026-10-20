import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { verifyEd25519 } from "@hawl/protocol/src/sign.ts";
import {
  FallbackKeyStore,
  generateWorkerKey,
  KEYCHAIN_SERVICE,
  KeychainStore,
  keychainRefusedLine,
  loadSigner,
  MemoryKeyStore,
  machineSecret,
  openKeyStore,
  PassphraseFileStore,
} from "./keys.ts";
import { tmpState } from "./testkit.ts";

test("passphrase file store round-trips, encrypts at rest, and rejects a wrong passphrase", async () => {
  const dir = tmpState();
  const { privateJwk } = generateWorkerKey();
  const store = new PassphraseFileStore(join(dir, "keys"), "correct horse");
  await store.set("res_a", privateJwk);
  assert.deepEqual(await store.get("res_a"), privateJwk);
  const raw = readFileSync(join(dir, "keys", "res_a.key"), "utf8");
  assert.equal(raw.includes(privateJwk.d as string), false);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, "keys", "res_a.key")).mode & 0o777, 0o600);
  }
  await assert.rejects(
    new PassphraseFileStore(join(dir, "keys"), "wrong").get("res_a"),
  );
  assert.equal(await store.get("res_missing"), null);
  await store.delete("res_a");
  assert.equal(await store.get("res_a"), null);
});

test("a signer made from a stored key signs what its public key verifies", async () => {
  const store = new MemoryKeyStore();
  const k = generateWorkerKey();
  await store.set("res_a", k.privateJwk);
  const signer = await loadSigner(store, "res_a");
  assert.ok(signer);
  assert.equal(signer.kid, k.kid);
  const sig = signer.sign(Buffer.from("x"));
  assert.equal(verifyEd25519(signer.publicKey, Buffer.from("x"), sig), true);
  assert.equal(await loadSigner(store, "res_none"), null);
});

test("openKeyStore falls back to a key file when the keychain is unusable: the passphrase, or a machine secret, with one plain line", async () => {
  const broken = {
    kind: "keychain" as const,
    get: async () => {
      throw new Error("no dbus");
    },
    set: async () => {
      throw new Error("no dbus");
    },
    delete: async () => {},
  };
  const dir = tmpState();
  const s = await openKeyStore({
    stateDir: dir,
    passphrase: "p",
    keychain: broken,
  });
  assert.equal(s.kind, "passphrase-file");
  // No passphrase: a random machine secret locks the file, and the person is told once.
  const lines: string[] = [];
  const dir2 = tmpState();
  const s2 = await openKeyStore({
    stateDir: dir2,
    keychain: broken,
    onFallback: (l) => lines.push(l),
  });
  assert.equal(s2.kind, "passphrase-file");
  assert.deepEqual(lines, [keychainRefusedLine()]);
  const k = generateWorkerKey();
  await s2.set("res_m", k.privateJwk);
  assert.deepEqual(await s2.get("res_m"), k.privateJwk);
  // A second open reads the same file with the same secret.
  const again = await openKeyStore({ stateDir: dir2, keychain: broken });
  assert.deepEqual(await again.get("res_m"), k.privateJwk);
});

test("a keychain write that throws goes to the key file, once with one plain line, and reads check both", async () => {
  const kcMap = new Map<string, Record<string, string>>();
  let refuse = false;
  const kc = {
    kind: "keychain" as const,
    get: async (a: string) => (kcMap.get(a) ?? null) as never,
    set: async (a: string, v: never) => {
      if (refuse) throw new Error("Platform failure: Windows error code 8");
      kcMap.set(a, v);
    },
    delete: async (a: string) => void kcMap.delete(a),
  };
  const dir = tmpState();
  const lines: string[] = [];
  const s = await openKeyStore({
    stateDir: dir,
    keychain: kc,
    passphrase: "p",
    onFallback: (l) => lines.push(l),
  });
  assert.ok(s instanceof FallbackKeyStore);
  assert.equal(s.kind, "keychain");
  const a = generateWorkerKey();
  const b = generateWorkerKey();
  const c = generateWorkerKey();
  await s.set("res_ok", a.privateJwk); // the keychain takes it
  refuse = true; // then the credential store fills up
  await s.set("res_b", b.privateJwk);
  await s.set("res_c", c.privateJwk);
  assert.equal(lines.length, 1, "told once, not per key");
  assert.deepEqual(lines, [keychainRefusedLine()]);
  assert.deepEqual(await s.get("res_ok"), a.privateJwk, "from the keychain");
  assert.deepEqual(await s.get("res_b"), b.privateJwk, "from the file");
  assert.equal(kcMap.has("res_b"), false);
  await s.delete("res_b");
  assert.equal(await s.get("res_b"), null);
});

test("HAWL_KEYSTORE=file never touches the keychain", async () => {
  let touched = 0;
  const kc = {
    kind: "keychain" as const,
    get: async () => {
      touched++;
      return null;
    },
    set: async () => {
      touched++;
    },
    delete: async () => {
      touched++;
    },
  };
  const s = await openKeyStore({
    stateDir: tmpState(),
    passphrase: "p",
    keychain: kc,
    fileOnly: true,
  });
  await s.set("res_f", generateWorkerKey().privateJwk);
  assert.equal(s.kind, "passphrase-file");
  assert.equal(touched, 0);
});

test("on Windows the machine secret is wrapped with DPAPI: not readable in the file, same value back", () => {
  // A stand-in for the PowerShell call: "protect" reverses the base64, "unprotect" reverses it back.
  const calls: string[] = [];
  const run = (script: string, input: string) => {
    const protect = script.includes("::Protect(");
    calls.push(protect ? "protect" : "unprotect");
    return [...input].reverse().join("");
  };
  const dir = tmpState();
  const secret = machineSecret(dir, { platform: "win32", run });
  assert.match(secret, /^[0-9a-f]{64}$/);
  const onDisk = readFileSync(join(dir, "keys", ".machine-secret"), "utf8");
  assert.ok(onDisk.startsWith("dpapi:v1:"), "wrapped");
  assert.equal(
    onDisk.includes(secret),
    false,
    "the plain secret is not in the file",
  );
  assert.equal(machineSecret(dir, { platform: "win32", run }), secret);
  assert.deepEqual(calls, ["protect", "unprotect"]);
});

test("a plain machine secret from an earlier build is wrapped on first read on Windows", () => {
  const dir = tmpState();
  const plain = "ab".repeat(32);
  mkdirSync(join(dir, "keys"), { recursive: true });
  writeFileSync(join(dir, "keys", ".machine-secret"), `${plain}\n`);
  const run = (_s: string, input: string) => [...input].reverse().join("");
  assert.equal(machineSecret(dir, { platform: "win32", run }), plain);
  const onDisk = readFileSync(join(dir, "keys", ".machine-secret"), "utf8");
  assert.ok(onDisk.startsWith("dpapi:v1:"));
  assert.equal(machineSecret(dir, { platform: "win32", run }), plain);
});

test("if DPAPI is unavailable the secret still works (plain file, user-only ACL) and macOS/Linux never call PowerShell", () => {
  const boom = () => {
    throw new Error("powershell missing");
  };
  const dir = tmpState();
  const s = machineSecret(dir, { platform: "win32", run: boom });
  assert.match(s, /^[0-9a-f]{64}$/);
  assert.equal(machineSecret(dir, { platform: "win32", run: boom }), s);
  let called = 0;
  const other = machineSecret(tmpState(), {
    platform: "linux",
    run: () => {
      called++;
      return "";
    },
  });
  assert.match(other, /^[0-9a-f]{64}$/);
  assert.equal(called, 0);
});

test("the machine secret is made once, stays the same and is owner-only", () => {
  const dir = tmpState();
  const one = machineSecret(dir);
  assert.match(one, /^[0-9a-f]{64}$/);
  assert.equal(machineSecret(dir), one);
  if (process.platform !== "win32")
    assert.equal(
      statSync(join(dir, "keys", ".machine-secret")).mode & 0o777,
      0o600,
    );
});

test("OS keychain stores and deletes a key (skipped where no keychain exists)", async (t) => {
  let kc: KeychainStore;
  try {
    kc = new KeychainStore();
    await kc.set("hawl-test-probe", { kty: "t" });
  } catch {
    return t.skip("no OS keychain on this machine");
  }
  try {
    assert.deepEqual(await kc.get("hawl-test-probe"), { kty: "t" });
  } finally {
    await kc.delete("hawl-test-probe");
  }
  assert.equal(await kc.get("hawl-test-probe"), null);
});

/** In-memory stand-in for @napi-rs/keyring's Entry; records every (service, account). */
function fakeKeyring(o: { throwOnDelete?: boolean } = {}) {
  const vault = new Map<string, string>();
  const opened: [string, string][] = [];
  class Entry {
    readonly k: string;
    constructor(service: string, account: string) {
      opened.push([service, account]);
      this.k = `${service}/${account}`;
    }
    setPassword(p: string) {
      vault.set(this.k, p);
    }
    getPassword() {
      return vault.get(this.k) ?? null;
    }
    deletePassword() {
      if (o.throwOnDelete) throw new Error("no such entry");
      return vault.delete(this.k);
    }
  }
  return { Entry, vault, opened };
}

test("keychain store uses service hawl with the resident id as account and round-trips the JWK as JSON", async () => {
  const f = fakeKeyring();
  const kc = new KeychainStore(f.Entry);
  const { privateJwk } = generateWorkerKey();
  await kc.set("res_a", privateJwk);
  assert.equal(KEYCHAIN_SERVICE, "hawl");
  assert.deepEqual(f.opened, [["hawl", "res_a"]]);
  assert.deepEqual(JSON.parse(f.vault.get("hawl/res_a") as string), privateJwk);
  assert.deepEqual(await kc.get("res_a"), privateJwk);
  assert.equal(await kc.get("res_b"), null);
  await kc.delete("res_a");
  assert.equal(await kc.get("res_a"), null);
});

test("keychain get treats an empty password as no key", async () => {
  const f = fakeKeyring();
  f.vault.set("hawl/res_a", "");
  assert.equal(await new KeychainStore(f.Entry).get("res_a"), null);
});

test("keychain delete swallows a throw from the OS (entry already gone)", async () => {
  const f = fakeKeyring({ throwOnDelete: true });
  await new KeychainStore(f.Entry).delete("res_gone");
});

test("keychain is preferred when the probe round-trips, and the probe entry is removed", async () => {
  const f = fakeKeyring();
  const kc = new KeychainStore(f.Entry);
  const s = await openKeyStore({
    stateDir: tmpState(),
    passphrase: "p",
    keychain: kc,
  });
  assert.ok(s instanceof FallbackKeyStore);
  assert.equal(s.kind, "keychain");
  const probes = f.opened.filter(([, a]) => a.startsWith("probe-"));
  assert.ok(probes.length > 0);
  assert.ok(probes.every(([svc]) => svc === "hawl"));
  assert.equal(f.vault.size, 0);
});

test("passphrase file is bound to its account: res_a.key copied to res_b.key does not decrypt", async () => {
  const dir = tmpState();
  const store = new PassphraseFileStore(join(dir, "keys"), "correct horse");
  await store.set("res_a", generateWorkerKey().privateJwk);
  writeFileSync(
    join(dir, "keys", "res_b.key"),
    readFileSync(join(dir, "keys", "res_a.key")),
  );
  await assert.rejects(store.get("res_b"));
});

test("passphrase file with tampered ciphertext or tag fails to decrypt", async () => {
  const dir = tmpState();
  const store = new PassphraseFileStore(join(dir, "keys"), "correct horse");
  const { privateJwk } = generateWorkerKey();
  await store.set("res_a", privateJwk);
  const f = join(dir, "keys", "res_a.key");
  const rec = JSON.parse(readFileSync(f, "utf8")) as Record<string, string>;
  const flip = (b64: string) => {
    const b = Buffer.from(b64, "base64url");
    b[0] = (b[0] as number) ^ 1;
    return b.toString("base64url");
  };
  for (const field of ["ct", "tag"] as const) {
    writeFileSync(
      f,
      JSON.stringify({ ...rec, [field]: flip(rec[field] as string) }),
    );
    await assert.rejects(store.get("res_a"), Error, field);
  }
  writeFileSync(f, JSON.stringify(rec));
  assert.deepEqual(await store.get("res_a"), privateJwk);
});

test("a keychain probe whose read-back throws is still removed, and the passphrase file is used", async () => {
  const f = fakeKeyring();
  const kc = new KeychainStore(f.Entry);
  kc.get = async () => {
    throw new Error("locked");
  };
  const s = await openKeyStore({
    stateDir: tmpState(),
    passphrase: "p",
    keychain: kc,
  });
  assert.equal(s.kind, "passphrase-file");
  assert.equal(f.vault.size, 0);
});
