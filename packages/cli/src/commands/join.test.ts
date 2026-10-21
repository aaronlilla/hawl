import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import test from "node:test";
import { MemoryKeyStore } from "../daemon/keys.ts";
import { join, joinNoWait } from "./join.ts";

test("join: the preview says it installs hawl to ~/.hawl/bin, and nothing installs before approval", async () => {
  const root = mkdtempSync(pjoin(tmpdir(), "hawl-join-"));
  const lines: string[] = [];
  let installed = 0;
  await assert.rejects(
    join(
      { site: "acme", hosts: ["claude_code"], projectDir: root },
      {
        home: root,
        stateDir: root,
        keyStore: new MemoryKeyStore(),
        print: (l) => lines.push(l),
        fetch: (async () =>
          new Response("no", { status: 500 })) as typeof fetch,
        selfInstall: () => {
          installed++;
          throw new Error("must not run before approval");
        },
      },
    ),
    /join start failed/,
  );
  assert.ok(lines.includes("Installs `hawl` to ~/.hawl/bin"));
  assert.equal(installed, 0);
});

function folder() {
  const root = mkdtempSync(pjoin(tmpdir(), "hawl-join2-"));
  const projectDir = pjoin(root, "app");
  mkdirSync(projectDir, { recursive: true });
  return { root, projectDir };
}

const neverFetch = (async () => {
  throw new Error("no network call expected");
}) as typeof fetch;

test("join: an unknown --host is refused with the list", async () => {
  const { root, projectDir } = folder();
  await assert.rejects(
    join(
      { site: "acme", hosts: ["windsurf"], projectDir },
      {
        home: root,
        stateDir: root,
        keyStore: new MemoryKeyStore(),
        fetch: neverFetch,
        print: () => {},
      },
    ),
    /"windsurf" isn't a tool hawl knows\. Pick one of: claude_code, codex, cursor, devin, other\./,
  );
});

test("join: rerun in a joined folder changes nothing and says so", async () => {
  const { root, projectDir } = folder();
  mkdirSync(pjoin(projectDir, ".hawl"));
  writeFileSync(
    pjoin(projectDir, ".hawl", "claude_code.json"),
    '{"resident_id":"res_OLD"}\n',
  );
  const lines: string[] = [];
  const r = await join(
    { site: "acme", hosts: ["claude_code"], projectDir },
    {
      home: root,
      stateDir: root,
      keyStore: new MemoryKeyStore(),
      fetch: neverFetch,
      print: (l) => lines.push(l),
    },
  );
  assert.equal(r.already_joined, true);
  assert.equal(r.resident_id, "res_OLD");
  assert.ok(lines.some((l) => /already connected to acme/.test(l)));
  assert.ok(lines.includes("Nothing to do."));
  assert.equal(
    readFileSync(pjoin(projectDir, ".hawl", "claude_code.json"), "utf8"),
    '{"resident_id":"res_OLD"}\n',
  );
});

test("join: two tools found, no keyboard and no --host asks for --host", async () => {
  const { root, projectDir } = folder();
  await assert.rejects(
    join(
      { site: "acme", hosts: [], projectDir, yes: true },
      {
        home: root,
        stateDir: root,
        keyStore: new MemoryKeyStore(),
        fetch: neverFetch,
        print: () => {},
        detect: () => ["claude_code", "codex"],
      },
    ),
    /Say which one: --host claude_code or --host codex\./,
  );
});

test("join: [Y/n/d] n cancels before any network call; d shows the changes first", async () => {
  const { root, projectDir } = folder();
  const answers = ["d", "n"];
  const lines: string[] = [];
  await assert.rejects(
    join(
      { site: "acme", hosts: ["claude_code"], projectDir },
      {
        home: root,
        stateDir: root,
        keyStore: new MemoryKeyStore(),
        fetch: neverFetch,
        print: (l) => lines.push(l),
        isTTY: true,
        ask: async () => answers.shift() ?? "n",
      },
    ),
    /Cancelled\. Nothing was changed\./,
  );
  assert.ok(
    lines.some((l) => l.startsWith(".mcp.json")),
    "d shows the file diff",
  );
});

