import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/** Class tokens written in a JSX `class` value, including string parts of expressions. */
const classTokens = (initializer: ts.JsxAttributeValue): string[] => {
  const tokens: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      tokens.push(...node.text.split(/\s+/).filter(Boolean));
    }
    ts.forEachChild(node, collect);
  };
  collect(initializer);
  return tokens;
};

/** Marker classes a package renders for its hosts to select, with no style of its own. */
const HOOK_CLASSES = new Set(["k2b-editor-toolbar"]);

/**
 * A `k2b-*` class that no stylesheet defines styles nothing, and the markup silently loses its look: Spaces history
 * and Code review links used `k2b-link` instead of `k2b-text-link` and rendered as plain text. `@k2b/ui` guards its own
 * sources in `class-contract.test.ts`; this rule covers the code that consumes it.
 */
export const rule: Rule = {
  name: "ui-classes",
  description: "Markup outside @k2b/ui names only k2b-* classes that a shipped stylesheet defines",
  run: async ({ workspaceRoot }) => {
    const packages = join(workspaceRoot, "packages");
    const defined = new Set<string>(HOOK_CLASSES);
    for (const file of [...listFiles(packages, /\.css$/), join(workspaceRoot, "styles.css")]) {
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const match of source.matchAll(/\.(k2b-[\w-]+)/g)) defined.add(match[1]!);
    }
    const findings: Finding[] = [];
    const sources = [packages, join(workspaceRoot, "pwas"), join(workspaceRoot, "docs-site", "src")]
      .flatMap((root) => listFiles(root, /\.tsx$/))
      .filter((file) => !isTestFile(file) && !file.startsWith(join(packages, "ui", "")))
      .sort();
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("k2b-")) continue;
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node): void => {
        if (ts.isJsxAttribute(node) && node.initializer && ["class", "bodyClass"].includes(node.name.getText(sourceFile))) {
          const unknown = classTokens(node.initializer).filter((token) => /^k2b-[\w-]+$/.test(token) && !defined.has(token));
          if (unknown.length > 0) {
            findings.push({
              file,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
              message: `${unknown.join(" ")} is not defined by any stylesheet; use the @k2b/ui class or component that has the look (links: k2b-text-link).`,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return findings;
  },
};
