// Child process for spool.test.ts: spools N envelopes, then dies hard mid-way through the next write.
import { openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "@hawl/protocol/src/envelope.ts";
import { Spool } from "./spool.ts";

const [root, residentId, file] = process.argv.slice(2) as [
  string,
  string,
  string,
];
const envs = JSON.parse(
  (await import("node:fs")).readFileSync(file, "utf8"),
) as Envelope[];
const spool = new Spool(root, residentId);
for (const e of envs) spool.put(e);
// A write that never finished: a torn temp file, then SIGKILL-equivalent death.
const fd = openSync(join(root, residentId, ".tmp-deadbeef"), "w");
writeSync(fd, '{"torn":');
process.kill(process.pid, "SIGKILL");
