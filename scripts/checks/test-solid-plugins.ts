import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { listFiles, parseSource } from "./files";
import type { Finding, Rule } from "./rule";

const registrations = new Set([
  "packages/ui/test/ssr-test-plugin.ts",
  "packages/ui/test/solid-dom-preload.ts",
  // The public app smoke starts this file as its own Bun process with the app's production plugin.
  "packages/cloud/src/_internal/public-surface-ssr.test-fixture.ts",
]);
const testFile =
  /\.(?:test|spec)\.tsx?$|(?:fixture|harness|suite|browser-server|ssr-test-plugin)\.tsx?$|(?:^|\/)(?:test|tests)\/|^scripts\/fixtures\//;
const message =
  "Process-wide test plugins must use registerSsrTestPlugin from packages/ui/test/ssr-test-plugin; the DOM compiler belongs only in the runner's solid-dom-preload. Keep other compile modes in Bun.build({ plugins: [...] }).";

/** Strings passed to a subprocess and build-local plugins do not change this test process. */
export const checkSource = (file: string, source: string): Finding[] => {
  if (registrations.has(file)) return [];
  const { sourceFile, findings } = parseSource(file, source);
  const domTest = /\.behavior\.test\.tsx?$|^packages\/ssr\/test\/browser\//.test(file);
  const report = (node: ts.Node) =>
    findings.push({ file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, message });
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) && node.expression.getText(sourceFile) === "Bun" && node.name.text === "plugin") ||
      (ts.isElementAccessExpression(node) &&
        node.expression.getText(sourceFile) === "Bun" &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "plugin")
    ) {
      report(node);
      return;
    }
    if (ts.isVariableDeclaration(node) && node.initializer?.getText(sourceFile) === "Bun" && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements)
        if ((element.propertyName ?? element.name).getText(sourceFile) === "plugin") report(element);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const path = node.moduleSpecifier.text;
      if (path === "bun" && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements)
          if ((element.propertyName ?? element.name).text === "plugin") report(element);
      }
      if (path.endsWith("/solid-dom-preload") || path.endsWith("/solid-dom-preload.ts")) report(node);
      if (domTest && /\/(?:ssr-test-plugin|solid-ssr-preload)(?:\.ts)?$/.test(path) && !node.importClause?.isTypeOnly) {
        findings.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          message: "DOM tests use the runner's solid-dom-preload; importing an SSR compiler changes their process-wide compile mode.",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

export const rule: Rule = {
  name: "test-solid-plugins",
  description: "tests share the island-aware SSR compiler; process-wide compile modes belong to sanctioned test helpers",
  run: async ({ workspaceRoot }) =>
    ["packages", "pwas", "fixtures", "docs-site", "scripts", "tests"]
      .flatMap((root) => listFiles(join(workspaceRoot, root), /\.tsx?$/))
      .filter((file) => testFile.test(relative(workspaceRoot, file)))
      .flatMap((file) => checkSource(relative(workspaceRoot, file), readFileSync(file, "utf8")))
      .map((finding) => ({ ...finding, file: join(workspaceRoot, finding.file!) })),
};
