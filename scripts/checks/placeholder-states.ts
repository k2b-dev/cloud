import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const STATUS_GLYPH = /^ti-(?:loader(?:-[\w-]+)?|alert-[\w-]+|[\w-]+-alert|exclamation-[\w-]+)$/;

/** Inspect literal class tokens, including the string parts of expressions and templates. */
const hasStatusGlyph = (initializer: ts.JsxAttributeValue): boolean => {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (node.text.split(/\s+/).some((token) => STATUS_GLYPH.test(token))) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(initializer);
  return found;
};

export const rule: Rule = {
  name: "placeholder-states",
  description: "Placeholder loading and error glyphs declare their state",
  run: async ({ workspaceRoot }) => {
    const sourceRoots = [join(workspaceRoot, "packages"), join(workspaceRoot, "pwas"), join(workspaceRoot, "docs-site", "src")];
    const findings: Finding[] = [];

    for (const file of sourceRoots.flatMap((root) => listFiles(root, /\.tsx$/)).sort()) {
      if (isTestFile(file)) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("Placeholder")) continue;
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

      const visit = (node: ts.Node): void => {
        if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText() === "Placeholder") {
          const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
          const icon = attributes.find((attribute) => attribute.name.getText() === "icon");
          if (
            !attributes.some((attribute) => attribute.name.getText() === "state") &&
            icon?.initializer &&
            hasStatusGlyph(icon.initializer)
          ) {
            findings.push({
              file,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
              message:
                'Placeholder shows a loading or error glyph without state="loading" or state="error": the default empty state puts its icon in the app-colour chip, and status needs its role and colour.',
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
