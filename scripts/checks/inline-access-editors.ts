import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles, parseSource } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Who changes access does so in the shared access dialog (`openAccessDialog`), which brings the service-account
 * section and the review step to every app (#3673). Outside the shared access package, `PermissionEditor` only lists
 * access read-only (`canEdit={false}`), where it still shows whom a group reaches.
 */
const sharedAccess = "packages/cloud/src/access/";

/** Editable inline editors with their reason next to the call; each picks an audience, not a share of a resource. */
const allowed = new Set(["packages/core/src/pages/admin/rail/NavigationScreen.tsx"]);

export const checkSource = (file: string, source: string): Finding[] => {
  if (file.startsWith(sharedAccess) || allowed.has(file) || isTestFile(file) || /\.browser-(?:harness|fixture|frame)\.tsx$/.test(file))
    return [];
  if (!source.includes("<PermissionEditor")) return [];
  const { sourceFile, findings } = parseSource(file, source);
  const readOnly = (element: ts.JsxSelfClosingElement | ts.JsxOpeningElement) =>
    element.attributes.properties.some(
      (attribute) =>
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText(sourceFile) === "canEdit" &&
        attribute.initializer !== undefined &&
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword,
    );
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(sourceFile) === "PermissionEditor" &&
      !readOnly(node)
    )
      findings.push({
        file,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        message:
          "Change access in the shared access dialog: show AccessSummary and call openAccessDialog. An inline PermissionEditor outside @k2b/cloud/access may only list access with canEdit={false}.",
      });
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

export const rule: Rule = {
  name: "inline-access-editors",
  description: "Access changes go through the shared access dialog, not an editable inline PermissionEditor",
  run: async ({ workspaceRoot }) =>
    ["packages", "pwas"]
      .flatMap((root) => listFiles(join(workspaceRoot, root), /\.tsx$/))
      .sort()
      .flatMap((path) => checkSource(relative(workspaceRoot, path), readFileSync(path, "utf8"))),
};
