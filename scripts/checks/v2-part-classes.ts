import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { v2Parts } from "../../packages/ui/scripts/v2-parts";
import { isTestFile, listFiles, parseSource } from "./files";
import type { Finding, Rule } from "./rule";

/** Class tokens written in a JSX class value, including string parts of expressions. */
const classTokens = (initializer: ts.JsxAttributeValue): string[] => {
  const tokens: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      tokens.push(...node.text.split(/\s+/).filter(Boolean));
    ts.forEachChild(node, collect);
  };
  collect(initializer);
  return tokens;
};

/**
 * The shipped v2.css gives an inner part of a primitive (packages/ui/scripts/v2-parts.ts) no way through an island
 * wrapper, because only its primitive puts it, inside its own element. Markup outside @k2b/ui that wrote such a class
 * could stand in an island, and the part's rules would miss it there.
 */
export const rule: Rule = {
  name: "v2-part-classes",
  description: "Markup outside @k2b/ui names no class of an inner part of a v2 primitive",
  run: async ({ workspaceRoot }) => {
    const packages = join(workspaceRoot, "packages");
    const parts = v2Parts(join(packages, "ui", "src", "v2"));
    const findings: Finding[] = [];
    const sources = [packages, join(workspaceRoot, "pwas"), join(workspaceRoot, "docs-site", "src")]
      .flatMap((root) => listFiles(root, /\.tsx$/))
      .filter((file) => !isTestFile(file) && !file.startsWith(join(packages, "ui", "")))
      .sort();
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("k2-")) continue;
      const { sourceFile, findings: unparsed } = parseSource(file, source);
      findings.push(...unparsed);
      const visit = (node: ts.Node): void => {
        if (ts.isJsxAttribute(node) && node.initializer && /^class(Name|List)?$/.test(node.name.getText(sourceFile))) {
          const named = classTokens(node.initializer).filter((token) => parts.has(token));
          if (named.length > 0)
            findings.push({
              file,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
              message: `${named.join(" ")} is an inner part of a v2 primitive; render the primitive that puts it instead.`,
            });
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return findings;
  },
};
