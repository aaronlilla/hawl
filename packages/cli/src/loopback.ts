import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { b64url } from "@hawl/protocol/src/hash.ts";

/**
 * One-click join (RFC 8252 loopback redirect + RFC 7636 PKCE S256). A one-time listener on
 * 127.0.0.1 with a random `state`; the relay gets only the challenge (hash of the verifier).
 * After Approve the browser is sent to `redirectUri?code=..&state=..`; only the first callback
 * with the exact state is taken. Someone who phishes the Approve link gets nothing: the browser
 * goes to the approver's own machine, and claim needs this process's verifier.
 */
export interface Loopback {
  redirectUri: string;
  state: string;
  verifier: string;
  challenge: string;
  /** The code from the browser, or null when none came within `ms`. Can be called again. */
  wait(ms: number): Promise<string | null>;
  close(): void;
}

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Hawl</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>Approved.</h1><p>Go back to your terminal. You can close this tab.</p></body>`;

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Null when the listener cannot start (join then uses the typed code). */
export async function startLoopback(
  o: { port?: number } = {},
): Promise<Loopback | null> {
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  let code: string | null = null;
  let got: (c: string) => void = () => {};
  const arrived = new Promise<string>((r) => {
    got = r;
  });
  const server = createServer((req, res) => {
    const reply = (status: number, body: string) => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        connection: "close",
      });
      res.end(body);
    };
    // Anything on this machine can hit the port: a malformed request must never end the join.
    let u: URL;
    try {
      u = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      return reply(400, "Bad request.");
    }
    if (req.method !== "GET" || u.pathname !== "/cb")
      return reply(404, "Not found.");
    const c = u.searchParams.get("code") ?? "";
    const s = u.searchParams.get("state") ?? "";
    // Exactly one callback, with this listener's state and a well-formed code.
    if (code !== null || !sameText(s, state) || !CODE_RE.test(c))
      return reply(400, "This link is not for this terminal, or was used.");
    code = c;
    got(c);
    reply(200, DONE_PAGE);
  });
  const port = await new Promise<number | null>((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(o.port ?? 0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port),
    );
  });
  if (port === null) return null;
  server.unref();
  return {
    redirectUri: `http://127.0.0.1:${port}/cb`,
    state,
    verifier,
    challenge,
    wait(ms) {
      let timer: NodeJS.Timeout | undefined;
      return Promise.race([
        arrived,
        new Promise<null>((r) => {
          timer = setTimeout(() => r(null), ms);
        }),
      ]).finally(() => clearTimeout(timer));
    },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
