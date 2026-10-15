import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { verifyEd25519 } from "@hawl/protocol/src/sign.ts";
import {
  generateWorkerKey,
  KEYCHAIN_SERVICE,
  KeychainStore,
  loadSigner,
  MemoryKeyStore,
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

test("openKeyStore falls back to the passphrase file when the keychain is unusable, and refuses without one", async () => {
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
  await assert.rejects(
    openKeyStore({ stateDir: dir, keychain: broken }),
    /no usable OS keychain/,
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
  assert.equal(s, kc);
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
