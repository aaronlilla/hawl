import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "../test-tmp.ts";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { PcApprovalFields } from "@hawl/protocol/src/pc-approval.ts";
import {
  confirmKeys,
  type KeyListing,
  pinOnFirstUse,
  readPins,
} from "./passkey.ts";
import { fakePasskey } from "./passkey-fake.ts";
import { answerPcFile, type PcFileFrame } from "./pc-file.ts";

// The helper checks the owner's Allow itself: real P-256 signatures, real files, a local
// "relay" that records every PUT. The relay's word alone ("approved") never reads a file.
const ORIGIN = "https://hawl.ai";
const HELPER = "res_pc";
const owner = fakePasskey("owner-laptop");
const intruder = fakePasskey("relay-made");
let dir: string;
let relayUrl: string;
const puts: string[] = [];
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    puts.push(req.url ?? "");
    res.writeHead(200).end("{}");
  });
});
const listing = (...keys: ReturnType<typeof fakePasskey>[]): KeyListing => ({
  owner_user_id: "usr_owner",
  origin: ORIGIN,
  keys: keys.map((k) => ({
    id: k.credential_id,
    public_key: k.cose,
    name: "k",
  })),
});

before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "hawl-passkey-")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  relayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** A fresh PC paired with the owner's laptop passkey, and a file stat'd on it. */
async function paired(name: string) {
  const stateDir = await mkdtemp(join(tmpdir(), "hawl-passkey-state-"));
  assert.equal(
    await pinOnFirstUse(stateDir, HELPER, async () => listing(owner)),
    "pinned",
  );
  const path = join(dir, name);
  await writeFile(path, `contents of ${name}`);
  const sent = new Set<string>();
  const send = (f: Partial<PcFileFrame>) =>
    answerPcFile(
      { t: "pcfile", id: "req_1", op: "stat", path, ...f } as PcFileFrame,
      { relayUrl, sent, stateDir, residentId: HELPER },
    );
  const st = await send({ op: "stat" });
  const fields: PcApprovalFields = {
    request_id: `pcf_${name}`,
    helper_id: HELPER,
    path,
    bytes: st.bytes as number,
    mtime_ms: st.mtime_ms as number,
    ino: st.ino as string,
    to_id: "res_sam",
    exp: Date.now() + 5 * 60_000,
  };
  /** The relay's frame for `op` on this request; the approval is whatever the relay forwards. */
  const frame = (
    op: "hash" | "put",
    approval: unknown,
    o: Partial<PcFileFrame> = {},
  ) => ({
    op,
    request_id: fields.request_id,
    to: fields.to_id,
    bytes: fields.bytes,
    mtime_ms: fields.mtime_ms,
    ino: fields.ino,
    approval,
    ...(op === "put"
      ? { url: `${relayUrl}/v1/files/uploads/upl_${name}?sig=s` }
      : {}),
    ...o,
  });
  return { stateDir, path, fields, send, frame };
}

test("a passkey-signed approval of this exact request reads and uploads the file", async () => {
  const p = await paired("ok.csv");
  const h = await p.send(
    p.frame("hash", owner.approve(p.fields, { origin: ORIGIN })),
  );
  assert.equal(h.ok, true, String(h.reason));
  const before = puts.length;
  const put = await p.send({
    ...p.frame("put", owner.approve(p.fields, { origin: ORIGIN })),
    sha256: h.sha256 as string,
  });
  assert.equal(put.ok, true, String(put.reason));
  assert.equal(puts.length, before + 1);
});

