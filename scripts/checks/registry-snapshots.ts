import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import ts from "@typescript/typescript6";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const handles = new Set(["appRegistry", "capabilityRegistry", "appInstanceRegistry"]);
// Writers and instance-authority/admin readers are deliberate, bounded source consumers.
const owners: Record<string, readonly string[]> = {
  "packages/cloud/src/_internal/registry.ts": [...handles],
  "packages/cloud/src/index.ts": ["appRegistry", "capabilityRegistry"],
  "packages/cloud/src/_internal/define-app.ts": [...handles],
  "packages/cloud/src/services/app-migration.ts": ["appInstanceRegistry"],
  "packages/cloud/src/services/app-migration-evidence.ts": ["appInstanceRegistry"],
  "packages/cloud/src/services/identity/workload-runtime.ts": ["appInstanceRegistry"],
  "packages/cloud/bench/registry.ts": ["appRegistry", "capabilityRegistry"],
};

/** Check imported/exported symbols, including aliases; call spelling cannot bypass ownership. */
export const checkSource = (file: string, source: string): Finding[] => {
  if (isTestFile(file) || /\.test-fixture\.tsx?$/.test(file)) return [];
  if (![...handles].some((name) => source.includes(name)) && !/\bexport\s*\*/.test(source)) return [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const allowed = owners[file] ?? [];
  const report = (name: string, node: ts.Node) => {
    if (!handles.has(name) || allowed.includes(name)) return;
    findings.push({
      file,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      message: `${name} belongs to registry writers and explicit instance readers. Use getApp/listApps/getCapability/listCapabilities from the observed view on read paths.`,
    });
  };
  const registryModule = (node: ts.Expression | undefined) =>
    node &&
    ts.isStringLiteral(node) &&
    (node.text === "@k2b/cloud" ||
      (node.text.startsWith(".") &&
        normalize(join(dirname(file), node.text.replace(/\.tsx?$/, ""))) === "packages/cloud/src/_internal/registry"));
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) && registryModule(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const item of bindings.elements) report((item.propertyName ?? item.name).text, item);
      if (bindings && ts.isNamespaceImport(bindings)) {
        const visit = (node: ts.Node): void => {
          if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === bindings.name.text)
            report(node.name.text, node);
          if (
            ts.isElementAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === bindings.name.text &&
            ts.isStringLiteral(node.argumentExpression)
          )
            report(node.argumentExpression.text, node);
          if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            ts.isIdentifier(node.initializer) &&
            node.initializer.text === bindings.name.text &&
            ts.isObjectBindingPattern(node.name)
          )
            for (const element of node.name.elements) report((element.propertyName ?? element.name).getText(ast), element);
          ts.forEachChild(node, visit);
        };
        visit(ast);
      }
    }
    if (ts.isExportDeclaration(statement) && registryModule(statement.moduleSpecifier)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause))
        for (const item of statement.exportClause.elements) report((item.propertyName ?? item.name).text, item);
      else for (const name of handles) report(name, statement);
    }
  }
  return findings;
};

export const rule: Rule = {
  name: "registry-snapshots",
  description: "Hot paths read observed registry views, never raw registry handles",
  run: async ({ workspaceRoot }) =>
    workspacePackages(workspaceRoot)
      .flatMap((root) => listFiles(join(workspaceRoot, root), sourceFilePattern))
      .flatMap((file) => checkSource(relative(workspaceRoot, file), readFileSync(file, "utf8"))),
};
