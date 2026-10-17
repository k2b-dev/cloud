import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const propertyName = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

export const rule: Rule = {
  name: "page-size",
  description: "Paginate-backed services page through collections within paginate()'s 1000 cap",
  run: async ({ workspaceRoot }) => {
    const roots = [join(workspaceRoot, "packages"), join(workspaceRoot, "pwas"), join(workspaceRoot, "docs-site", "src")];
    const findings: Finding[] = [];
    for (const file of roots.flatMap((root) => listFiles(root, /\.tsx?$/)).sort()) {
      if (isTestFile(file)) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("perPage")) continue;
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isPropertyAssignment(node) &&
          propertyName(node.name) === "perPage" &&
          ts.isNumericLiteral(node.initializer) &&
          Number(node.initializer.text.replaceAll("_", "")) > 1000 &&
          ts.isObjectLiteralExpression(node.parent) &&
          ts.isPropertyAssignment(node.parent.parent) &&
          node.parent.parent.initializer === node.parent &&
          propertyName(node.parent.parent.name) === "pagination"
        ) {
          findings.push({
            file,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            message:
              "paginate() caps perPage at 1000 without notice; page through the collection with a stable order instead of relying on a silent clamp.",
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return findings;
  },
};
