import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exampleFiles } from "../../docs-site/src/ui/demo-sections/charts/examples/files";
import { exampleRegistrySource } from "../../docs-site/src/ui/demo-sections/charts/examples/generate";
import type { Rule } from "./rule";

const folder = "docs-site/src/ui/demo-sections/charts/examples";
const generator = `bun ${folder}/generate.ts`;
const imported = (source: string) => [...source.matchAll(/from "\.\/([^"]+)"/g)].map((match) => match[1]!);

/**
 * The committed chart showcase registry lists exactly the example files next to it. Fibel regenerates it on every
 * start, so a stale committed copy turns into an uncommitted change in every checkout that runs the docs.
 */
export const rule: Rule = {
  name: "showcase-registry",
  description: `The chart showcase registry matches its example files (${generator}; --fix writes it)`,
  run: async ({ workspaceRoot, fix }) => {
    const examples = join(workspaceRoot, folder);
    const target = join(examples, "registry.generated.ts");
    if (!existsSync(examples)) return [{ file: examples, message: "missing chart showcase example folder" }];
    const expected = exampleRegistrySource(exampleFiles(examples));
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (current === expected) return [];
    if (fix) {
      writeFileSync(target, expected);
      return [];
    }
    const missing = imported(expected).filter((name) => !imported(current).includes(name));
    const extra = imported(current).filter((name) => !imported(expected).includes(name));
    const difference = [
      ...(missing.length ? [`misses ${missing.join(", ")}`] : []),
      ...(extra.length ? [`lists ${extra.join(", ")}, which no example file provides`] : []),
    ];
    return [
      {
        file: target,
        message: `registry.generated.ts is not what its example files generate${difference.length ? ` (${difference.join("; ")})` : ""}. Run \`${generator}\` and commit the result.`,
      },
    ];
  },
};
