import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { b64url, fromB64url } from "@hawl/protocol/src/hash.ts";
import { jcsBytes } from "@hawl/protocol/src/jcs.ts";
import { importPublicJwk, verifyDetached } from "@hawl/protocol/src/sign.ts";
import { MemoryKeyStore } from "../daemon/keys.ts";
import type { DaemonLink } from "../mcp/server.ts";
import { readTownFile } from "../town-file.ts";
import { codexTrusted, doctor, doctorChecks } from "./doctor.ts";
import {
  type JoinDeps,
  JoinError,
  join as joinCmd,
  parseSite,
} from "./join.ts";
import { leave } from "./leave.ts";
import { renderStatus, status, statusReport } from "./status.ts";

const RELAY = "https://relay.test";

const LOOP_CODE = "L".repeat(43);

function world(
  opts: { claimAfter?: number; needsOwner?: boolean; loopback?: boolean } = {},
) {
  // The start body as the CLI sent it.
  let loopStart: any = null;
  let loopClaims = 0;
  const root = mkdtempSync(join(tmpdir(), "hawl-cmd-"));
  const projectDir = join(root, "my-app");
  const home = join(root, "home");
  const stateDir = join(root, "state");
  for (const d of [projectDir, home, stateDir])
    mkdirSync(d, { recursive: true });

  const lines: string[] = [];
  const calls: { url: string; method: string; body?: any; auth?: string }[] =
    [];
  let claims = 0;
  let publicJwk: Record<string, string> | undefined;
  let revoked = false;
  const claimAfter = opts.claimAfter ?? 2;

  const fetchFn = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const auth = (init?.headers as Record<string, string> | undefined)
      ?.authorization;
    calls.push({ url, method, body, auth });
    const json = (
      code: number,
      v: unknown,
      headers: Record<string, string> = {},
    ) =>
      new Response(JSON.stringify(v), {
        status: code,
        headers: { "content-type": "application/json", ...headers },
      });
    if (url === `${RELAY}/v1/join/start`) {
      publicJwk = body.public_jwk;
      // A relay with one-click join: the link carries the join id and state, never the code.
      if (opts.loopback && body.code_challenge) {
        loopStart = body;
        return json(201, {
          join_id: "jrq_01LOOP",
          user_code: "LOOP-CODE",
          key_fingerprint: "7F3A-0000-1111-2222",
          expires_in: 300,
          loopback: true,
          verification_url: `https://hawl.ai/device?join=jrq_01LOOP&state=${body.state}`,
        });
      }
      return json(201, {
        join_id: "jrq_01TEST",
        user_code: "ABCD-EFGH",
        key_fingerprint: "7F3A-0000-1111-2222",
        expires_in: 300,
        verification_url: "https://hawl.ai/device?code=ABCD-EFGH",
      });
    }
    if (url === `${RELAY}/v1/join/jrq_01TEST/claim`) {
      assert.ok(publicJwk);
      const ok = verifyDetached(
        "EdDSA",
        importPublicJwk(publicJwk),
        jcsBytes({ join_id: "jrq_01TEST", nonce: body.nonce, ts: body.ts }),
        body.sig,
      );
      if (!ok) return json(404, { error: "not_found" });
      claims++;
      if (claims < claimAfter) return json(202, { state: "pending" });
      return json(200, {
        resident_id: "res_01WORKER",
        kid: "key_TEST",
        town_id: "twn_01TOWN",
        relay_url: RELAY,
        needs_owner_approval: opts.needsOwner ?? false,
      });
    }
    if (url === `${RELAY}/v1/join/jrq_01LOOP/claim`) {
      assert.ok(publicJwk && loopStart);
      const signed = verifyDetached(
        "EdDSA",
        importPublicJwk(publicJwk),
        jcsBytes({ join_id: "jrq_01LOOP", nonce: body.nonce, ts: body.ts }),
        body.sig,
      );
      const pkceOk =
        body.code === LOOP_CODE &&
        typeof body.code_verifier === "string" &&
        b64url(createHash("sha256").update(body.code_verifier).digest()) ===
          loopStart.code_challenge;
      if (!signed || !pkceOk) return json(404, { error: "not_found" });
      loopClaims++;
      return json(200, {
        resident_id: "res_01WORKER",
        kid: "key_TEST",
        town_id: "twn_01TOWN",
        relay_url: RELAY,
        needs_owner_approval: false,
      });
    }
    if (url === `${RELAY}/v1/auth/token`) {
      const [h, p, s] = String(body.client_assertion).split(".") as [
        string,
        string,
        string,
      ];
      const head = JSON.parse(fromB64url(h).toString());
      const pay = JSON.parse(fromB64url(p).toString());
      assert.equal(head.alg, "EdDSA");
      assert.equal(head.kid, "key_TEST");
      assert.equal(pay.iss, "res_01WORKER");
      assert.equal(pay.sub, "res_01WORKER");
      assert.equal(pay.aud, RELAY);
      assert.ok(pay.exp - pay.iat <= 60);
      assert.ok(
        verifyDetached(
          "EdDSA",
          importPublicJwk(publicJwk as Record<string, string>),
          Buffer.from(`${h}.${p}`),
          s,
        ),
      );
      return json(200, {
        access_token: "tok_1",
        token_type: "Bearer",
        expires_in: 600,
      });
    }
    if (url === `${RELAY}/v1/residents/me` && method === "DELETE") {
      assert.equal(auth, "Bearer tok_1");
      revoked = true;
      return json(200, { ok: true });
    }
    if (url === `${RELAY}/healthz`)
      return json(200, { status: "ok" }, { date: new Date().toUTCString() });
    if (url.startsWith("http://127.0.0.1:4318/")) return json(200, {});
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;

  const daemonCalls: { op: string; args: any }[] = [];
  let sent = false;
  const daemon: DaemonLink = {
    async call(op, args: any = {}) {
      daemonCalls.push({ op, args });
      if (op === "attach" || op === "detach") return { ok: true };
      if (op === "resolve")
        return {
          to: { kind: "worker", resident_id: "res_01DISPATCHER" },
          conversation_id: null,
          reply_to: null,
        };
      if (op === "send") {
        sent = true;
        return { accepted: true };
      }
      if (op === "mailbox")
        return { envelopes: sent ? [{ relay: { origin: "system" } }] : [] };
      if (op === "status")
        return {
          pid: 4242,
          version: "1.2.3",
          workers: [
            {
              resident_id: "res_01WORKER",
              platform: "claude_code",
              state: "connected",
              queued: 2,
              unread: 3,
            },
          ],
        };
      throw new Error(`unexpected op ${op}`);
    },
  };

  const keyStore = new MemoryKeyStore();
  const deps: JoinDeps = {
    fetch: fetchFn,
    print: (l) => lines.push(l),
    sleep: async () => {},
    stateDir,
    home,
    keyStore,
    relayUrl: RELAY,
    pollMs: 1,
    roundTripMs: 1000,
    ensureDaemon: async () => {},
    daemon: () => daemon,
    // Never open a real browser from a test.
    canOpen: () => false,
  };
  return {
    root,
    projectDir,
    home,
    stateDir,
    lines,
    calls,
    daemonCalls,
    deps,
    keyStore,
    isRevoked: () => revoked,
    loopStart: () => loopStart,
    loopClaims: () => loopClaims,
    typedClaims: () => claims,
  };
}

