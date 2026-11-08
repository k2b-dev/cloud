import { readdirSync } from "node:fs";
import type { ChartShowcaseExample } from "./types";

/** Files in this folder that hold no examples. */
const support = new Set(["index.ts", "files.ts", "generate.ts", "registry.generated.ts", "types.ts", "common.ts"]);

/** Example files in this folder (or another copy of it, such as a repository check's), in name order. */
export const exampleFiles = (folder = import.meta.dir) =>
  readdirSync(folder)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !support.has(file))
    .sort();

export const isExampleList = (value: unknown): value is ChartShowcaseExample[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((entry) => typeof entry === "object" && entry !== null && "id" in entry && "kind" in entry && "spec" in entry);
