import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { callTool, folderWorker, type Link } from "../api/tool-call.ts";
import { waitForMail } from "../api/wait.ts";
import { defaultStateDir } from "../daemon/main.ts";
import { toolDefs } from "../mcp/tool-defs.ts";

export interface ToolIo {
  out: (s: string) => void;
  err: (s: string) => void;
  projectDir?: string;
  link?: Link;
  stdin?: () => string;
}

const stdio = (): ToolIo => ({
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
});

async function context(io: ToolIo) {
  const projectDir = resolve(io.projectDir ?? process.cwd());
  const residentId = folderWorker(projectDir);
  if (!residentId)
    throw new Error(
      "this folder has not joined a site; run `hawl join <site>`",
    );
  const link =
    io.link ?? (await import("../mcp/server.ts")).daemonLink(defaultStateDir());
  return { link, residentId, projectDir };
}

/** `--json` is the args object: inline, `@file`, or `-` for stdin (easier than shell quoting on Windows). */
function jsonArgs(
  raw: string | undefined,
  io: ToolIo,
): Record<string, unknown> {
  if (raw === undefined) return {};
  const text =
    raw === "-"
      ? (io.stdin ?? (() => readFileSync(0, "utf8")))()
      : raw.startsWith("@")
        ? readFileSync(raw.slice(1), "utf8")
        : raw;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(
      "--json is not valid JSON. Windows PowerShell 5.1 strips the double quotes from inline JSON: pipe it in instead, e.g. '{\"text\":\"hi\"}' | hawl tool <name> --json -  (or use --json '@args.json')",
    );
  }
  if (j === null || typeof j !== "object" || Array.isArray(j))
    throw new Error("--json must be a JSON object");
  return j as Record<string, unknown>;
}

async function run(
  io: ToolIo,
  name: string,
  args: Record<string, unknown>,
): Promise<number> {
  const c = await context(io);
  const r = await callTool(
    c.link,
    { residentId: c.residentId, cwd: c.projectDir },
    name,
    args,
  );
  if (!r.ok) {
    io.err(`${r.error}\n`);
    return 1;
  }
  io.out(`${JSON.stringify(r.result)}\n`);
  return 0;
}

/** `hawl tool list` and `hawl tool <name> [--json <args>]`: any MCP tool, JSON out, non-zero exit on error. */
export async function tool(
  argv: string[],
  io: ToolIo = stdio(),
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: "string" } },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (!name)
    throw new Error(
      "usage: hawl tool list | hawl tool <name> [--json '<args>']",
    );
  if (name === "list") {
    io.out(
      `${JSON.stringify(
        toolDefs().map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  return run(io, name, jsonArgs(values.json, io));
}

/** `hawl wait [--timeout s]`: one JSON line when mail arrives (exit 0), or on timeout (exit 2). */
export async function wait(
  argv: string[],
  io: ToolIo = stdio(),
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { timeout: { type: "string" } },
  });
  const secs = Number(values.timeout ?? 60);
  if (!Number.isFinite(secs) || secs < 1)
    throw new Error("usage: hawl wait [--timeout <seconds>]");
  const c = await context(io);
  const r = await waitForMail(c.link, c.residentId, secs);
  io.out(`${JSON.stringify(r)}\n`);
  return r.woke ? 0 : 2;
}

/** `hawl send <to> <text...>`: dm_send. */
export async function sendAlias(
  argv: string[],
  io: ToolIo = stdio(),
): Promise<number> {
  const [to, ...text] = argv;
  if (!to || text.length === 0) throw new Error("usage: hawl send <to> <text>");
  return run(io, "dm_send", { to, text: text.join(" ") });
}

/** `hawl inbox [--all]`: mailbox. */
export async function inbox(
  argv: string[],
  io: ToolIo = stdio(),
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { all: { type: "boolean" } },
  });
  return run(io, "mailbox", values.all ? { include_read: true } : {});
}
