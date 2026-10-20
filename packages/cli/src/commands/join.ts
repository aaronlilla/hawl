import { spawn as spawnProc } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join as pjoin, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { b64url } from "@hawl/protocol/src/hash.ts";
import { jcsBytes } from "@hawl/protocol/src/jcs.ts";
import { importPrivateJwk, signEd25519 } from "@hawl/protocol/src/sign.ts";
import {
  generateWorkerKey,
  type KeyStore,
  openKeyStore,
} from "../daemon/keys.ts";
import { defaultStateDir } from "../daemon/main.ts";
import { readToken, request, socketPath } from "../daemon/socket.ts";
import { addExclude } from "../hosts/exclude.ts";
import {
  detectHosts,
  HOSTS,
  type HostCtx,
  type HostId,
  isHost,
  JOIN_HOSTS,
} from "../hosts/index.ts";
import {
  applyPlan,
  type FilePlan,
  previewPlan,
  type RestoreRecord,
} from "../hosts/merge.ts";
import { OTHER_NOTE, OTHER_SNIPPET } from "../hosts/other.ts";
import { installUserScope, type UserScopeDeps } from "../hosts/user-scope.ts";
import {
  BIN_LINE,
  detectSea,
  type SelfInstallResult,
  selfInstall,
} from "../install/self-install.ts";
import { type DaemonLink, send } from "../mcp/server.ts";
import { canOpenBrowser, openUrl } from "../open-url.ts";
import { idFilePath, readProjectId } from "../project-id.ts";
import { winCommandLine } from "../shell.ts";
import {
  addWorker,
  newTownFile,
  readTownFile,
  type TownFile,
  writeTownFile,
} from "../town-file.ts";

export const DEFAULT_RELAY_URL = "https://relay.hawl.ai";
export const DEFAULT_OTLP_PORT = 4318;

export interface JoinDeps {
  fetch?: typeof fetch;
  print?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  stateDir?: string;
  home?: string;
  keyStore?: KeyStore;
  relayUrl?: string;
  otlpPort?: number;
  /** Claim poll interval. Spec 16 §3.3: 5 s. */
  pollMs?: number;
  /** Give up on the browser approval after this long. */
  timeoutMs?: number;
  /** How long to wait for the Dispatcher echo. */
  roundTripMs?: number;
  /** Start the daemon when it is not running. */
  ensureDaemon?: (stateDir: string) => Promise<void>;
  daemon?: (stateDir: string) => DaemonLink;
  version?: string;
  /** Put `hawl` on PATH. Default: self-install to ~/.hawl/bin (skipped when `home` is overridden). */
  selfInstall?: (home: string) => SelfInstallResult;
  /** Start the daemon at login. Default: on (skipped when `home` is overridden). */
  autostart?: () => Promise<void>;
  /** One line of input for the `[Y/n/d]` and tool questions. Default: readline on stdin. */
  ask?: (question: string) => Promise<string>;
  /** Is there a keyboard? Default: `process.stdin.isTTY`. */
  isTTY?: boolean;
  /** OS host name sent as machine_name. Default: os.hostname(). */
  hostname?: () => string;
  /** Tools found here. Default: PATH and config folders (S-405). */
  detect?: (o: { projectDir: string; home: string }) => HostId[];
  /** Machine-level hooks and MCP (user scope). Skipped when `home` is overridden unless given. */
  userScope?: Partial<UserScopeDeps>;
  /** Can this terminal open a browser? Default: not over SSH, not without a display. */
  canOpen?: () => boolean;
  /** Open a link in the browser. Default: the OS opener. */
  openUrl?: (url: string) => boolean | Promise<boolean>;
}

/** Hooks and MCP in the user's home, so sessions started in any subfolder are covered. Never fails the join. */
function setUpUserScope(
  deps: JoinDeps,
  home: string,
  stateDir: string,
  print: (l: string) => void,
): void {
  if (deps.home && !deps.userScope) return;
  try {
    const r = installUserScope({ home, stateDir, ...deps.userScope });
    if (r.entries > 0)
      print(
        "Hawl hooks are on for every Claude Code and Codex session on this machine; folders that haven't joined stay silent.",
      );
    for (const s of r.skipped)
      print(`Warning: skipped ${s.path} ${s.key}: ${s.reason}`);
    for (const n of r.notes) print(`Warning: ${n}`);
  } catch (e) {
    print(
      `Warning: could not set up machine-wide hooks (${(e as Error).message}). Folder hooks still work.`,
    );
  }
}