test("join --yes: agent-run output has CODE: on its own line and ends with the restart note", async () => {
  const { root, projectDir } = folder();
  const lines: string[] = [];
  let claims = 0;
  const f = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/v1/join/start"))
      return new Response(
        JSON.stringify({
          join_id: "jrq_1",
          user_code: "ABCD-EFGH",
          key_fingerprint: "7F3A-91C2",
          expires_in: 600,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    claims++;
    return new Response(
      JSON.stringify({
        resident_id: "res_NEW",
        kid: "k1",
        town_id: "t1",
        relay_url: "https://relay.test",
        needs_owner_approval: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const r = await join(
    { site: "acme", hosts: ["other"], projectDir, yes: true },
    {
      home: root,
      stateDir: root,
      keyStore: new MemoryKeyStore(),
      fetch: f,
      print: (l) => lines.push(l),
      sleep: async () => {},
      ensureDaemon: async () => {},
      daemon: () => ({
        call: async () => ({ envelopes: [{ relay: { origin: "system" } }] }),
      }),
    },
  );
  assert.equal(claims, 1);
  assert.equal(r.resident_id, "res_NEW");
  assert.ok(lines.includes("CODE: ABCD-EFGH"));
  assert.ok(lines.some((l) => l.includes('"args":["mcp","--host","other"]')));
  assert.ok(lines.some((l) => l.startsWith("This tool has no mail notice.")));
  assert.ok(existsSync(pjoin(projectDir, ".hawl", "other.json")));
  assert.ok(
    !existsSync(pjoin(projectDir, ".mcp.json")),
    "other writes no tool config",
  );
});

test("joinNoWait: prints the code and exits while the child keeps going", async () => {
  const { root } = folder();
  const lines: string[] = [];
  await joinNoWait(["join", "acme", "--yes"], {
    stateDir: root,
    print: (l) => lines.push(l),
    sleep: async () => {},
    spawnChild: (_args, log) => {
      writeFileSync(log, "CODE: ABCD-EFGH\nWaiting for approval.\n");
      return { exited: () => false };
    },
  });
  assert.ok(lines.includes("CODE: ABCD-EFGH"));
  assert.ok(lines.some((l) => l.includes("Check later: hawl status")));
});

test("join: start carries the OS host name as machine_name, at most 40 chars", async () => {
  for (const [host, want] of [
    ["sams-laptop", "sams-laptop"],
    ["h".repeat(60), "h".repeat(40)],
  ] as const) {
    const { root, projectDir } = folder();
    let body: Record<string, unknown> = {};
    await assert.rejects(
      join(
        { site: "acme", hosts: ["claude_code"], projectDir, yes: true },
        {
          home: root,
          stateDir: root,
          keyStore: new MemoryKeyStore(),
          hostname: () => host,
          print: () => {},
          fetch: (async (_u: string, init?: RequestInit) => {
            body = JSON.parse(String(init?.body));
            return new Response("no", { status: 500 });
          }) as unknown as typeof fetch,
        },
      ),
      /join start failed/,
    );
    assert.equal(body.machine_name, want);
  }
});

test("join: the preview lists the user-level files and the claude mcp registration", async () => {
  const { root, projectDir } = folder();
  const lines: string[] = [];
  await assert.rejects(
    join(
      { site: "acme", hosts: ["claude_code"], projectDir },
      {
        home: root,
        stateDir: root,
        keyStore: new MemoryKeyStore(),
        print: (l) => lines.push(l),
        fetch: (async () =>
          new Response("no", { status: 500 })) as typeof fetch,
        userScope: { has: () => true, env: {} },
      },
    ),
    /join start failed/,
  );
  const text = lines.join("\n");
  assert.ok(text.includes(pjoin(root, ".claude", "settings.json")), text);
  assert.ok(text.includes(pjoin(root, ".codex", "config.toml")), text);
  assert.ok(text.includes("claude mcp add --scope user hawl"), text);
});
