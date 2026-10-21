import { createHash, type KeyObject, randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  resolve as resolvePath,
  sep,
} from "node:path";
import type { Part } from "@hawl/protocol/src/envelope.ts";
import { signClientRequest } from "@hawl/protocol/src/envelope.ts";
import {
  type ValidationResult,
  validateToolArgs,
  validateToolResult,
  YARD_TOOL_NAMES,
  type YardToolName,
} from "@hawl/protocol/src/validate.ts";

/**
 * m2 yard tools (contract 3.2, S23, S31). Not wired into server.ts yet (slice C2).
 * Every handler checks its args against the protocol schema before anything leaves the machine,
 * calls the relay through the daemon, and checks the answer against the result schema.
 */

type Json = Record<string, unknown>;

export interface YardDaemon {
  call(op: string, args?: Json): Promise<unknown>;
}

export interface YardToolDeps {
  daemon: YardDaemon;
  residentId: string;
  /** Needed by job_open: it is a signed message to the Dispatcher. */
  signer?: { kid: string; privateKey: KeyObject };
  now?: () => Date;
  /** Folder whose `.hawl/files` receives artifacts. Default: the process cwd. */
  cwd?: string;
  /** Artifact download. Default: global fetch. */
  doFetch?: typeof fetch;
}

type Handler = (deps: YardToolDeps, args: Json) => Promise<unknown>;

export function isYardTool(name: string): name is YardToolName {
  return (YARD_TOOL_NAMES as readonly string[]).includes(name);
}

function check(what: string, r: ValidationResult): void {
  if (!r.ok) throw new Error(`${what}: ${r.message}`);
}

/**
 * A relay-side tool over REST (POST /v1/tools/call, the daemon's `send_tool`). The WS tool.call
 * frame schema lists only the old tool names, so yard tools cannot ride it. No signed request.
 */
async function relayTool(
  deps: YardToolDeps,
  name: string,
  args: Json,
): Promise<unknown> {
  return deps.daemon.call("send_tool", {
    resident_id: deps.residentId,
    name,
    args,
  });
}

// ---- job_open: a signed request_action to the site's Dispatcher ----

async function jobOpen(deps: YardToolDeps, args: Json): Promise<unknown> {
  if (!deps.signer) throw new Error("no signing key loaded for this worker");
  const who = (await relayTool(deps, "who", {
    query: "dispatcher",
  })) as { workers?: { handle?: string; resident_id?: string }[] };
  const hit = who.workers?.find(
    (w) => String(w.handle ?? "").replace(/^@/, "") === "dispatcher",
  );
  if (!hit?.resident_id) throw new Error("this site has no Dispatcher yet");

  const { spec, files, ...terms } = args;
  const parts: Part[] = [
    { kind: "text", text: String(spec) },
    { kind: "data", data: { job: terms } },
  ];
  for (const id of (files as string[] | undefined) ?? []) {
    const m = (await deps.daemon.call("file_meta", {
      resident_id: deps.residentId,
      file_id: id,
    })) as { name: string; mime: string; bytes: number; sha256: string };
    parts.push({
      kind: "file",
      file_id: id,
      name: m.name,
      mime: m.mime,
      bytes: m.bytes,
      sha256: m.sha256,
    });
  }
  const signed = signClientRequest(
    {
      v: 1,
      sender_resident_id: deps.residentId,
      kid: deps.signer.kid,
      idempotency_key:
        typeof args.idempotency_key === "string"
          ? args.idempotency_key
          : randomUUID(),
      conversation_id: null,
      reply_to: null,
      derived_from: [],
      to: { kind: "worker", resident_id: hit.resident_id },
      intent: "request_action",
      requested_capabilities: [],
      content: { parts },
      created_at: (deps.now?.() ?? new Date()).toISOString(),
    },
    deps.signer.privateKey,
  );
  return deps.daemon.call("send_tool", {
    resident_id: deps.residentId,
    name: "job_open",
    args,
    client_request: signed.client_request,
    sender_sig: signed.sender_sig,
  });
}

// ---- artifact_get: relay gives a short-lived URL, we download and check the digest ----

async function artifactGet(deps: YardToolDeps, args: Json): Promise<unknown> {
  const { save_to, ...relayArgs } = args;
  const link = (await relayTool(deps, "artifact_get", relayArgs)) as {
    url?: string;
    digest?: string;
    name?: string;
  };
  if (!link.url || !link.digest) throw new Error("relay gave no artifact link");
  const res = await (deps.doFetch ?? fetch)(link.url);
  if (!res.ok) throw new Error(`artifact download failed: ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (sha256 !== link.digest.replace(/^sha256:/, ""))
    throw new Error("artifact digest does not match: file not saved");
  const dir = join(deps.cwd ?? process.cwd(), ".hawl", "files");
  const name = (link.name ?? String(args.artifact_id)).replace(/[\/]/g, "_");
  const path =
    typeof save_to === "string" ? resolvePath(dir, save_to) : join(dir, name);
  await mkdir(dirname(path), { recursive: true });
  // Real paths on both sides, so a link or junction inside .hawl/files cannot lead outside it.
  const root = await realpath(dir);
  const parent = await realpath(dirname(path));
  if (parent !== root && !parent.startsWith(root + sep))
    throw new Error("save_to must stay inside .hawl/files");
  const target = join(parent, basename(path));
  try {
    await writeFile(target, body, { flag: "wx" }); // never replace an existing file
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`${target} already exists: pick another save_to`);
    throw e;
  }
  return { path: target, bytes: body.length, sha256 };
}

/**
 * The daemon socket gives up after 5 s (server.ts daemonLink) and then retries, which would file a
 * second question. So the relay waits at most 3 s; a longer wait comes back "waiting" with its id.
 */
const MAX_WAIT_S = 3;
function clampWait(a: Json): Json {
  return typeof a.wait_s === "number" && a.wait_s > MAX_WAIT_S
    ? { ...a, wait_s: MAX_WAIT_S }
    : a;
}

const HANDLERS: Record<YardToolName, Handler> = {
  job_open: jobOpen,
  artifact_get: artifactGet,
  job_status: (d, a) => relayTool(d, "job_status", a),
  ledger_read: (d, a) => relayTool(d, "ledger_read", a),
  menu_get: (d, a) => relayTool(d, "menu_get", a),
  menu_set: (d, a) => relayTool(d, "menu_set", a),
  work_start: (d, a) => relayTool(d, "work_start", a),
  work_update: (d, a) => relayTool(d, "work_update", a),
  ask_human: (d, a) => relayTool(d, "ask_human", clampWait(a)),
  approval_ask: (d, a) => relayTool(d, "approval_ask", clampWait(a)),
  approval_use: (d, a) => relayTool(d, "approval_use", a),
  line_open: (d, a) => relayTool(d, "line_open", a),
};

/** Validate args, run the tool, validate the answer. Throws a plain Error on any failure. */
export async function callYardTool(
  deps: YardToolDeps,
  name: YardToolName,
  args: unknown,
): Promise<unknown> {
  check(`${name} args`, validateToolArgs(name, args ?? {}));
  const out = await HANDLERS[name](deps, (args ?? {}) as Json);
  // The relay may attach a coaching tip to any reply; it is not part of the tool's result.
  const { hawl_tip: _tip, ...bare } = (out ?? {}) as Json;
  check(`${name} result`, validateToolResult(name, bare));
  return out;
}