test("the relay saying approved, with no passkey assertion, reads nothing", async () => {
  const p = await paired("forged.csv");
  // A path that does not exist: had the helper looked at the disk, it would say "no file".
  for (const approval of [undefined, { approved: true }, "approved"]) {
    const h = await p.send(
      p.frame("hash", approval, { path: join(dir, "missing.csv") }),
    );
    assert.equal(h.ok, false);
    assert.match(String(h.reason), /without your owner's passkey approval/);
  }
  const before = puts.length;
  const put = await p.send(p.frame("put", undefined));
  assert.match(String(put.reason), /without your owner's passkey approval/);
  assert.equal(puts.length, before);
});

test("an approval signed for another path, size, PC or recipient is refused", async () => {
  const p = await paired("exact.csv");
  const other = await paired("other.csv");
  for (const change of [
    { path: other.path },
    { bytes: p.fields.bytes + 1 },
    { mtime_ms: p.fields.mtime_ms + 1 },
    { ino: `${p.fields.ino}9` },
    { to_id: "res_mallory" },
    { helper_id: "res_other_pc" },
    { request_id: "pcf_other" },
  ]) {
    const a = owner.approve({ ...p.fields, ...change }, { origin: ORIGIN });
    const h = await p.send(p.frame("hash", a));
    assert.equal(h.ok, false, JSON.stringify(change));
    assert.match(String(h.reason), /approved a different file/);
  }
  // Signed on another site, or tampered with: refused too.
  const site = await p.send(
    p.frame(
      "hash",
      owner.approve(p.fields, { origin: "https://evil.example" }),
    ),
  );
  assert.match(String(site.reason), /did not check out/);
  const a = owner.approve(p.fields, { origin: ORIGIN });
  const bad = await p.send(
    p.frame("hash", {
      ...a,
      signature: intruder.approve(p.fields, { origin: ORIGIN }).signature,
    }),
  );
  assert.match(String(bad.reason), /did not check out/);
  // A tap with no PIN or biometric (user verified flag off) is not enough.
  const uv = await p.send(
    p.frame("hash", owner.approve(p.fields, { origin: ORIGIN, flags: 0x01 })),
  );
  assert.match(String(uv.reason), /did not check out/);
});

test("a replayed approval is refused", async () => {
  const p = await paired("replay.csv");
  const a = owner.approve(p.fields, { origin: ORIGIN });
  assert.equal((await p.send(p.frame("hash", a))).ok, true);
  const again = await p.send(p.frame("hash", a));
  assert.equal(again.ok, false);
  assert.match(String(again.reason), /already used/);
  // An older assertion (lower counter) on a new request does not pass either.
  const q = { ...p.fields, request_id: "pcf_replay_2" };
  const old = owner.approve(q, { origin: ORIGIN });
  assert.equal(
    (
      await p.send(
        p.frame("hash", owner.approve(q, { origin: ORIGIN }), {
          request_id: q.request_id,
        }),
      )
    ).ok,
    true,
  );
  const stale = await p.send(p.frame("put", old, { request_id: q.request_id }));
  assert.match(String(stale.reason), /seen before/);
});

test("an expired approval, or one that asks to live too long, is refused", async () => {
  const p = await paired("late.csv");
  const late = { ...p.fields, exp: Date.now() - 1 };
  const h = await p.send(
    p.frame("hash", owner.approve(late, { origin: ORIGIN })),
  );
  assert.match(String(h.reason), /ran out/);
  const long = { ...p.fields, exp: Date.now() + 60 * 60_000 };
  const l = await p.send(
    p.frame("hash", owner.approve(long, { origin: ORIGIN })),
  );
  assert.match(String(l.reason), /longer than 10 minutes/);
});

test("a key the relay swaps in is not trusted; a new key needs the owner's yes on this PC", async () => {
  const p = await paired("keys.csv");
  // The relay now lists only its own key: pairing already happened, so nothing changes.
  assert.equal(
    await pinOnFirstUse(p.stateDir, HELPER, async () => listing(intruder)),
    "known",
  );
  const pinned = readPins(p.stateDir).owners.usr_owner?.keys.map((k) => k.id);
  assert.deepEqual(pinned, [owner.credential_id]);
  const swapped = await p.send(
    p.frame("hash", intruder.approve(p.fields, { origin: ORIGIN })),
  );
  assert.match(String(swapped.reason), /does not trust yet/);

  // `hawl passkeys` on this PC: the owner says no, nothing changes.
  const phone = fakePasskey("owner-phone");
  let shown: string[] = [];
  const no = await confirmKeys(
    p.stateDir,
    [HELPER],
    listing(owner, phone),
    async (fresh) => {
      shown = fresh.map((k) => k.id);
      return false;
    },
  );
  assert.deepEqual(shown, [phone.credential_id]);
  assert.deepEqual(no, { added: 0, removed: 0 });
  const refused = await p.send(
    p.frame("hash", phone.approve(p.fields, { origin: ORIGIN })),
  );
  assert.match(String(refused.reason), /does not trust yet/);

  // The owner says yes: the new key works.
  const yes = await confirmKeys(
    p.stateDir,
    [HELPER],
    listing(owner, phone),
    async () => true,
  );
  assert.deepEqual(yes, { added: 1, removed: 0 });
  const ok = await p.send(
    p.frame("hash", phone.approve(p.fields, { origin: ORIGIN })),
  );
  assert.equal(ok.ok, true, String(ok.reason));
});

test("a PC that never paired refuses until the owner confirms a key there", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hawl-passkey-none-"));
  const path = join(dir, "unpaired.csv");
  await writeFile(path, "x");
  const out = await answerPcFile(
    {
      t: "pcfile",
      id: "r",
      op: "hash",
      path,
      approval: {
        credential_id: "x",
        client_data_json: "x",
        authenticator_data: "x",
        signature: "x",
        exp: Date.now() + 1000,
      },
    },
    { relayUrl, sent: new Set(), stateDir, residentId: HELPER },
  );
  assert.match(String(out.reason), /npx hawl\.ai passkeys/);
});

test("judge: confirming a key while a send runs never loses the used record, so a replay cannot upload twice", async () => {
  const p = await paired("confirm-race.csv");
  const a = owner.approve(p.fields, { origin: ORIGIN });
  const phone = fakePasskey("owner-phone-2");
  let answer: (yes: boolean) => void = () => {};
  // The owner is at the y/N prompt while the relay sends this request.
  const confirming = confirmKeys(
    p.stateDir,
    [HELPER],
    listing(owner, phone),
    () => new Promise<boolean>((r) => (answer = r)),
  );
  const h = await p.send(p.frame("hash", a));
  assert.equal(h.ok, true, String(h.reason));
  const put = await p.send({
    ...p.frame("put", a),
    sha256: h.sha256 as string,
  });
  assert.equal(put.ok, true, String(put.reason));
  answer(true);
  await confirming;
  assert.deepEqual(readPins(p.stateDir).used[p.fields.request_id]?.ops, [
    "hash",
    "put",
  ]);
  // The relay replays the same signed request with a new upload link.
  const before = puts.length;
  const again = await p.send({
    ...p.frame("put", a, {
      url: `${relayUrl}/v1/files/uploads/upl_replay?sig=s`,
    }),
    sha256: h.sha256 as string,
  });
  assert.equal(again.ok, false);
  assert.match(String(again.reason), /already used/);
  assert.equal(puts.length, before);
});

test("judge: two approvals in flight both go through with a counting passkey; a replay is still refused", async () => {
  const first = await paired("overlap-1.csv");
  // A second file on the same PC (same pins).
  const path2 = join(dir, "overlap-2.csv");
  await writeFile(path2, "second");
  const st2 = await first.send({ op: "stat", path: path2 });
  const f2 = {
    ...first.fields,
    request_id: "pcf_overlap-2",
    path: path2,
    bytes: st2.bytes as number,
    mtime_ms: st2.mtime_ms as number,
    ino: st2.ino as string,
  };
  // One assertion per approval, forwarded for both of its steps, as the relay does.
  const a1 = owner.approve(first.fields, { origin: ORIGIN });
  const a2 = owner.approve(f2, { origin: ORIGIN });
  const two = (
    op: "hash" | "put",
    a: unknown,
    extra: Partial<PcFileFrame> = {},
  ) =>
    first.frame(op, a, {
      request_id: f2.request_id,
      path: path2,
      bytes: f2.bytes,
      mtime_ms: f2.mtime_ms,
      ino: f2.ino,
      ...(op === "put"
        ? { url: `${relayUrl}/v1/files/uploads/upl_overlap2?sig=s` }
        : {}),
      ...extra,
    });
  const h1 = await first.send(first.frame("hash", a1));
  assert.equal(h1.ok, true, String(h1.reason));
  const h2 = await first.send(two("hash", a2));
  assert.equal(h2.ok, true, String(h2.reason));
  const p1 = await first.send({
    ...first.frame("put", a1),
    sha256: h1.sha256 as string,
  });
  assert.equal(p1.ok, true, String(p1.reason));
  const p2 = await first.send({
    ...two("put", a2),
    sha256: h2.sha256 as string,
  });
  assert.equal(p2.ok, true, String(p2.reason));
  // Replays: the same step again, or the first approval's assertion on another request.
  const r1 = await first.send({
    ...first.frame("put", a1, {
      url: `${relayUrl}/v1/files/uploads/upl_overlap1b?sig=s`,
    }),
    sha256: h1.sha256 as string,
  });
  assert.match(String(r1.reason), /already used/);
  const r2 = await first.send(two("hash", a1, { request_id: "pcf_overlap-3" }));
  assert.equal(r2.ok, false);
});

test("judge: `hawl passkeys` in another process, frozen after its last read, never erases the used record", async () => {
  const p = await paired("cross-process.csv");
  const a = owner.approve(p.fields, { origin: ORIGIN });
  const work = await mkdtemp(join(tmpdir(), "hawl-passkey-race-"));
  const list = join(work, "listing.json");
  await writeFile(
    list,
    JSON.stringify(listing(owner, fakePasskey("owner-phone-3"))),
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./passkey-race.child.ts", import.meta.url)),
      p.stateDir,
      list,
      work,
    ],
    { stdio: "inherit" },
  );
  const exited = new Promise((r) => child.on("exit", r));
  const has = (f: string) => existsSync(join(work, f));
  for (let i = 0; !has("paused"); i++) {
    assert.ok(i < 1000, "child never reached its last read");
    await delay(10);
  }
  // A real signed hash and put while the other process sits between its read and its write.
  // Without a lock both finish at once; with one they wait, so the child gets its go after 1 s.
  const before = puts.length;
  const chain = (async () => {
    const h = await p.send(p.frame("hash", a));
    assert.equal(h.ok, true, String(h.reason));
    const put = await p.send({
      ...p.frame("put", a),
      sha256: h.sha256 as string,
    });
    assert.equal(put.ok, true, String(put.reason));
    return h.sha256 as string;
  })();
  await Promise.race([chain, delay(1000)]);
  await writeFile(join(work, "go"), "");
  const sha = await chain;
  await exited;
  assert.ok(has("done"), "confirmKeys finished in the other process");
  assert.deepEqual(readPins(p.stateDir).used[p.fields.request_id]?.ops, [
    "hash",
    "put",
  ]);
  const again = await p.send({
    ...p.frame("put", a, {
      url: `${relayUrl}/v1/files/uploads/upl_cross_replay?sig=s`,
    }),
    sha256: sha,
  });
  assert.equal(again.ok, false);
  assert.equal(puts.length - before, 1, "exactly one PUT");
  // The key the owner confirmed in the other process is trusted too.
  assert.equal(readPins(p.stateDir).owners.usr_owner?.keys.length, 2);
});

