import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { b64url } from "@hawl/protocol/src/hash.ts";
import type { Signer } from "./keys.ts";

/** Extension to the declared mime the relay accepts (apps/relay/src/files/uploads.ts). */
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  zip: "application/zip",
  json: "application/json",
  xml: "application/xml",
  ndjson: "application/x-ndjson",
  txt: "text/plain",
  md: "text/plain",
  log: "text/plain",
  csv: "text/csv",
};

type Doer = typeof fetch;

/** A 60 s client assertion signed by the worker key, exchanged for a 10 min AgentToken (04 3.2). */
export async function agentToken(
  relayUrl: string,
  residentId: string,
  signer: Signer,
  doFetch: Doer = fetch,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => b64url(Buffer.from(JSON.stringify(o)));
  const head = enc({ alg: "EdDSA", typ: "JWT", kid: signer.kid });
  const body = enc({
    iss: residentId,
    sub: residentId,
    aud: relayUrl.replace(/\/+$/, ""),
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
  });
  const sig = b64url(signer.sign(Buffer.from(`${head}.${body}`)));
  const res = await doFetch(new URL("/v1/auth/token", relayUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_assertion: `${head}.${body}.${sig}` }),
  });
  if (!res.ok)
    throw new Error(`relay refused the worker token (${res.status})`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** An AgentToken that is renewed a minute before it lapses (it lives 10 minutes). */
export function tokenSource(
  relayUrl: string,
  residentId: string,
  signer: Signer,
  doFetch: Doer = fetch,
): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && Date.now() < cached.until) return cached.token;
    const token = await agentToken(relayUrl, residentId, signer, doFetch);
    cached = { token, until: Date.now() + 8 * 60_000 };
    return token;
  };
}

/**
 * `file_put {path}`: the daemon reads the local file and sends the bytes up (the relay never
 * reads a worker's disk). Returns the relay's upload id. The same bytes from the same worker
 * answer with the first upload, so polling `file_put` shows the scan result without re-sending.
 */
export async function uploadFile(o: {
  relayUrl: string;
  residentId: string;
  signer: Signer;
  path: string;
  seen: Map<string, string>;
  doFetch?: Doer;
}): Promise<string> {
  const doFetch = o.doFetch ?? fetch;
  const bytes = await readFile(o.path);
  const sha = b64url(createHash("sha256").update(bytes).digest());
  const key = `${o.residentId}|${sha}`;
  const known = o.seen.get(key);
  if (known) return known;
  const name = basename(o.path);
  const mime = MIME[extname(name).slice(1).toLowerCase()];
  if (!mime) throw new Error("file type not allowed");
  const token = await agentToken(o.relayUrl, o.residentId, o.signer, doFetch);
  const auth = { authorization: `Bearer ${token}` };
  const made = await doFetch(new URL("/v1/files/uploads", o.relayUrl), {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ name, mime, bytes: bytes.length, sha256: sha }),
  });
  if (!made.ok) throw new Error(`upload refused (${made.status})`);
  const { upl_id, put_url } = (await made.json()) as {
    upl_id: string;
    put_url: string;
  };
  const put = await doFetch(new URL(put_url, o.relayUrl), {
    method: "PUT",
    headers: { ...auth, "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (!put.ok) throw new Error(`upload failed (${put.status})`);
  o.seen.set(key, upl_id);
  return upl_id;
}