/** OS host name for the owner's status row; at most 40 chars (EXP-16). */
function machineName(deps: JoinDeps): string | undefined {
  let n = "";
  try {
    n = (deps.hostname ?? hostname)().trim();
  } catch {
    // no host name: the relay shows the folder alone
  }
  return n ? n.slice(0, 40) : undefined;
}

export interface JoinOpts {
  /** `<site-url|slug>`, e.g. `acme` or `https://hawl.ai/t/acme`. */
  site: string;
  /** `--host` values. Empty means detect. */
  hosts: string[];
  projectDir?: string;
  folderLabel?: string;
  /** `--yes`: no questions, plain-text output for an agent or script (S-427). */
  yes?: boolean;
  /** `--no-open`: print the link, do not open the browser. */
  noOpen?: boolean;
}

export interface JoinResult {
  resident_id: string;
  town_slug: string;
  needs_owner_approval: boolean;
  roundtrip: "ok" | "timeout" | "skipped";
  skipped: { path: string; key: string; reason: string }[];
  written: number;
  /** True when this folder already had the tool joined and nothing was changed (S-415). */
  already_joined?: boolean;
}

export class JoinError extends Error {}

/** `acme`, `hawl.ai/t/acme` or `https://hawl.ai/t/acme/` to `acme`. */
export function parseSite(input: string): string {
  const s = input.trim();
  const m = /(?:^|\/t\/)([a-z0-9][a-z0-9-]{0,62})\/?$/.exec(s);
  if (!m?.[1]) throw new JoinError(`not a site slug or URL: ${input}`);
  return m[1];
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

export function daemonLinkFor(stateDir: string): DaemonLink {
  return {
    async call(op, args = {}) {
      const token = readToken(stateDir);
      if (!token) throw new Error("hawl daemon is not running");
      const r = await request(
        socketPath(stateDir),
        { op, token, ...args },
        5000,
      );
      if (!r.ok) throw new Error(r.error);
      return r.result;
    },
  };
}

export async function spawnDaemon(stateDir: string): Promise<void> {
  if (readToken(stateDir)) {
    try {
      await daemonLinkFor(stateDir).call("status");
      return;
    } catch {
      // stale token: start a new one
    }
  }
  const { spawn } = await import("node:child_process");
  // Run from a script (source checkout, e2e): start the daemon from the same script, not a
  // `hawl` that may not be on PATH. A packaged binary has no script and uses `hawl`.
  // A single-file binary starts itself.
  const script = process.argv[1];
  const sea = detectSea();
  const fromScript =
    !sea && script !== undefined && /\.(?:[cm]?js|ts)$/.test(script);
  const spawnOpts = {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, HAWL_HOME: stateDir },
  } as const;
  // hawl.cmd needs a shell on Windows; one command string avoids Node's DEP0190 warning.
  const needsShell = !fromScript && !sea && process.platform === "win32";
  const child = needsShell
    ? spawn(winCommandLine("hawl", ["daemon"]), [], {
        ...spawnOpts,
        shell: true,
      })
    : spawn(
        fromScript || sea ? process.execPath : "hawl",
        fromScript ? [script as string, "daemon"] : ["daemon"],
        spawnOpts,
      );
  child.on("error", () => {});
  child.unref();
  for (let i = 0; i < 40; i++) {
    await defaultSleep(250);
    try {
      await daemonLinkFor(stateDir).call("status");
      return;
    } catch {
      // not up yet
    }
  }
  throw new JoinError(
    "the hawl daemon did not start; run `hawl daemon` and retry",
  );
}

