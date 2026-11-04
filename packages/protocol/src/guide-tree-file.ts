import { readFileSync } from "node:fs";
import type { GuideTree } from "./guide-tree.ts";

/** The decision tree file (packages/protocol/guide/tree.json, shipped beside the relay bundle). Node only. */
export function loadGuideTree(): GuideTree {
  return JSON.parse(
    readFileSync(new URL("../guide/tree.json", import.meta.url), "utf8"),
  ) as GuideTree;
}
