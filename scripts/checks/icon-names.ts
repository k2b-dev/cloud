import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const PRESET = "packages/ui/src/icons/tabler.css";

/**
 * A literal icon class such as `"ti ti-folder"`, in markup or in an `icon` value. A name that continues into a
 * template expression (`ti-file-${kind}`) is not literal and is skipped.
 */
const ICON_CLASS = /\bti ti-([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w$-])/g;

/** The icon names the `@k2b/ui` preset ships: the Tabler font it imports and the glyphs it adds itself. */
export const shippedIconNames = (workspaceRoot: string): Set<string> => {
  const preset = join(workspaceRoot, PRESET);
  const source = readFileSync(preset, "utf8");
  const imported = [...source.matchAll(/@import\s+"([^"]+)"/g)].map((match) =>
    readFileSync(Bun.resolveSync(match[1]!, dirname(preset)), "utf8"),
  );
  return new Set([source, ...imported].flatMap((css) => [...css.matchAll(/\.ti-([a-z0-9-]+)::?before\b/g)].map((match) => match[1]!)));
};

/**
 * An icon class the preset does not ship renders an empty box without any error, so every literal icon name in
 * application, platform, and catalog source, in help documents, and in documentation examples must be one the
 * preset contains. Tests are exempt: they may name a missing icon on purpose.
 */
export const rule: Rule = {
  name: "icon-names",
  description: "every literal `ti ti-*` icon name in source and Markdown is shipped by the @k2b/ui icon preset",
  run: async ({ workspaceRoot }) => {
    const shipped = shippedIconNames(workspaceRoot);
    const roots = ["packages", "pwas", "docs-site/src", "docs-site/docs"].map((root) => join(workspaceRoot, root));
    const findings: Finding[] = [];
    const files = roots.flatMap((root) => [...listFiles(root, sourceFilePattern), ...listFiles(root, /\.md$/)]);
    for (const file of files.sort()) {
      if (isTestFile(file)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(ICON_CLASS)) {
        if (shipped.has(match[1]!)) continue;
        const line = source.slice(0, match.index).split("\n").length;
        findings.push({ file, line, message: `Icon "ti-${match[1]}" is not in the @k2b/ui icon preset (${PRESET}), so it renders empty.` });
      }
    }
    return findings;
  },
};
