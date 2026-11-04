// Test helper for passkey.test.ts: `hawl passkeys` (confirmKeys) in its own process, frozen right
// after its last read of passkeys.json until the parent drops `go`. Args: stateDir listing.json dir.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const [stateDir, listing, dir] = process.argv.slice(2) as [
  string,
  string,
  string,
];
const real = fs.readFileSync;
let reads = 0;
fs.readFileSync = ((p: fs.PathOrFileDescriptor, ...a: unknown[]) => {
  const out = (real as (...x: unknown[]) => unknown)(p, ...a);
  if (String(p).endsWith("passkeys.json") && ++reads === 2) {
    fs.writeFileSync(join(dir, "paused"), "");
    const t = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(join(dir, "go"))) Atomics.wait(t, 0, 0, 10);
  }
  return out;
}) as typeof fs.readFileSync;
syncBuiltinESMExports();
const { confirmKeys } = await import("./passkey.ts");
const r = await confirmKeys(
  stateDir,
  ["res_pc"],
  JSON.parse(fs.readFileSync(listing, "utf8")),
  async () => true,
);
fs.writeFileSync(join(dir, "done"), JSON.stringify(r));
