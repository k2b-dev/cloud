import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

export const checkSource = (file: string, source: string): Finding[] => {
  if (!source.includes("cookies")) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "cookies") {
      let statement: ts.Node = node;
      while (statement.parent && !ts.isStatement(statement)) statement = statement.parent;
      const deliberate = ts
        .getLeadingCommentRanges(source, statement.getFullStart())
        ?.some(
          (comment) =>
            comment.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
            /^\/\/ cookie-store:[ \t]+\S.*$/.test(source.slice(comment.pos, comment.end)),
        );
      if (!deliberate) {
        findings.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          message:
            "Use storedCookie(page, name) from packages/ui/test/browser because WebKit stores document.cookie writes asynchronously; see docs-site/docs/en/contributing/testing.md",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

export const rule: Rule = {
  name: "cookie-store",
  description: "Cookie reads wait until the browser store agrees with the document",
  run: async ({ workspaceRoot }) =>
    [...workspacePackages(workspaceRoot), "scripts", "tests"]
      .flatMap((root) => listFiles(join(workspaceRoot, root), sourceFilePattern))
      .filter((file) => isTestFile(file) || file.endsWith(".browser-suite.ts") || file.endsWith(".browser-harness.tsx"))
      .sort()
      .flatMap((file) => checkSource(file, readFileSync(file, "utf8"))),
};
