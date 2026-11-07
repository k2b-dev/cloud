import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

// These application services survive the engine cut. Workflow-specific adapters
// elsewhere in Mail and Grids still deliberately consume the public engine API.
const retainedMailFiles = new Set([
  "packages/mail/src/index.ts",
  "packages/mail/src/migrate.ts",
  "packages/mail/src/service/commands.ts",
  "packages/mail/src/service/command-runtime.ts",
  "packages/mail/src/service/conversation-summary-ai.ts",
]);

export const checkSource = (file: string, source: string, workspaceRoot: string): Finding[] => {
  const path = relative(workspaceRoot, file).replaceAll("\\", "/");
  if (isTestFile(path) || path.includes(".test-fixture.")) return [];
  const cloudSource = path.startsWith("packages/cloud/src/");
  // Model replacement still rewrites workflow versions; it belongs to the later engine cut.
  if (path === "packages/cloud/src/ai/model-delete.ts" || path.startsWith("packages/cloud/src/workflows/")) return [];
  if (!cloudSource && !retainedMailFiles.has(path)) return [];

  const engine = resolve(workspaceRoot, "packages/cloud/src/workflows");
  const workflowImport = (specifier: string): boolean => {
    if (specifier === "@k2b/cloud/workflows" || specifier.startsWith("@k2b/cloud/workflows/")) return true;
    const target = specifier.startsWith(".")
      ? resolve(dirname(file), specifier)
      : isAbsolute(specifier)
        ? specifier
        : resolve(workspaceRoot, specifier);
    return target === engine || target.startsWith(`${engine}/`);
  };
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && workflowImport(node.text)) {
      const parent = node.parent;
      if (
        ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) ||
        ts.isExternalModuleReference(parent) ||
        (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) ||
        (ts.isCallExpression(parent) &&
          (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(parent.expression) && parent.expression.text === "require")) &&
          parent.arguments[0] === node)
      )
        findings.push({
          file,
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          message:
            "Non-workflow platform and retained Mail services must use AI tasks or shared helpers outside packages/cloud/src/workflows/.",
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return findings;
};

export const rule: Rule = {
  name: "workflow-boundaries",
  description: "shared platform and retained Mail services do not depend on the workflow engine",
  run: async ({ workspaceRoot }) =>
    ["packages/cloud/src", "packages/mail/src"].flatMap((directory) =>
      listFiles(join(workspaceRoot, directory), sourceFilePattern).flatMap((file) =>
        checkSource(file, readFileSync(file, "utf8"), workspaceRoot),
      ),
    ),
};