/** The person's browser after Approve: the page sends it to the CLI's loopback with the code. */
async function browserApproves(link: string, redirectUri: string) {
  const state = new URL(link).searchParams.get("state") ?? "";
  const r = await fetch(`${redirectUri}?code=${LOOP_CODE}&state=${state}`);
  assert.equal(r.status, 200);
}

test("parseSite takes a slug or a site URL", () => {
  assert.equal(parseSite("acme"), "acme");
  assert.equal(parseSite("hawl.ai/t/acme"), "acme");
  assert.equal(parseSite("https://hawl.ai/t/acme-co/"), "acme-co");
  assert.throws(() => parseSite("https://hawl.ai/"), JoinError);
});

test("join: previews, prints the code, polls every 5 s, writes, round-trips, prints one restart line per tool", async () => {
  const w = world({ claimAfter: 3 });
  writeFileSync(
    join(w.projectDir, ".mcp.json"),
    '{\n    "mcpServers": { "other": { "command": "x" } }\n}\n',
  );
  const mcpBefore = readFileSync(join(w.projectDir, ".mcp.json"));
  mkdirSync(join(w.projectDir, ".git", "info"), { recursive: true });
  const exclFile = join(w.projectDir, ".git", "info", "exclude");
  const sleeps: number[] = [];
  w.deps.sleep = async (ms) => {
    sleeps.push(ms);
  };
  w.deps.pollMs = 5000;

  const r = await joinCmd(
    {
      site: "hawl.ai/t/acme",
      hosts: ["claude_code", "codex"],
      projectDir: w.projectDir,
    },
    w.deps,
  );

  const out = w.lines.join("\n");
  assert.match(out, /Config changes/);
  assert.match(out, /\.mcp\.json/);
  assert.match(out, /Open hawl\.ai\/device and type ABCD-EFGH/);
  assert.doesNotMatch(out, /device\?code=/);
  assert.match(out, /Fingerprint 7F3A-0000-1111-2222/);
  assert.doesNotMatch(out, /warning|failed|Dispatcher|round trip/i);
  assert.deepEqual(
    sleeps,
    [5000, 5000],
    "two pending claims, polled every 5 s",
  );
  assert.match(out, /Joined acme\. Hawl answered a test message\./);
  assert.match(
    out,
    /Now restart Claude Code in this folder: close it and run `claude` again/,
  );
  assert.match(
    out,
    /Now restart Codex in this folder: close it and run `codex` again/,
  );

  assert.equal(r.resident_id, "res_01WORKER");
  assert.equal(r.roundtrip, "ok");
  assert.ok(
    await w.keyStore.get("res_01WORKER"),
    "key stored under the resident id",
  );
  const start = w.calls.find((c) => c.url.endsWith("/v1/join/start"));
  assert.equal(start?.body.town_slug, "acme");
  assert.equal(start?.body.platform, "claude_code");
  assert.equal(start?.body.folder_label, "my-app");
  assert.equal(
    start?.body.public_jwk.d,
    undefined,
    "private key never leaves the machine",
  );
  assert.deepEqual(
    w.daemonCalls
      .map((c) => c.op)
      .filter((o) => ["attach", "resolve", "send", "mailbox"].includes(o))
      .slice(0, 3),
    ["attach", "resolve", "send"],
  );

  const mcp = JSON.parse(readFileSync(join(w.projectDir, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.other.command, "x");
  assert.equal(
    mcp.mcpServers.hawl.env,
    undefined,
    "a pulled .mcp.json carries no id",
  );
  assert.equal(
    JSON.parse(
      readFileSync(join(w.projectDir, ".hawl", "claude_code.json"), "utf8"),
    ).resident_id,
    "res_01WORKER",
  );
  assert.ok(readFileSync(exclFile, "utf8").split("\n").includes(".hawl/"));
  assert.equal(
    existsSync(join(w.home, ".claude", "settings.json")),
    false,
    "join writes nothing under home",
  );
  assert.ok(existsSync(join(w.projectDir, ".codex", "config.toml")));

  const town = readTownFile(w.projectDir);
  assert.equal(town?.v, 1);
  assert.match(town?.village_id ?? "", /^vil_/);
  assert.equal(town?.folder_label, "my-app");
  assert.equal(town?.memberships[0]?.town_slug, "acme");
  assert.equal(town?.memberships[0]?.workers[0]?.resident_id, "res_01WORKER");
  assert.ok(
    town?.written.some(
      (e) =>
        e.path === ".mcp.json" &&
        e.key === "mcpServers.hawl" &&
        /^[0-9a-f]{64}$/.test(e.sha256),
    ),
  );
  assert.equal(
    readFileSync(join(w.projectDir, ".hawl", ".gitignore"), "utf8"),
    "*\n",
  );
  assert.ok(
    !readFileSync(join(w.projectDir, ".hawl", "hawl.json"), "utf8").includes(
      '"d"',
    ),
    "no secrets in hawl.json",
  );

  // leave: revoke, then the configs go back to the original bytes
  const l = await leave({ projectDir: w.projectDir }, w.deps);
  assert.deepEqual(l.left, ["res_01WORKER"]);
  assert.ok(w.isRevoked());
  assert.equal(
    await w.keyStore.get("res_01WORKER"),
    null,
    "keychain entry deleted",
  );
  assert.deepEqual(readFileSync(join(w.projectDir, ".mcp.json")), mcpBefore);
  assert.equal(existsSync(join(w.projectDir, ".codex")), false);
  assert.equal(existsSync(join(w.projectDir, ".hawl")), false);
  assert.equal(existsSync(join(w.home, ".claude", "settings.json")), false);
  assert.equal(
    readFileSync(exclFile, "utf8").includes(".hawl/"),
    false,
    "exclude line removed",
  );
  const detach = w.daemonCalls.find((c) => c.op === "detach");
  assert.equal(detach?.args.destroy_spool, true, "spool deleted");
});

test("join typed code: a /device?code= link (older relay) is never opened or printed; the code is typed", async () => {
  const opened: string[] = [];
  const open = (u: string) => {
    opened.push(u);
    return true;
  };
  // world() without loopback answers like an older relay: typed join plus a ?code= link.
  const w = world({ claimAfter: 1 });
  await joinCmd(
    { site: "acme", hosts: ["cursor"], projectDir: w.projectDir },
    { ...w.deps, canOpen: () => true, openUrl: open },
  );
  assert.deepEqual(opened, []);
  const out = w.lines.join("\n");
  assert.match(out, /Open hawl\.ai\/device and type ABCD-EFGH/);
  assert.match(out, /Fingerprint 7F3A-0000-1111-2222/);
  assert.doesNotMatch(out, /device\?code=/);

  for (const [name, o, d] of [
    ["--no-open", { noOpen: true }, { canOpen: () => true }],
    ["no display", {}, { canOpen: () => false }],
    ["agent-run (--yes)", { yes: true }, { canOpen: () => true }],
  ] as const) {
    const x = world({ claimAfter: 1 });
    opened.length = 0;
    await joinCmd(
      { site: "acme", hosts: ["cursor"], projectDir: x.projectDir, ...o },
      { ...x.deps, ...d, openUrl: open },
    );
    assert.deepEqual(opened, [], name);
    assert.match(x.lines.join("\n"), /ABCD-EFGH/, name);
    assert.doesNotMatch(x.lines.join("\n"), /device\?code=/, name);
    assert.equal(
      x.calls.find((c) => c.url.endsWith("/v1/join/start"))?.body
        .code_challenge,
      undefined,
      `${name}: no loopback listener`,
    );
  }
});

test("join one-click: opens the Approve link (no code in it), the browser's loopback callback finishes the join with code + verifier", async () => {
  const w = world({ loopback: true });
  const opened: string[] = [];
  const r = await joinCmd(
    { site: "acme", hosts: ["cursor"], projectDir: w.projectDir },
    {
      ...w.deps,
      canOpen: () => true,
      openUrl: async (u) => {
        opened.push(u);
        await browserApproves(u, w.loopStart().redirect_uri);
        return true;
      },
    },
  );
  assert.equal(r.resident_id, "res_01WORKER");
  const sent = w.loopStart();
  assert.equal(sent.code_challenge_method, "S256");
  assert.match(sent.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/cb$/);
  assert.deepEqual(opened, [
    `https://hawl.ai/device?join=jrq_01LOOP&state=${sent.state}`,
  ]);
  assert.equal(w.loopClaims(), 1);
  assert.equal(w.typedClaims(), 0, "no typed-code join");
  const out = w.lines.join("\n");
  assert.match(out, /Opening your browser/);
  assert.match(out, /The page must show fingerprint 7F3A-0000-1111-2222/);
  assert.doesNotMatch(out, /LOOP-CODE|ABCD-EFGH/, "nothing to type");
  // The listener is gone once the join is done.
  await assert.rejects(fetch(sent.redirect_uri));
});

test("join one-click: no callback in time falls back to the typed code, and a late callback still finishes", async () => {
  // Fallback: the typed join is approved.
  const w = world({ loopback: true, claimAfter: 1 });
  await joinCmd(
    { site: "acme", hosts: ["cursor"], projectDir: w.projectDir },
    {
      ...w.deps,
      canOpen: () => true,
      openUrl: () => true,
      loopbackWaitMs: 20,
    },
  );
  assert.equal(w.typedClaims(), 1);
  assert.equal(w.loopClaims(), 0);
  const out = w.lines.join("\n");
  assert.match(out, /Open hawl\.ai\/device and type ABCD-EFGH/);
  const starts = w.calls.filter((c) => c.url.endsWith("/v1/join/start"));
  assert.equal(starts.length, 2);
  assert.equal(starts[1]?.body.code_challenge, undefined);
  assert.deepEqual(
    starts[1]?.body.public_jwk,
    starts[0]?.body.public_jwk,
    "same key, same fingerprint",
  );

  // Late callback: the typed code is shown, then the browser approves the one-click join.
  const x = world({ loopback: true, claimAfter: 1_000_000 });
  let link = "";
  let polls = 0;
  await joinCmd(
    { site: "acme", hosts: ["cursor"], projectDir: x.projectDir },
    {
      ...x.deps,
      canOpen: () => true,
      openUrl: (u) => {
        link = u;
        return true;
      },
      loopbackWaitMs: 20,
      sleep: async () => {
        if (++polls === 3)
          await browserApproves(link, x.loopStart().redirect_uri);
      },
    },
  );
  assert.equal(x.loopClaims(), 1);
  assert.match(x.lines.join("\n"), /ABCD-EFGH/);
});

test("join one-click: a listener that cannot start, or a relay without one-click join, uses the typed code", async () => {
  const opened: string[] = [];
  const w = world({ loopback: true });
  await joinCmd(
    { site: "acme", hosts: ["cursor"], projectDir: w.projectDir },
    {
      ...w.deps,
      canOpen: () => true,
      openUrl: (u) => {
        opened.push(u);
        return true;
      },
      loopback: async () => null,
    },
  );
  assert.equal(w.loopStart(), null, "no challenge sent");
  assert.deepEqual(opened, [], "the typed flow opens no link");
  assert.match(w.lines.join("\n"), /type ABCD-EFGH/);
  assert.equal(w.typedClaims() > 0, true);
});

test("join: a browser that fails to open (error, false, hang) never fails or slows the join; the link is printed", async () => {
  const openers: [string, (u: string) => boolean | Promise<boolean>][] = [
    ["returns false", () => false],
    [
      "throws",
      () => {
        throw new Error("Platform failure: Windows error code 8");
      },
    ],
    ["rejects", () => Promise.reject(new Error("spawn failed"))],
  ];
  for (const [name, openUrl] of openers) {
    // One-click link that cannot open: it is printed, then the typed code finishes the join.
    const w = world({ loopback: true, claimAfter: 1 });
    const t0 = Date.now();
    const r = await joinCmd(
      { site: "acme", hosts: ["cursor"], projectDir: w.projectDir },
      { ...w.deps, canOpen: () => true, openUrl, loopbackWaitMs: 20 },
    );
    assert.equal(r.resident_id, "res_01WORKER", name);
    const out = w.lines.join("\n");
    assert.match(
      out,
      /Open this link to approve: https:\/\/hawl\.ai\/device\?join=jrq_01LOOP&state=/,
      name,
    );
    assert.match(out, /type ABCD-EFGH/, name);
    assert.match(out, /Waiting for approval/, name);
    assert.doesNotMatch(out, /Opening your browser/, name);
    assert.ok(Date.now() - t0 < 10_000, `${name} did not slow the join`);
  }
});

test("join: owner approval note, and a rejected code stops with a clear error", async () => {
  const w = world({ needsOwner: true, claimAfter: 1 });
  const r = await joinCmd(
    { site: "acme", hosts: ["cursor"], projectDir: w.projectDir },
    w.deps,
  );
  assert.equal(r.needs_owner_approval, true);
  assert.match(
    w.lines.join("\n"),
    /Waiting for the site owner to let this agent in/,
  );
  assert.equal(r.roundtrip, "skipped");
  assert.doesNotMatch(w.lines.join("\n"), /did not finish|doctor/);

  const w2 = world();
  const real = w2.deps.fetch as typeof fetch;
  w2.deps.fetch = (async (u: any, i?: RequestInit) =>
    String(u).includes("/claim")
      ? new Response("{}", { status: 404 })
      : real(u, i)) as typeof fetch;
  await assert.rejects(
    joinCmd(
      { site: "acme", hosts: ["claude_code"], projectDir: w2.projectDir },
      w2.deps,
    ),
    /expired or was not approved/,
  );
  assert.equal(
    existsSync(join(w2.projectDir, ".mcp.json")),
    false,
    "nothing written without approval",
  );
});

test("join: a file the user owns keeps their value and the skip is reported", async () => {
  const w = world({ claimAfter: 1 });
  mkdirSync(join(w.projectDir, ".codex"), { recursive: true });
  writeFileSync(
    join(w.projectDir, ".codex", "config.toml"),
    "[hooks.PostToolUse]\nmine = true\n",
  );
  const r = await joinCmd(
    { site: "acme", hosts: ["codex"], projectDir: w.projectDir },
    w.deps,
  );
  assert.ok(r.skipped.some((s) => s.key === "hooks.PostToolUse"));
  assert.match(
    w.lines.join("\n"),
    /Skipped \.codex\/config\.toml hooks\.PostToolUse/,
  );
  assert.match(
    readFileSync(join(w.projectDir, ".codex", "config.toml"), "utf8"),
    /mine = true/,
  );
});

test("leave: several sites need --site or --all; nothing happens on error", async () => {
  const w = world({ claimAfter: 1 });
  await joinCmd(
    { site: "acme", hosts: ["claude_code"], projectDir: w.projectDir },
    w.deps,
  );
  await assert.rejects(
    leave({ projectDir: w.projectDir, site: "nope" }, w.deps),
    /no membership for site nope/,
  );
  assert.equal(w.isRevoked(), false);
  await leave({ projectDir: w.projectDir, site: "acme" }, w.deps);
  assert.ok(w.isRevoked());
  await assert.rejects(
    leave({ projectDir: w.projectDir }, w.deps),
    /no hawl membership/,
  );
});

test("status: folder -> yard -> sites with queue and unread, daemon pid and channel; --json parses", async () => {
  const w = world({ claimAfter: 1 });
  await joinCmd(
    { site: "acme", hosts: ["claude_code"], projectDir: w.projectDir },
    w.deps,
  );
  writeFileSync(
    join(w.stateDir, "config.json"),
    '{"update":{"channel":"next"}}',
  );
  const rep = await statusReport({ projectDir: w.projectDir }, w.deps);
  const text = renderStatus(rep);
  assert.match(
    text,
    /yard my-app -> sites: acme\(res_01WORKER, claude_code, connected\/queued 2, unread 3\)/,
  );
  assert.match(text, /daemon pid 4242 v1\.2\.3, update channel next/);
  const lines: string[] = [];
  await status(
    { projectDir: w.projectDir, json: true },
    { ...w.deps, print: (l) => lines.push(l) },
  );
  assert.equal(JSON.parse(lines[0] as string).sites[0].unread, 3);

  const down = await statusReport(
    { projectDir: w.projectDir },
    {
      ...w.deps,
      daemon: () => ({
        call: async () => {
          throw new Error("no daemon");
        },
      }),
    },
  );
  assert.equal(down.daemon.running, false);
  assert.equal(down.sites[0]?.state, "not attached");
});

test("doctor: reports config, Codex folder and hook trust, keychain, daemon, relay, clock skew, activity live", async () => {
  const w = world({ claimAfter: 1 });
  await joinCmd(
    { site: "acme", hosts: ["claude_code", "codex"], projectDir: w.projectDir },
    w.deps,
  );
  const codexHome = join(w.root, "codex-home");
  mkdirSync(codexHome);

  let checks = await doctorChecks(
    { projectDir: w.projectDir, codexHome },
    w.deps,
  );
  const by = (n: string) => checks.find((c) => c.name === n);
  assert.equal(by("claude_code config")?.state, "ok");
  assert.equal(by("codex config")?.state, "ok");
  assert.equal(
    by("codex trust")?.state,
    "manual",
    "untrusted folder is a manual step, not a failure",
  );
  assert.match(by("codex trust")?.detail ?? "", /trust this folder/);
  assert.equal(by("codex hook trust")?.state, "manual");
  assert.equal(by("claude_code approval")?.state, "manual");
  assert.equal(by("key res_01WORKER")?.state, "ok");
  assert.equal(by("daemon")?.state, "ok");
  assert.equal(by("relay acme")?.state, "ok");
  assert.equal(by("clock skew")?.state, "ok");
  assert.equal(by("activity claude_code")?.detail, "activity: live");
  assert.equal(by("activity codex")?.detail, "activity: live");

  // SPK-6: trust is a backslash path key with a literal string.
  writeFileSync(
    join(codexHome, "config.toml"),
    `[projects.'${w.projectDir.replace(/\//g, "\\")}']\ntrust_level = "trusted"\n`,
  );
  assert.equal(codexTrusted(w.projectDir, codexHome), true);
  checks = await doctorChecks({ projectDir: w.projectDir, codexHome }, w.deps);
  assert.equal(checks.find((c) => c.name === "codex trust")?.state, "ok");

  // Daemon down: receiver unreachable, so activity is not live and the daemon check fails.
  const dead = {
    ...w.deps,
    daemon: () =>
      ({
        call: async () => {
          throw new Error("down");
        },
      }) as DaemonLink,
    fetch: (async (u: any, i?: RequestInit) => {
      if (String(u).startsWith("http://127.0.0.1"))
        throw new Error("ECONNREFUSED");
      return (w.deps.fetch as typeof fetch)(u, i);
    }) as typeof fetch,
  };
  const res = await doctor(
    { projectDir: w.projectDir, codexHome },
    { ...dead, print: () => {} },
  );
  assert.equal(res.exitCode, 1);
  assert.equal(res.checks.find((c) => c.name === "daemon")?.state, "fail");
  assert.match(
    res.checks.find((c) => c.name === "activity claude_code")?.detail ?? "",
    /not live/,
  );
});

test("doctor: clock skew over 30 s fails", async () => {
  const w = world({ claimAfter: 1 });
  await joinCmd(
    { site: "acme", hosts: ["claude_code"], projectDir: w.projectDir },
    w.deps,
  );
  const real = w.deps.fetch as typeof fetch;
  w.deps.fetch = (async (u: any, i?: RequestInit) => {
    if (String(u).endsWith("/healthz"))
      return new Response("{}", {
        status: 200,
        headers: { date: new Date(Date.now() - 120_000).toUTCString() },
      });
    return real(u, i);
  }) as typeof fetch;
  const checks = await doctorChecks({ projectDir: w.projectDir }, w.deps);
  assert.equal(checks.find((c) => c.name === "clock skew")?.state, "fail");
});

test("doctor: a folder that never joined says so", async () => {
  const w = world();
  const checks = await doctorChecks({ projectDir: w.projectDir }, w.deps);
  assert.equal(checks[0]?.state, "fail");
});