test("judge: a helper that paired before the owner had a passkey pins the owner's first key, then holds it", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hawl-passkey-empty-"));
  // Paired while the owner had no passkey: an empty list.
  assert.equal(
    await pinOnFirstUse(stateDir, HELPER, async () => listing()),
    "pinned",
  );
  assert.deepEqual(readPins(stateDir).owners.usr_owner?.keys, []);
  const path = join(dir, "empty-first.csv");
  await writeFile(path, "first key");
  const sent = new Set<string>();
  let lists = 0;
  const send = (f: Partial<PcFileFrame>) =>
    answerPcFile(
      { t: "pcfile", id: "e", op: "stat", path, ...f } as PcFileFrame,
      {
        relayUrl,
        sent,
        stateDir,
        residentId: HELPER,
        // The owner has since added a passkey; the helper asks for the list when it needs a key.
        pinKeys: async () => {
          lists++;
          return listing(owner);
        },
      },
    );
  const st = await send({ op: "stat" });
  const fields: PcApprovalFields = {
    request_id: "pcf_empty-first",
    helper_id: HELPER,
    path,
    bytes: st.bytes as number,
    mtime_ms: st.mtime_ms as number,
    ino: st.ino as string,
    to_id: "res_sam",
    exp: Date.now() + 5 * 60_000,
  };
  const a = owner.approve(fields, { origin: ORIGIN });
  const base = {
    request_id: fields.request_id,
    to: fields.to_id,
    bytes: fields.bytes,
    mtime_ms: fields.mtime_ms,
    ino: fields.ino,
    approval: a,
  };
  const h = await send({ ...base, op: "hash" });
  assert.equal(h.ok, true, String(h.reason));
  const before = puts.length;
  const put = await send({
    ...base,
    op: "put",
    sha256: h.sha256 as string,
    url: `${relayUrl}/v1/files/uploads/upl_empty_first?sig=s`,
  });
  assert.equal(put.ok, true, String(put.reason));
  assert.equal(puts.length, before + 1);
  assert.equal(lists, 1, "listed once, only while no key was pinned");
  // Once a key is pinned, a later listing (the relay's own key) changes nothing.
  assert.equal(
    await pinOnFirstUse(stateDir, HELPER, async () => listing(intruder)),
    "known",
  );
  assert.deepEqual(
    readPins(stateDir).owners.usr_owner?.keys.map((k) => k.id),
    [owner.credential_id],
  );
});

test("judge: after an empty pairing, the next connect pins the owner's first key", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "hawl-passkey-empty2-"));
  await pinOnFirstUse(stateDir, HELPER, async () => listing());
  assert.equal(
    await pinOnFirstUse(stateDir, HELPER, async () => listing(owner)),
    "pinned",
  );
  assert.deepEqual(
    readPins(stateDir).owners.usr_owner?.keys.map((k) => k.id),
    [owner.credential_id],
  );
});
