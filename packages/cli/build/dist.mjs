// Builds dist/main.js, the node entry behind `bin.hawl` and CI-3's HAWL_CLI.
// Usage: node build/dist.mjs   (HAWL_VERSION=0.1.2 stamps a release version; default package.json)
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import "./gen-skills.mjs"; // skill text in the bundle always comes from plugins/claude-code/skills

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version =
  process.env.HAWL_VERSION ||
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

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

await build({
  entryPoints: [join(root, "src/main.ts")],
  outfile: process.env.HAWL_BUILD_OUTFILE || join(root, "dist/main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module";\nconst require = __cr(import.meta.url);',
  },
  // Only src/main.ts starts itself in the bundle (it checks __HAWL_VERSION__).
  define: {
    "import.meta.main": "false",
    __HAWL_VERSION__: JSON.stringify(version),
    __HAWL_UPDATE_PUBKEY__: JSON.stringify(updatePublicKey),
  },
  external: ["@napi-rs/keyring"],
  legalComments: "none",
});
console.log("built dist/main.js");
