// esbuild plugin: bundles the protocol JSON Schema files into the CLI.
// packages/protocol/src/validate.ts reads them from disk relative to import.meta.url, which does
// not exist next to a single-file build (the .exe fails on every command). The plugin keeps the
// disk reader for source runs and swaps the exported loader for the embedded copy.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const protocol = resolve(here, "../../protocol");
const DIRS = ["schemas", "tools", "frames", "console"];
const SUFFIX = ".schema.json";

export function embeddedSchemas() {
  const files = [];
  for (const dir of DIRS) {
    const base = join(protocol, dir);
    let names = [];
    try {
      names = readdirSync(base).sort();
    } catch {
      continue;
    }
    for (const f of names) {
      if (!f.endsWith(SUFFIX)) continue;
      files.push({
        name: `${dir}/${f.slice(0, -SUFFIX.length)}`,
        schema: JSON.parse(readFileSync(join(base, f), "utf8")),
      });
    }
  }
  return files;
}

export const embedSchemasPlugin = {
  name: "embed-protocol-schemas",
  setup(build) {
    build.onLoad({ filter: /protocol[\\/]src[\\/]validate\.ts$/ }, (args) => {
      const src = readFileSync(args.path, "utf8");
      const marker = "export function loadSchemaFiles(): SchemaFile[] {";
      if (!src.includes(marker))
        throw new Error(
          "embed-schemas: loadSchemaFiles not found in validate.ts",
        );
      const swapped = src.replace(
        marker,
        "function loadSchemaFilesFromDisk(): SchemaFile[] {",
      );
      const json = JSON.stringify(JSON.stringify(embeddedSchemas()));
      const embedded = `
export function loadSchemaFiles(): SchemaFile[] {
  void loadSchemaFilesFromDisk;
  return JSON.parse(${json}) as SchemaFile[];
}
`;
      return { contents: swapped + embedded, loader: "ts" };
    });
  },
};
