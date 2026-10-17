import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const refreshes = (node: ts.Node): boolean => {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "refreshing")
    return true;
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "loading" &&
    !(ts.isCallExpression(node.parent) && node.parent.expression === node)
  )
    return true;
  return ts.forEachChild(node, (child) => refreshes(child) || undefined) === true;
};

export const checkSource = (file: string, source: string): Finding[] => {
  // App-local wrappers such as Assistant's StudioPermissions are not followed.
  if (isTestFile(file) || (!source.includes("<PermissionEditor") && !source.includes("<ScopedPermissionEditor"))) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const visit = (node: ts.Node, unstable: boolean): void => {
    const element = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined;
    const tag = element?.tagName.getText(sourceFile);
    if (element && (tag === "Show" || tag === "Match")) {
      unstable ||= element.attributes.properties.some((attribute) => {
        if (!ts.isJsxAttribute(attribute)) return false;
        const name = attribute.name.getText(sourceFile);
        const value = attribute.initializer;
        if (name === "keyed") {
          return !(value && ts.isJsxExpression(value) && value.expression?.kind === ts.SyntaxKind.FalseKeyword);
        }
        return name === "when" && value !== undefined && refreshes(value);
      });
    }
    if (unstable && (tag === "PermissionEditor" || tag === "ScopedPermissionEditor")) {
      findings.push({
        file,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        message:
          "Access editors must stay mounted across refetches: they merge new entries by id so keyboard focus and open member lists survive. Remove keyed, refreshing(), and loading property gates from ancestor Show/Match elements.",
      });
    }
    ts.forEachChild(node, (child) => visit(child, unstable));
  };
  visit(sourceFile, false);
  return findings;
};

export const rule: Rule = {
  name: "access-editor-mounts",
  description: "Access editors stay mounted across refetches to preserve focus and open member lists",
  run: async ({ workspaceRoot }) =>
    ["packages", "pwas", "docs-site/src"]
      .flatMap((root) => listFiles(join(workspaceRoot, root), /\.tsx$/))
      .sort()
      .flatMap((file) => checkSource(file, readFileSync(file, "utf8"))),
};