/** EdDSA client assertion for `POST /v1/auth/token` (04 §3.2). Lives 60 s. */
export function clientAssertion(
  residentId: string,
  kid: string,
  privateJwk: Record<string, string>,
  audience: string,
  now: Date = new Date(),
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64url(
    Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid })),
  );
  const body = b64url(
    Buffer.from(
      JSON.stringify({
        iss: residentId,
        sub: residentId,
        aud: audience,
        iat,
        exp: iat + 60,
        jti: randomBytes(12).toString("hex"),
      }),
    ),
  );
  const sig = signEd25519(
    importPrivateJwk(privateJwk),
    Buffer.from(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(sig)}`;
}

export function hostCtx(
  o: { projectDir: string; home: string; otlpPort: number },
  residentId: string,
): HostCtx {
  return { ...o, residentId };
}

const HOST_LIST = JOIN_HOSTS.join(", ");

function checkHosts(list: string[]): HostId[] {
  const out: HostId[] = [];
  for (const h of list) {
    if (!isHost(h) || h === "gemini")
      throw new JoinError(
        `"${h}" isn't a tool hawl knows. Pick one of: ${HOST_LIST}.
Fix: for any other MCP tool, use --host other.`,
      );
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

async function readLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** `--host` names are validated; with none, detect (S-405/S-406). */
async function chooseHosts(
  opts: JoinOpts,
  o: { projectDir: string; home: string },
  deps: JoinDeps,
  print: (l: string) => void,
  keyboard: boolean,
): Promise<HostId[]> {
  if (opts.hosts.length) return checkHosts(opts.hosts);
  const found = (deps.detect ?? detectHosts)(o);
  if (found.length === 0) {
    print("No supported coding agent found; using Claude Code.");
    print(
      `  Looked in: your PATH, ~/.claude, ~/.codex, .cursor/ and .devin/ in this folder. Name the tool with --host (${HOST_LIST}).`,
    );
    return ["claude_code"];
  }
  if (found.length === 1) return [found[0] as HostId];
  const names = found.map((h) => HOSTS[h].label).join(" and ");
  if (!keyboard)
    throw new JoinError(
      `Found ${names}. Say which one: ${found.map((h) => `--host ${h}`).join(" or ")}.`,
    );
  const ask = deps.ask ?? readLine;
  print(`Found ${names}.`);
  found.forEach((h, i) => print(`  ${i + 1}. ${HOSTS[h].label}`));
  for (;;) {
    const a = (await ask(`Which one? [1-${found.length}, default 1] `))
      .trim()
      .toLowerCase();
    if (a === "") return [found[0] as HostId];
    const byNumber = found[Number(a) - 1];
    if (byNumber) return [byNumber];
    const byName = found.find((h) => h === a);
    if (byName) return [byName];
  }
}

/** Hosts whose `.hawl/<tool>.json` already sits in this folder. */
function alreadyJoined(projectDir: string, hosts: HostId[]): HostId[] {
  return hosts.filter((h) => existsSync(pjoin(projectDir, idFilePath(h))));
}

/** `hawl join`: spec 16 §3.3. Preview, typed-code approval, write, round trip, restart notes. */
export async function join(
  opts: JoinOpts,
  deps: JoinDeps = {},
): Promise<JoinResult> {
  const print = deps.print ?? ((l) => process.stdout.write(`${l}\n`));
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const stateDir = deps.stateDir ?? defaultStateDir();
  const home = deps.home ?? homedir();
  const otlpPort = deps.otlpPort ?? DEFAULT_OTLP_PORT;
  const projectDir = resolve(opts.projectDir ?? process.cwd());
  const relayUrl = (
    deps.relayUrl ??
    process.env.HAWL_RELAY_URL ??
    DEFAULT_RELAY_URL
  ).replace(/\/$/, "");
  const slug = parseSite(opts.site);
  const keyboard = !opts.yes && (deps.isTTY ?? process.stdin.isTTY === true);
  const requested = await chooseHosts(
    opts,
    { projectDir, home },
    deps,
    print,
    keyboard,
  );
  const folderLabel = opts.folderLabel ?? (basename(projectDir) || "folder");
  const dirs = { projectDir, stateDir };

  // Already joined here (S-415): change nothing, say so.
  const joined = alreadyJoined(projectDir, requested);
  if (joined.length) {
    const town = readTownFile(projectDir);
    const here = town?.memberships.find((m) => m.town_slug === slug);
    const other = town?.memberships.find((m) => m.town_slug !== slug);
    if (!here && other)
      throw new JoinError(
        `This folder is already connected to site ${other.town_slug}. Run \`hawl leave\` first, then join ${slug}.`,
      );
    for (const h of joined)
      print(`${HOSTS[h].label} is already connected to ${slug}.`);
    if (joined.length === requested.length) {
      print("Nothing to do.");
      setUpUserScope(deps, home, stateDir, print);
      print("Check it: hawl status        Fix problems: hawl doctor");
      const id = readProjectId(joined[0] as HostId, projectDir);
      return {
        resident_id: id?.resident_id ?? "",
        town_slug: slug,
        needs_owner_approval: false,
        roundtrip: "skipped",
        skipped: [],
        written: 0,
        already_joined: true,
      };
    }
  }
  const hosts = requested.filter((h) => !joined.includes(h));

  // Fail early when there is nowhere safe to keep the key.
  const keyStore =
    deps.keyStore ??
    (await openKeyStore({
      stateDir,
      passphrase: process.env.HAWL_PASSPHRASE,
      onFallback: print,
    }));

  // Summary with a placeholder id; the real one arrives at claim (S-403).
  const previewCtx = hostCtx(
    { projectDir, home, otlpPort },
    "res_<assigned at approval>",
  );
  const plans0 = hosts.flatMap((h) => HOSTS[h].plan(previewCtx));
  const paths = [...new Set(plans0.map((p) => p.path))];
  print(
    "Config changes (nothing is written until you approve in the browser):",
  );
  print(
    `Connecting ${hosts.map((h) => HOSTS[h].label).join(", ")} in ${projectDir} to site ${slug}.`,
  );
  print(`Files that will change: ${paths.join(", ")}`);
  print(BIN_LINE);
  if (keyboard) {
    const ask = deps.ask ?? readLine;
    for (;;) {
      const a = (await ask("Continue? [Y/n/d] (d = show every change) "))
        .trim()
        .toLowerCase();
      if (a === "" || a === "y" || a === "yes") break;
      if (a === "n" || a === "no")
        throw new JoinError("Cancelled. Nothing was changed.");
      if (a === "d") for (const p of plans0) print(previewPlan(p));
    }
  }

  const key = generateWorkerKey();
  const platform = hosts[0] as HostId;
  const startRes = await doFetch(`${relayUrl}/v1/join/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      town_slug: slug,
      public_jwk: key.publicJwk,
      platform,
      host_hint: HOSTS[platform].label.slice(0, 80),
      folder_label: folderLabel.slice(0, 120),
      machine_name: machineName(deps),
      cli_version: deps.version ?? "0.0.0",
    }),
  });
  if (!startRes.ok)
    throw new JoinError(
      `join start failed: ${startRes.status} ${(await startRes.text()).slice(0, 200)}`,
    );
  const started = (await startRes.json()) as {
    join_id: string;
    user_code: string;
    key_fingerprint: string;
    expires_in: number;
    /** The approve page with the code filled in. */
    verification_url?: string;
  };
  // The browser opens on the approve page with the code filled in. The page shows this
  // terminal's fingerprint, so a link someone else sent cannot approve a stranger's device.
  const approveLink = started.verification_url;
  // A browser that will not open must never fail or slow the join: it is tried once, briefly,
  // and the link is printed whatever happens.
  let browser = false;
  if (
    !opts.yes &&
    opts.noOpen !== true &&
    typeof approveLink === "string" &&
    (deps.canOpen ?? canOpenBrowser)()
  ) {
    try {
      browser = await (deps.openUrl ?? openUrl)(approveLink);
    } catch {
      browser = false;
    }
  }
  if (browser) {
    print("Opening your browser so you can approve this agent.");
    print(`If it does not open, go to ${approveLink}`);
    print(`The page must show fingerprint ${started.key_fingerprint}.`);
    print("Waiting for approval...");
  } else if (!opts.yes && typeof approveLink === "string") {
    print(`Open this link to approve: ${approveLink}`);
    print(`Or open hawl.ai/device and type ${started.user_code}`);
    print(`The page must show fingerprint ${started.key_fingerprint}.`);
    print("Waiting for approval...");
  } else if (opts.yes) {
    // S-427: plain lines an agent can relay to the person. Fixed text and the code only.
    print(
      "Ask the person to type this code at hawl.ai/device (or in the box on their onboarding page):",
    );
    print(`CODE: ${started.user_code}`);
    print(`Fingerprint: ${started.key_fingerprint} (it must match the page)`);
    if (approveLink) print(`Or open this link: ${approveLink}`);
    print(
      `This code expires at ${new Date(Date.now() + started.expires_in * 1000).toTimeString().slice(0, 5)} (${Math.round(started.expires_in / 60)} minutes).`,
    );
    print("Waiting for approval.");
  } else {
    print(`Open hawl.ai/device and type ${started.user_code}`);
    print(`Fingerprint ${started.key_fingerprint} (it must match the page)`);
    print("Waiting for approval...");
  }

  const deadline = Date.now() + (deps.timeoutMs ?? started.expires_in * 1000);
  const pollMs = deps.pollMs ?? 5000;
  type Claimed = {
    resident_id: string;
    kid: string;
    town_id: string;
    relay_url: string;
    needs_owner_approval: boolean;
  };
  let claimed: Claimed | null = null;
  const privateKey = importPrivateJwk(key.privateJwk);
  while (!claimed) {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString("hex");
    const sig = b64url(
      signEd25519(
        privateKey,
        jcsBytes({ join_id: started.join_id, nonce, ts }),
      ),
    );
    let res: Response | null = null;
    try {
      res = await doFetch(`${relayUrl}/v1/join/${started.join_id}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce, ts, sig }),
      });
    } catch {
      // relay unreachable: keep polling until the code expires
    }
    if (res?.status === 200) claimed = (await res.json()) as Claimed;
    else if (res && res.status !== 202 && res.status < 500)
      throw new JoinError(
        "the code expired or was not approved; run `hawl join` again",
      );
    if (!claimed) {
      if (Date.now() >= deadline)
        throw new JoinError(
          "timed out waiting for approval; run `hawl join` again",
        );
      await sleep(pollMs);
    }
  }

  const rid = claimed.resident_id;
  await keyStore.set(rid, key.privateJwk);

  // Write host configs with the real id; record hashes and restore points.
  const ctx = hostCtx({ projectDir, home, otlpPort }, rid);
  const town: TownFile = readTownFile(projectDir) ?? newTownFile(folderLabel);
  const skipped: JoinResult["skipped"] = [];
  let written = 0;
  const restore: RestoreRecord[] = [];
  const plans: FilePlan[] = [];
  for (const h of hosts) plans.push(...HOSTS[h].plan(ctx));
  // Same file from two hosts is not expected, but a later plan must see an earlier write.
  for (const p of plans) {
    const rec = applyPlan(p, dirs);
    if (rec) restore.push(rec);
    for (const e of p.entries) {
      if (
        !town.written.some(
          (w) =>
            w.resident_id === rid &&
            w.path === e.path &&
            w.key === e.key &&
            w.sha256 === e.sha256,
        )
      ) {
        town.written.push({ ...e, resident_id: rid });
        written++;
      }
    }
    for (const s of p.skipped) skipped.push({ path: p.path, ...s });
  }
  for (const r of restore) town.restore.push({ ...r, resident_id: rid });
  if (addExclude(projectDir)) town.exclude = true;
  addWorker(
    town,
    {
      town_id: claimed.town_id,
      town_slug: slug,
      relay_url: claimed.relay_url ?? relayUrl,
    },
    { resident_id: rid, platform, kid: claimed.kid },
  );
  writeTownFile(projectDir, town);
  for (const s of skipped) print(`Skipped ${s.path} ${s.key}: ${s.reason}`);
  setUpUserScope(deps, home, stateDir, print);

  // Daemon up, worker attached, then the Dispatcher round trip.
  const install = deps.selfInstall ?? (deps.home ? undefined : selfInstall);
  const installed = install?.(home);
  if (installed?.warning) print(installed.warning);
  else if (installed)
    print(
      `hawl is at ${installed.binPath}; open a new terminal to use \`hawl\`.`,
    );
  const autostart =
    deps.autostart ??
    (deps.home
      ? undefined
      : async () => {
          const { setAutostart } = await import("../autostart/index.ts");
          await setAutostart(true, { bin: installed?.binPath });
        });
  if (autostart) {
    try {
      await autostart();
      print(
        "Hawl starts when you log in. Turn that off with `hawl autostart off`.",
      );
    } catch {
      // The reason (schtasks, launchd, systemd output) is in `hawl doctor`, not on this screen.
      print(
        "Hawl will not start by itself at login on this computer. It still works; turn that on later with `hawl autostart on`.",
      );
    }
  }
  const ensure = deps.ensureDaemon ?? spawnDaemon;
  await ensure(stateDir);
  const link = (deps.daemon ?? daemonLinkFor)(stateDir);
  await link.call("attach", {
    worker: {
      relay_url: claimed.relay_url ?? relayUrl,
      resident_id: rid,
      platform,
    },
  });
  // A pending agent cannot send yet, so there is nothing to test until the owner lets it in.
  const roundtrip = claimed.needs_owner_approval
    ? "skipped"
    : await roundTrip(link, rid, claimed.kid, key.privateJwk, deps, sleep);

  print(
    roundtrip === "ok"
      ? `Joined ${slug}. Hawl answered a test message.`
      : claimed.needs_owner_approval
        ? `Joined ${slug}.`
        : `Joined ${slug}. The connection check did not finish; run \`hawl doctor\`.`,
  );
  if (claimed.needs_owner_approval)
    print(
      "Waiting for the site owner to let this agent in. That is normal; it starts working the moment they do.",
    );
  if (hosts.includes("other")) {
    print("");
    print("Paste this into your tool's MCP settings:");
    print(`    ${OTHER_SNIPPET}`);
    print(OTHER_NOTE);
  }
  for (const h of hosts) print(HOSTS[h].restart);
  if (opts.yes && hosts.includes("claude_code"))
    print(
      "Tell the person to restart Claude Code in this folder. This session can't load the new server.",
    );
  return {
    resident_id: rid,
    town_slug: slug,
    needs_owner_approval: claimed.needs_owner_approval,
    roundtrip,
    skipped,
    written,
  };
}

