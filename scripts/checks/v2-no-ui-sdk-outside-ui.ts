import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { listFiles, parseSource } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * ui-sdk is the behaviour layer below `@k2b/ui` v2 (menus, dialogs, selection, dragging). Only `packages/ui` may see
 * it: an app or another package that imports `@ui-sdk/*`, or depends on it, binds itself to a beta API that `@k2b/ui`
 * is meant to absorb, and grows a second way to build the same control. Tests count too; a test that needs ui-sdk
 * belongs in `packages/ui`.
 */
const SCOPE = /^@ui-sdk\//;
const ROOTS = ["packages", "docs-site", "scripts", "fixtures", "pwas", "tests"];
const OWNER = "packages/ui/";
const sourcePattern = /\.(?:[cm]?[jt]sx?)$/;
const replacement = "use the matching @k2b/ui/v2 primitive; only packages/ui imports ui-sdk";

/** Every module specifier in one source that names `@ui-sdk/*`: imports, re-exports, `import()`, `require()`, `import("…")` types. */
export const uiSdkImports = (file: string, source: string): { line: number; specifier: string }[] => {
  const { sourceFile } = parseSource(file, source);
  const found: { line: number; specifier: string }[] = [];
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node) && SCOPE.test(node.text))
      found.push({ line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, specifier: node.text });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")))
      add(node.arguments[0]);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

/** The `@ui-sdk/*` names a package manifest depends on, in any dependency field. */
export const uiSdkDependencies = (manifest: string): string[] => {
  const parsed: unknown = JSON.parse(manifest);
  if (!parsed || typeof parsed !== "object") return [];
  return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) => {
    const deps: unknown = Reflect.get(parsed, field);
    return deps && typeof deps === "object" ? Object.keys(deps).filter((name) => SCOPE.test(name)) : [];
  });
};

export const rule: Rule = {
  name: "v2-no-ui-sdk-outside-ui",
  description: "Only packages/ui imports or depends on @ui-sdk/*; apps reach ui-sdk through @k2b/ui/v2",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const outside = (path: string) => !relative(workspaceRoot, path).startsWith(OWNER);
    for (const root of ROOTS) {
      const directory = join(workspaceRoot, root);
      if (!existsSync(directory)) continue;
      for (const path of listFiles(directory, sourcePattern).filter(outside)) {
        const source = readFileSync(path, "utf8");
        if (!source.includes("@ui-sdk/")) continue;
        for (const { line, specifier } of uiSdkImports(path, source))
          findings.push({ file: relative(workspaceRoot, path), line, message: `imports ${specifier}; ${replacement}` });
      }
      for (const path of listFiles(directory, /^package\.json$/).filter(outside))
        for (const name of uiSdkDependencies(readFileSync(path, "utf8")))
          findings.push({ file: relative(workspaceRoot, path), message: `depends on ${name}; ${replacement}` });
    }
    const rootManifest = join(workspaceRoot, "package.json");
    if (existsSync(rootManifest))
      for (const name of uiSdkDependencies(readFileSync(rootManifest, "utf8")))
        findings.push({ file: "package.json", message: `depends on ${name}; ${replacement}` });
    return findings;
  },
};
