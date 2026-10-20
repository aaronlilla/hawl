import {
  existsSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { writeFileDurable } from "../daemon/fsutil.ts";
import { generateWorkerKey } from "../daemon/keys.ts";
import { readToken, request, socketPath } from "../daemon/socket.ts";
import { CODEX_CONFIG } from "../hosts/codex.ts";
import { addExclude, removeExclude } from "../hosts/exclude.ts";
import { planToml } from "../hosts/merge.ts";
import { defaultLocalDir, LocalLog } from "../local/log.ts";
import { LocalHub, saveKey } from "../local/server.ts";
import { idFilePath, idFileText, readProjectId } from "../project-id.ts";

type Json = Record<string, unknown>;

/** Per-host MCP config file, relative to the project folder. Same `mcpServers` shape. */
const HOST_FILES: Record<string, string> = {
  claude_code: ".mcp.json",
  cursor: join(".cursor", "mcp.json"),
  codex: CODEX_CONFIG,
};

export interface JoinLocalOpts {
  /** Project folder whose host config gets the hawl entry. */
  projectDir: string;
  handle: string;
  host?: "claude_code" | "cursor" | "codex";
  platform?: string;
  /** Local state dir (`~/.hawl/local`). */
  dir?: string;
}

/**
 * `hawl join --local`: make a worker, keep its key in the local dir, merge one `hawl`
 * entry into the host's MCP config. Other servers and keys in the file are left alone.
 */
export async function joinLocal(
  o: JoinLocalOpts,
): Promise<{ resident_id: string; handle: string; config: string }> {
  const dir = o.dir ?? defaultLocalDir();
  const host = o.host ?? "claude_code";
  const rel = HOST_FILES[host];
  if (!rel) throw new Error(`host ${host} is not supported in local mode yet`);

  const config = join(o.projectDir, rel);
  let doc: Json = {};
  if (host !== "codex" && existsSync(config)) {
    try {
      doc = JSON.parse(readFileSync(config, "utf8")) as Json;
    } catch {
      throw new Error(
        `${config} is not valid JSON; fix that file before joining.`,
      );
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc))
      throw new Error(
        `${config} must contain a JSON object; fix that file before joining.`,
      );
  }

  const key = generateWorkerKey();
  const args = {
    handle: o.handle,
    platform: o.platform ?? host,
    pub: key.publicJwk,
  };
  let joined: { resident_id: string; handle: string } | undefined;
  const token = readToken(dir);
  if (token) {
    try {
      const r = await request(
        socketPath(dir),
        { op: "join", token, ...args },
        2000,
      );
      if (r.ok) joined = r.result as typeof joined;
    } catch {
      // server not running: write to the log directly
    }
  }
  joined ??= new LocalHub(new LocalLog(dir)).join(args);
  // A repeat join of the same handle keeps the first worker and its key.
  if (!existsSync(join(dir, "keys", `${joined.resident_id}.jwk`))) {
    saveKey(dir, joined.resident_id, key.privateJwk);
  }

  if (host === "codex") {
    // Codex reads TOML: add one `[mcp_servers.hawl]` table, leave the rest of the file alone.
    const plan = planToml(
      CODEX_CONFIG,
      config,
      [
        {
          key: "mcp_servers.hawl",
          table: ["mcp_servers", "hawl"],
          text: [
            "[mcp_servers.hawl]",
            'command = "npx"',
            'args = ["-y", "hawl.ai", "mcp", "--host", "codex", "--local"]',
          ].join("\n"),
        },
      ],
      existsSync(config) ? readFileSync(config, "utf8") : null,
    );
    if (plan.changed) writeFileDurable(config, plan.after);
  } else {
    const servers = { ...((doc.mcpServers as Json | undefined) ?? {}) };
    servers.hawl = {
      command: "npx",
      args: ["-y", "hawl.ai", "mcp", "--host", host, "--local"],
    };
    writeFileDurable(
      config,
      `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`,
    );
  }
  // The id and local dir stay in this folder's git-excluded `.hawl/`, not in the shared config.
  writeFileDurable(
    join(o.projectDir, idFilePath(host)),
    idFileText(joined.resident_id, dir),
  );
  addExclude(o.projectDir);
  return { ...joined, config };
}

export interface LocalMembership {
  host: string;
  resident_id: string;
  config: string;
}

/** The local-mode joins of this folder: one per host whose `.hawl/<host>.json` names a local dir. */
export function localMemberships(projectDir: string): LocalMembership[] {
  const out: LocalMembership[] = [];
  for (const [host, rel] of Object.entries(HOST_FILES)) {
    const id = readProjectId(host, projectDir);
    if (id?.hawl_home && existsSync(join(projectDir, idFilePath(host))))
      out.push({
        host,
        resident_id: id.resident_id,
        config: join(projectDir, rel),
      });
  }
  return out;
}

/**
 * `hawl leave` for a folder that joined with `--local`: take the `hawl` entry out of the host
 * config (other servers and keys stay), delete the folder's id file and the `.hawl` dir when it
 * is empty, and drop the git-exclude line. The local worker and its key stay in the local dir.
 */
export function leaveLocal(projectDir: string): LocalMembership[] {
  const left = localMemberships(projectDir);
  for (const m of left) {
    if (existsSync(m.config)) {
      if (m.host === "codex") {
        const text = readFileSync(m.config, "utf8");
        // The table runs from its header to the next line that starts a table (a line starting
        // with `[`); its own `args = [...]` line does not start with one.
        const next = text.replace(
          /^\[mcp_servers\.hawl\][ \t]*\r?\n(?:(?!\[).*(?:\r?\n|$))*/m,
          "",
        );
        if (next !== text) writeFileDurable(m.config, next);
      } else {
        try {
          const doc = JSON.parse(readFileSync(m.config, "utf8")) as Json;
          const servers = { ...((doc.mcpServers as Json | undefined) ?? {}) };
          delete servers.hawl;
          const rest: Json = { ...doc };
          if (Object.keys(servers).length > 0) rest.mcpServers = servers;
          else delete rest.mcpServers;
          if (Object.keys(rest).length === 0) rmSync(m.config);
          else
            writeFileDurable(
              m.config,
              `${JSON.stringify(rest, null, 2)}
`,
            );
        } catch {
          // unreadable config: leave it for the person to fix
        }
      }
    }
    rmSync(join(projectDir, idFilePath(m.host)), { force: true });
  }
  const dir = join(projectDir, ".hawl");
  if (existsSync(dir) && readdirSync(dir).length === 0) {
    rmdirSync(dir);
    removeExclude(projectDir);
  }
  return left;
}