async function roundTrip(
  link: DaemonLink,
  rid: string,
  kid: string,
  privateJwk: Record<string, string>,
  deps: JoinDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<"ok" | "timeout"> {
  // The daemon opens the relay socket after attach, so the first sends may find it not up yet.
  const sendBy = Date.now() + (deps.roundTripMs ?? 20_000);
  for (;;) {
    try {
      await send(
        {
          daemon: link,
          residentId: rid,
          signer: { kid, privateKey: importPrivateJwk(privateJwk) },
        },
        "dm_send",
        { to: "dispatcher", text: "ping from setup" },
      );
      break;
    } catch (e) {
      if (
        !/not connected/.test(String((e as Error)?.message)) ||
        Date.now() >= sendBy
      )
        return "timeout";
      await sleep(500);
    }
  }
  const until = Date.now() + (deps.roundTripMs ?? 20_000);
  while (Date.now() < until) {
    try {
      const r = (await link.call("mailbox", { resident_id: rid })) as {
        envelopes?: {
          relay?: {
            origin?: string;
            message_id?: string;
            from?: { platform?: string };
          };
        }[];
      };
      const echo = r.envelopes?.find(
        (e) =>
          e.relay?.origin === "system" || e.relay?.from?.platform === "system",
      );
      if (echo) {
        // Setup read the Dispatcher's answer, so it is not an unread message for the person.
        if (echo.relay?.message_id)
          await link
            .call("mark_read", {
              resident_id: rid,
              message_ids: [echo.relay.message_id],
            })
            .catch(() => undefined);
        return "ok";
      }
    } catch {
      // keep waiting
    }
    await sleep(500);
  }
  return "timeout";
}

export interface NoWaitDeps {
  print?: (line: string) => void;
  stateDir?: string;
  /** Start the real join as a detached process writing to `logPath`. */
  spawnChild?: (args: string[], logPath: string) => { exited: () => boolean };
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the code to appear in the log. */
  timeoutMs?: number;
}

function spawnDetached(args: string[], logPath: string) {
  const fd = openSync(logPath, "a");
  let done = false;
  const child = spawnProc(process.execPath, [process.argv[1] ?? "", ...args], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.on("exit", () => {
    done = true;
  });
  child.on("error", () => {
    done = true;
  });
  child.unref();
  closeSync(fd);
  return { exited: () => done };
}

/**
 * `--no-wait` (S-427): the real join runs as a detached process; this one prints the code and exits.
 * `args` is the full `hawl join ...` argv minus `--no-wait`, with `--yes` added.
 */
export async function joinNoWait(
  args: string[],
  deps: NoWaitDeps = {},
): Promise<void> {
  const print = deps.print ?? ((l) => process.stdout.write(`${l}\n`));
  const sleep = deps.sleep ?? defaultSleep;
  const stateDir = deps.stateDir ?? defaultStateDir();
  mkdirSync(stateDir, { recursive: true });
  const logPath = pjoin(stateDir, `join-${Date.now()}.log`);
  const child = (deps.spawnChild ?? spawnDetached)(args, logPath);
  const until = Date.now() + (deps.timeoutMs ?? 30_000);
  const read = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
  let text = read();
  const settled = (t: string) =>
    t.includes("Waiting for approval.") || t.includes("Nothing to do.");
  while (!settled(text) && !child.exited() && Date.now() < until) {
    await sleep(250);
    text = read();
  }
  text = read();
  for (const l of text.split("\n")) if (l.trim()) print(l);
  if (text.includes("Waiting for approval."))
    print(
      "Waiting for approval in the background. The helper finishes the join by itself once the person approves.\nCheck later: hawl status",
    );
  else if (!settled(text))
    throw new JoinError(
      "the join did not start; run `hawl join` again without --no-wait",
    );
}
