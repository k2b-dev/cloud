import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const sdk = (value: string) => value === "@k2b/filegate" || value === "@k2b/filegate/client";
export function checkSource(file: string, source: string): Finding[] {
  const path = file.replaceAll("\\", "/");
  if (
    !path.includes("packages/filesv2/") ||
    isTestFile(path) ||
    path.includes("packages/filesv2/test/") ||
    /\.browser-(?:harness|suite)\.[jt]sx?$/.test(path) ||
    path.endsWith("/src/service/filegate-facade.ts")
  )
    return [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const report = (node: ts.Node) =>
    findings.push({
      file,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      message:
        "Use the Files V2 Filegate facade (service/filegate-facade.ts) so every write is guarded; see docs-site/docs/en/operations/files-history.md",
    });
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && sdk(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (!clause) report(node);
      else if (!clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (
          clause.name ||
          (bindings && ts.isNamespaceImport(bindings)) ||
          (bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.some((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text !== "FilegateError"))
        )
          report(node);
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      sdk(node.moduleSpecifier.text) &&
      !node.isTypeOnly
    ) {
      if (
        !node.exportClause ||
        !ts.isNamedExports(node.exportClause) ||
        node.exportClause.elements.some((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text !== "FilegateError")
      )
        report(node);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      sdk(node.moduleReference.expression.text)
    )
      report(node);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      sdk(node.arguments[0].text)
    )
      report(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return findings;
}

export const rule: Rule = {
  name: "filegate-facade",
  description: "Files V2 external writes cannot bypass domain history",
  run: async ({ workspaceRoot }) =>
    listFiles(join(workspaceRoot, "packages/filesv2"), sourceFilePattern)
      .sort()
      .flatMap((file) => checkSource(file, readFileSync(file, "utf8"))),
};
