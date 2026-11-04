import { timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { writeFileDurable } from "../daemon/fsutil.ts";
import { readToken, tokenPath } from "../daemon/socket.ts";
import { toolDefs } from "../mcp/tool-defs.ts";
import { API_PORT, openApi } from "./openapi.ts";
import { callTool, folderWorker, type Link } from "./tool-call.ts";
import { waitForMail } from "./wait.ts";

/** `<stateDir>/api.json`: where the API listens and where its token is. No secret inside. */
export const apiFile = (stateDir: string) => join(stateDir, "api.json");

const MAX_BODY = 1 << 20;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok, bad) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      s += c;
      if (s.length > MAX_BODY) bad(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        const j = s.trim() ? JSON.parse(s) : {};
        if (j === null || typeof j !== "object" || Array.isArray(j))
          throw new Error();
        ok(j as Record<string, unknown>);
      } catch {
        bad(new Error("body must be a JSON object"));
      }
    });
    req.on("error", bad);
  });
}

/**
 * The same tools as the MCP server, on 127.0.0.1 for scripts and local models. Every request
 * needs the helper's token (`<stateDir>/daemon.token`, owner-only) as a bearer token. The tool
 * runs through the helper's own `tool` op, so results and the data wrapping match MCP.
 */
export async function startApiServer(
  stateDir: string,
  link: Link,
  workers: () => string[],
  version = "0.0.0",
): Promise<{ url: string; close(): Promise<void> }> {
  const send = (res: ServerResponse, code: number, j: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(j));
  };
  const server = createServer(async (req, res) => {
    try {
      if (!LOCAL_HOST.test(req.headers.host ?? ""))
        return send(res, 403, { ok: false, error: "local requests only" });
      const token = readToken(stateDir);
      const given = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
      if (!token || !given || !same(given, token))
        return send(res, 401, { ok: false, error: "unauthorized" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      if (req.method === "GET" && path === "/v1/tools")
        return send(res, 200, { tools: toolDefs() });
      if (req.method === "GET" && path === "/v1/openapi.json")
        return send(res, 200, openApi(version));
      const isTool = path.startsWith("/v1/tools/");
      if (
        !(path === "/v1/wait" && req.method === "GET") &&
        !(isTool && req.method === "POST")
      )
        return send(res, 404, { ok: false, error: "not found" });
      // The worker: the folder's (X-Hawl-Folder), else the only one on this machine.
      const folder = req.headers["x-hawl-folder"];
      let residentId: string | null | undefined;
      if (typeof folder === "string") {
        if (!isAbsolute(folder))
          return send(res, 400, {
            ok: false,
            error: "X-Hawl-Folder must be an absolute path",
          });
        residentId = folderWorker(resolve(folder));
      } else {
        const all = workers();
        residentId = all.length === 1 ? all[0] : null;
      }
      if (!residentId)
        return send(res, 400, {
          ok: false,
          error:
            "no worker: send X-Hawl-Folder with a folder joined by `hawl join`",
        });
      if (path === "/v1/wait") {
        const t = Number(url.searchParams.get("timeout") ?? 30);
        const secs = Math.min(300, Math.max(1, Number.isFinite(t) ? t : 30));
        let gone = false;
        res.on("close", () => {
          gone = true;
        });
        const w = await waitForMail(link, residentId, secs, {
          stopped: () => gone,
        });
        return send(res, 200, w);
      }
      const name = decodeURIComponent(path.slice("/v1/tools/".length));
      const out = await callTool(
        link,
        {
          residentId,
          cwd: typeof folder === "string" ? resolve(folder) : undefined,
        },
        name,
        await body(req),
      );
      return send(res, out.ok ? 200 : 400, out);
    } catch (e) {
      send(res, 400, { ok: false, error: (e as Error).message });
    }
  });
  // A busy default port falls back to any free one; api.json says which.
  await new Promise<void>((ok, bad) => {
    server.once("error", () => {
      server.once("error", bad);
      server.listen(0, "127.0.0.1", ok);
    });
    server.listen(API_PORT, "127.0.0.1", ok);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : API_PORT;
  const url = `http://127.0.0.1:${port}`;
  writeFileDurable(
    apiFile(stateDir),
    JSON.stringify({ url, token_file: tokenPath(stateDir) }),
  );
  return {
    url,
    close: () =>
      new Promise<void>((ok) => {
        rmSync(apiFile(stateDir), { force: true });
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}
