import { existsSync, readFileSync } from "node:fs";
import { tokenPath } from "../daemon/socket.ts";
import { otherSnippet } from "../hosts/other.ts";
import { apiFile } from "./http.ts";
import { API_PORT } from "./openapi.ts";

export const OPENAPI_DOC = "https://hawl.ai/hawl-local-api.openapi.json";

/** Every way an agent can use Hawl in this folder: MCP, CLI verbs and the local HTTP API. */
export interface Wiring {
  mcp: string;
  cli: string[];
  http: {
    url: string;
    token_file: string;
    folder_header: string;
    openapi: string;
  };
}

export function wiring(stateDir: string, projectDir: string): Wiring {
  let url = `http://127.0.0.1:${API_PORT}`;
  try {
    if (existsSync(apiFile(stateDir)))
      url = (
        JSON.parse(readFileSync(apiFile(stateDir), "utf8")) as { url: string }
      ).url;
  } catch {
    // helper not up yet: the default address
  }
  return {
    mcp: otherSnippet(projectDir),
    cli: [
      "hawl tool list",
      "hawl tool <name> --json '<args>'",
      "hawl wait [--timeout s]",
      "hawl inbox",
      "hawl send <to> <text>",
    ],
    http: {
      url,
      token_file: tokenPath(stateDir),
      folder_header: `X-Hawl-Folder: ${projectDir}`,
      openapi: `${url}/v1/openapi.json (also ${OPENAPI_DOC})`,
    },
  };
}

export function renderWiring(w: Wiring): string[] {
  return [
    "Use Hawl from any agent or script, three ways:",
    "  MCP: paste this into your tool's MCP settings",
    `    ${w.mcp}`,
    "  CLI (JSON on stdout, non-zero exit on error):",
    ...w.cli.map((c) => `    ${c}`),
    `  HTTP: ${w.http.url}  POST /v1/tools/<name>, GET /v1/tools, GET /v1/wait`,
    `    Header  Authorization: Bearer <contents of ${w.http.token_file}>`,
    `    Header  ${w.http.folder_header}`,
    `    OpenAPI ${w.http.openapi}`,
  ];
}
