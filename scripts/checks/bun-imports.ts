import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

// A type position such as `import("bun").BunPlugin` stays allowed.
const dynamicBunImport = /\bimport\(\s*["']bun["']\s*\)(?!\s*\.)/;

/**
 * The minified server bundle turns a dynamic import of "bun" into
 * `awaitPromise.resolve(globalThis.Bun)`, which throws at runtime (#137).
 * Source runs and tests pass, so the defect only shows in production.
 */
export const rule: Rule = {
  name: "bun-imports",
  description: "Bun built-ins are imported statically, never through a dynamic import",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const dir of ["packages", "scripts", "tests"]) {
      for (const file of listFiles(join(workspaceRoot, dir), sourceFilePattern).sort()) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (dynamicBunImport.test(line))
              findings.push({
                file,
                line: index + 1,
                message: 'use a static `import { … } from "bun"`; the minified bundle breaks a dynamic import of "bun" (#137)',
              });
          });
      }
    }
    return findings;
  },
};
