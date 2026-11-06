// Regenerates apps/web/public/hawl-local-api.openapi.json from tool-defs.ts.
// Run: node packages/cli/build/gen-openapi.ts
import { writeFileSync } from "node:fs";
import { openApi } from "../src/api/openapi.ts";

export const OPENAPI_FILE = new URL(
  "../../../apps/web/public/hawl-local-api.openapi.json",
  import.meta.url,
);

if (import.meta.main) {
  writeFileSync(OPENAPI_FILE, `${JSON.stringify(openApi(), null, 2)}\n`);
  console.log(`wrote ${OPENAPI_FILE.pathname}`);
}
