import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { exampleFiles } from "./files";

const target = resolve(import.meta.dir, "registry.generated.ts");

/** The registry module for the example files in this folder. */
export const exampleRegistrySource = () => {
  const names = exampleFiles().map((file) => file.replace(/\.ts$/, ""));
  // One line per file, named after it, so two lanes that each add a file touch different lines.
  const name = (file: string) => `${file.replace(/[^\w$]/g, "_")}Examples`;
  return [
    "// Generated from the example files in this folder by generate.ts, which every Fibel start and build runs.",
    "// Do not edit: add a `<kind>.ts` next to it instead. After a merge conflict here, run generate.ts again.",
    ...names.map((file) => `import * as ${name(file)} from "./${file}";`),
    "",
    "export const exampleModules: Record<string, unknown>[] = [",
    ...names.map((file) => `  ${name(file)},`),
    "];",
    "",
  ].join("\n");
};

/** Rewrites registry.generated.ts when the folder changed; returns whether it did. */
export const writeExampleRegistry = (): boolean => {
  const next = exampleRegistrySource();
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {}
  if (current === next) return false;
  writeFileSync(target, next);
  return true;
};

if (import.meta.main) console.log(writeExampleRegistry() ? "Updated registry.generated.ts" : "registry.generated.ts is current");
