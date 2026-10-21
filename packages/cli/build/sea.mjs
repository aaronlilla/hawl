// Builds the hawl single-executable for the current OS/arch (spec 16 section 3.2).
// esbuild bundle -> sea-config.json -> `node --build-sea`. The @napi-rs/keyring `.node`
// for this target is embedded as an asset; at runtime it is written to a temp file and
// loaded with process.dlopen.
//
// Usage: node build/sea.mjs [--entry src/main.ts] [--out dist/sea] [--target win-x64]
// --target names the release asset (dist/hawl-<target>[.exe]) and must match this machine:
// SEA embeds the running node, so each target builds on its own OS (release.yml, desktop.yml).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import "./gen-skills.mjs"; // skill text in the bundle always comes from plugins/claude-code/skills
import { embedSchemasPlugin } from "./embed-schemas.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const require = createRequire(import.meta.url);
const updatePublicKey = JSON.parse(
  process.env.HAWL_UPDATE_PUBLIC_KEY ||
    readFileSync(join(root, "build/update-pubkey.json"), "utf8"),
);
if (
  updatePublicKey.d ||
  (updatePublicKey.x &&
    (updatePublicKey.kty !== "OKP" || updatePublicKey.crv !== "Ed25519"))
)
  throw new Error("HAWL_UPDATE_PUBLIC_KEY must be a public Ed25519 JWK");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const entry = resolve(root, arg("entry", "src/main.ts"));
const outDir = resolve(root, arg("out", "dist/sea"));

// Release targets: win-x64, darwin-arm64, linux-x64. Package suffix per napi-rs naming.
const TARGETS = {
  "win32-x64": {
    pkg: "keyring-win32-x64-msvc",
    file: "keyring.win32-x64-msvc.node",
    exe: "hawl.exe",
  },
  "darwin-arm64": {
    pkg: "keyring-darwin-arm64",
    file: "keyring.darwin-arm64.node",
    exe: "hawl",
  },
  "linux-x64": {
    pkg: "keyring-linux-x64-gnu",
    file: "keyring.linux-x64-gnu.node",
    exe: "hawl",
  },
};
const host = `${process.platform}-${process.arch}`;
const target = TARGETS[host];
if (!target) {
  throw new Error(`no SEA target for ${host}`);
}
const releaseName = arg("target");
if (releaseName && releaseName !== host.replace("win32", "win")) {
  throw new Error(
    `--target ${releaseName} must be built on ${releaseName}, not ${host}`,
  );
}
if (!existsSync(entry)) throw new Error(`entry not found: ${entry}`);

// The platform package is an optionalDependency of @napi-rs/keyring; find its .node.
const keyringDir = dirname(require.resolve("@napi-rs/keyring/package.json"));
const nodeFile = require.resolve(`@napi-rs/${target.pkg}/${target.file}`, {
  paths: [keyringDir],
});

mkdirSync(outDir, { recursive: true });

const bundle = join(outDir, "hawl.cjs");
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node26",
  // SEA main must be CommonJS. import.meta.url is not defined there.
  define: {
    "import.meta.url": "__importMetaUrl",
    // Only src/main.ts starts itself in the bundle (it checks __HAWL_VERSION__).
    "import.meta.main": "false",
    __HAWL_UPDATE_PUBKEY__: JSON.stringify(updatePublicKey),
    __HAWL_VERSION__: JSON.stringify(
      process.env.HAWL_VERSION ||
        JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    ),
  },
  banner: {
    js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;',
  },
  // Native addon is an asset, not bundled.
  plugins: [embedSchemasPlugin],
  external: ["@napi-rs/keyring"],
  legalComments: "none",
});

const config = join(outDir, "sea-config.json");
const binary = releaseName
  ? join(
      root,
      "dist",
      `hawl-${releaseName}${target.exe.endsWith(".exe") ? ".exe" : ""}`,
    )
  : join(outDir, target.exe);
writeFileSync(
  config,
  JSON.stringify(
    {
      main: bundle,
      output: binary,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      assets: { "keyring.node": nodeFile },
    },
    null,
    2,
  ),
);

// Windows: node.exe carries Node's own Authenticode signature. Injecting the blob leaves that
// signature pointing at the wrong bytes, and signtool then refuses the result (0x800700C1), so
// the exe could never be signed with our certificate. Build from a copy with the signature cut off.
function copyWithoutSignature(src, dst) {
  const buf = readFileSync(src);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0")
    throw new Error("not a PE file");
  const opt = pe + 24;
  if (buf.readUInt16LE(opt) !== 0x20b) throw new Error("expected a PE32+ file");
  const dir = opt + 112 + 4 * 8; // certificate table entry
  const off = buf.readUInt32LE(dir);
  const size = buf.readUInt32LE(dir + 4);
  let out = buf;
  if (off && size) {
    buf.writeUInt32LE(0, dir);
    buf.writeUInt32LE(0, dir + 4);
    buf.writeUInt32LE(0, opt + 64); // checksum
    // The signature is the last thing in the file: cut it off.
    if (off + size === buf.length) out = buf.subarray(0, off);
  }
  writeFileSync(dst, out);
}
let nodeExe = process.execPath;
if (process.platform === "win32") {
  nodeExe = join(outDir, "node-unsigned.exe");
  copyWithoutSignature(process.execPath, nodeExe);
}
execFileSync(nodeExe, ["--build-sea", config], { stdio: "inherit" });
// Apple Silicon refuses to run unsigned code; sign ad-hoc (no Developer ID yet, spec 16 §3.2).
if (process.platform === "darwin") {
  execFileSync("codesign", ["--force", "--sign", "-", binary], {
    stdio: "inherit",
  });
}
console.log(`built ${binary}`);
