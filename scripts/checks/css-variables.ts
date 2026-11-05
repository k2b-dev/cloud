import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * A `var(--k2b-…)` or `var(--ui-…)` that nothing defines resolves to nothing: a removed token silently turns red text
 * black or drops a background. Every such use without a fallback names a custom property that some stylesheet
 * declares, or that code sets at runtime as a quoted name (a style object key or `setProperty`). Tests are skipped,
 * because they may name removed tokens on purpose.
 */
const ROOTS = ["packages", "docs-site", "fixtures", "styles.css"];
const NAME = String.raw`--(?:k2b|ui)-[\w-]*\w`;
const declaration = new RegExp(`(${NAME})\\s*:`, "g");
const quoted = new RegExp(`["'\`](${NAME})["'\`]`, "g");
const use = new RegExp(`var\\(\\s*(${NAME})\\s*(,?)`, "g");

const lineAt = (source: string, index: number) => source.slice(0, index).split("\n").length;

export const rule: Rule = {
  name: "css-variables",
  description: "Every var(--k2b-*) and var(--ui-*) without a fallback names a custom property that is defined",
  run: async ({ workspaceRoot }) => {
    const files = ROOTS.flatMap((root) => {
      const path = join(workspaceRoot, root);
      if (!existsSync(path)) return [];
      return root.endsWith(".css") ? [path] : listFiles(path, /\.(?:css|ts|tsx)$/);
    })
      .filter((file) => !isTestFile(file))
      .sort();
    const sources = files.map((file) => ({ file, source: readFileSync(file, "utf8") }));

    const defined = new Set<string>();
    for (const { file, source } of sources) {
      for (const match of source.matchAll(declaration)) defined.add(match[1]!);
      if (!file.endsWith(".css")) for (const match of source.matchAll(quoted)) defined.add(match[1]!);
    }

    const findings: Finding[] = [];
    for (const { file, source } of sources) {
      for (const match of source.matchAll(use)) {
        const name = match[1]!;
        // A fallback makes the property optional; a name built in a template, such as `--k2b-lane-${unit}`, is open.
        if (match[2] === "," || /[-$]/.test(source[(match.index ?? 0) + match[0].indexOf(name) + name.length] ?? "")) continue;
        if (defined.has(name)) continue;
        findings.push({
          file,
          line: lineAt(source, match.index ?? 0),
          message: `${name} is not defined anywhere, so var(${name}) resolves to nothing. Use the current @k2b/ui token (for example --k2b-danger-text, --k2b-text-muted, --k2b-focus-ring) or add a fallback.`,
        });
      }
    }
    return findings;
  },
};
