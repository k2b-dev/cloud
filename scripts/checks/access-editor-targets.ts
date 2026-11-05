import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/** Resource editors supply identity, never their own account-search transport. */
export const checkSource = (file: string, source: string): Finding[] => {
  if (isTestFile(file) || file.endsWith(".browser-harness.tsx")) return [];
  // App access is not a resource reference: it uses the app-access management service, without a resource reader.
  if (file.endsWith("/cloud/src/access/AppAccessEditor.tsx")) return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const report = (node: ts.Node) =>
    findings.push({
      file,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      message: "Resource share editors must pass target: { type, id }; the platform supplies targeted service-account lookup by default.",
    });
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "openAccessDialog") {
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options) && !options.properties.some((prop) => prop.name?.getText(tree) === "target"))
        report(node);
    }
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(tree) === "PermissionEditor") {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const disabled = attributes.some(
        (prop) =>
          ["canEdit", "allowServiceAccounts"].includes(prop.name.getText(tree)) &&
          prop.initializer &&
          ts.isJsxExpression(prop.initializer) &&
          prop.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword,
      );
      if (!disabled && !attributes.some((prop) => prop.name.getText(tree) === "target")) report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return findings;
};

export const rule: Rule = {
  name: "access-editor-targets",
  description: "Resource share editors supply their target for the built-in service-account lookup",
  run: async ({ workspaceRoot }) =>
    listFiles(join(workspaceRoot, "packages"), /\.tsx$/)
      .sort()
      .flatMap((file) => checkSource(file, readFileSync(file, "utf8"))),
};
