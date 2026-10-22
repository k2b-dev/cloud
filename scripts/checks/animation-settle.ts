import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const hasTimelineAccess = (node: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(node) && node.name.text === "timeline") || (ts.forEachChild(node, hasTimelineAccess) ?? false);

export const checkSource = (file: string, source: string): Finding[] => {
  if (!source.includes("getAnimations")) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "getAnimations") {
      const target = node.expression.expression;
      const documentWide = ts.isIdentifier(target) && target.text === "document";
      const options = node.arguments[0];
      const subtree =
        options &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(sourceFile) === "subtree" &&
            property.initializer.kind === ts.SyntaxKind.TrueKeyword,
        );
      if (documentWide || subtree) {
        let statement: ts.Node = node;
        while (statement.parent && !ts.isStatement(statement)) statement = statement.parent;
        const allTimelines = ts
          .getLeadingCommentRanges(source, statement.getFullStart())
          ?.some(
            (comment) =>
              comment.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
              /^\/\/ animation-settle: all timelines(?:[ \t]+.*)?$/.test(source.slice(comment.pos, comment.end)),
          );
        if (!hasTimelineAccess(statement) && !allTimelines) {
          findings.push({
            file,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            message:
              "Scroll-driven animations, such as the navigation label fade, never finish: filter `animation.timeline === document.timeline` before waiting on page animations; see docs-site/docs/en/contributing/testing.md",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

export const rule: Rule = {
  name: "animation-settle",
  description: "Page animation waits account for scroll-driven animations that never finish",
  run: async ({ workspaceRoot }) =>
    [...workspacePackages(workspaceRoot), "scripts", "tests"]
      .flatMap((root) => listFiles(join(workspaceRoot, root), sourceFilePattern))
      .filter((file) => isTestFile(file) || file.endsWith(".browser-suite.ts") || file.endsWith(".browser-harness.tsx"))
      .sort()
      .flatMap((file) => checkSource(file, readFileSync(file, "utf8"))),
};
