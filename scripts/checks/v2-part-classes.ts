import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { v2Parts } from "../../packages/ui/scripts/v2-parts";
import { isTestFile, listFiles, parseSource } from "./files";
import type { Finding, Rule } from "./rule";

/** A string's words: a class list in a JSX value, a const, `attr:class`, a `classList` or a selector. */
const words = (node: ts.Node): string[] =>
  ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    ? (node.text.match(/\bk2-[a-z0-9-]+/g) ?? [])
    : [];

/**
 * The shipped v2.css gives an inner part of a primitive (packages/ui/scripts/v2-parts.ts) no way through an island
 * wrapper, because only its primitive puts it, inside its own element. Markup outside @k2b/ui that wrote such a class
 * could stand in an island, and the part's rules would miss it there. Every string of a source outside @k2b/ui counts
 * (a JSX class, a const, `attr:class`, a selector), and the k2b-ui skill's recipes, which people copy.
 */
export const rule: Rule = {
  name: "v2-part-classes",
  description: "Markup outside @k2b/ui names no class of an inner part of a v2 primitive",
  run: async ({ workspaceRoot }) => {
    const packages = join(workspaceRoot, "packages");
    const parts = v2Parts(join(packages, "ui", "src", "v2"));
    const findings: Finding[] = [];
    const recipes = join(packages, "ui", "skills", "k2b-ui", "recipes");
    const sources = [packages, join(workspaceRoot, "pwas"), join(workspaceRoot, "docs-site", "src")]
      .flatMap((root) => listFiles(root, /\.tsx?$/))
      .filter((file) => !isTestFile(file) && (!file.startsWith(join(packages, "ui", "")) || file.startsWith(join(recipes, ""))))
      .sort();
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("k2-")) continue;
      const { sourceFile, findings: unparsed } = parseSource(file, source);
      findings.push(...unparsed);
      const visit = (node: ts.Node): void => {
        const named = words(node).filter((token) => parts.has(token));
        if (named.length > 0)
          findings.push({
            file,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            message: `${named.join(" ")} is an inner part of a v2 primitive; render the primitive that puts it instead.`,
          });
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return findings;
  },
};
