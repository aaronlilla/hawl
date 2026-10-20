import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { writeFileDurable } from "./fsutil.ts";

/** `~/.hawl/daemon.sock`, or `\\.\pipe\hawl-<user>` on Windows (spec 16 §3.4). */
export function socketPath(stateDir: string): string {
  if (process.platform === "win32") {
    // The server and clients derive the same pipe from their state directory, even
    // when HAWL_HOME is unset (hooks, tests, and the local hub).
    const own = `-${createHash("sha256").update(resolve(stateDir).toLowerCase()).digest("hex").slice(0, 16)}`;
    return `\\\\.\\pipe\\hawl-${userInfo().username.replace(/[^A-Za-z0-9_.-]/g, "_")}${own}`;
  }
  return join(stateDir, "daemon.sock");
}

/**
 * Node cannot set a pipe ACL, so a named pipe is reachable by other local accounts.
 * Every request therefore carries the token in `<stateDir>/daemon.token` (0600).
 */
export function tokenPath(stateDir: string): string {
  return join(stateDir, "daemon.token");
}

export function readToken(stateDir: string): string | null {
  const f = tokenPath(stateDir);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : null;
}

export interface Request {
  id?: string | number;
  token?: string;
  op: string;
  [k: string]: unknown;
}
export type Response =
  | { id?: string | number; ok: true; result: unknown }
  | {
      id?: string | number;
      ok: false;
      error: string;
      error_info?: {
        code?: string;
        details?: Record<string, unknown>;
        retry_after?: number;
      };
    };

export type Handler = (req: Request) => Promise<unknown> | unknown;

const MAX_LINE = 1 << 20;

/** Newline-delimited JSON request/response over the local socket. */
export async function startSocketServer(
  stateDir: string,
  handler: Handler,
): Promise<{
  server: Server;
  path: string;
  token: string;
  close(): Promise<void>;
}> {
  const path = socketPath(stateDir);
  const token = randomBytes(24).toString("base64url");
  if (process.platform !== "win32") rmSync(path, { force: true });

  const server = createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", async (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE) return void sock.destroy();
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        let res: Response;
        let req: Request | undefined;
        try {
          req = JSON.parse(line) as Request;
          if (req.token !== token) {
            res = { id: req.id, ok: false, error: "unauthorized" };
          } else {
            res = { id: req.id, ok: true, result: await handler(req) };
          }
        } catch (e) {
          const info = (e as { info?: unknown }).info;
          res = {
            id: req?.id,
            ok: false,
            error: (e as Error).message,
            ...(info ? { error_info: info as never } : {}),
          };
        }
        sock.write(`${JSON.stringify(res)}\n`);
      }
    });
    sock.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  // Only after listen succeeds: a second daemon that fails to bind must not replace the
  // token the running one checks.
  writeFileDurable(tokenPath(stateDir), token);

  return {
    server,
    path,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(tokenPath(stateDir), { force: true });
          resolve();
        });
      }),
  };
}

/** One request, one response. For the hook, the MCP server and `hawl status`. */
export function request(
  path: string,
  req: Request,
  timeoutMs = 2000,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    let buf = "";
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error("daemon timeout"));
    }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on("data", (c: string) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(t);
        sock.end();
        resolve(JSON.parse(buf.slice(0, nl)) as Response);
      }
    });
    sock.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}
