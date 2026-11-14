import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

// Generic Mail services may use the explicit command-legacy-effects bridge while
// old rules and their provider effects drain. Private rule adapters stay behind it.
// The shared workflow engine and its Grids consumers remain supported.
const retainedMailFiles = new Set([
  "packages/mail/src/index.ts",
  "packages/mail/src/migrate.ts",
  "packages/mail/src/service/commands.ts",
  "packages/mail/src/service/command-runtime.ts",
  "packages/mail/src/service/conversation-summary-ai.ts",
  "packages/mail/src/service/command-message-state.ts",
  "packages/mail/src/service/template-rendering.ts",
  "packages/mail/src/service/application-ai-runtime.ts",
  "packages/mail/src/service/conversation-summary.ts",
  "packages/mail/src/service/conversation-summary-jobs.ts",
  "packages/mail/src/service/conversation-summary-lifecycle.ts",
  "packages/mail/src/service/conversation-summary-migrate.ts",
  "packages/mail/src/service/conversation-participants.ts",
  "packages/mail/src/service/conversation-keeps.ts",
  "packages/mail/src/service/kept-conversations.ts",
]);

export const checkSource = (file: string, source: string, workspaceRoot: string): Finding[] => {
  const path = relative(workspaceRoot, file).replaceAll("\\", "/");
  if (isTestFile(path) || path.includes(".test-fixture.")) return [];
  const cloudSource = path.startsWith("packages/cloud/src/");
  // Model replacement deliberately rewrites retained workflow versions.
  if (path === "packages/cloud/src/ai/model-delete.ts" || path.startsWith("packages/cloud/src/workflows/")) return [];
  if (!cloudSource && !retainedMailFiles.has(path)) return [];

  const engine = resolve(workspaceRoot, "packages/cloud/src/workflows");
  const workflowImport = (specifier: string): boolean => {
    const mailRoot = resolve(workspaceRoot, "packages/mail/src");
    const localMailTarget = specifier.startsWith("@/")
      ? resolve(mailRoot, specifier.slice(2))
      : specifier.startsWith(".")
        ? resolve(dirname(file), specifier)
        : isAbsolute(specifier)
          ? specifier
          : resolve(workspaceRoot, specifier);
    if (retainedMailFiles.has(path)) {
      // Startup preserves the rule fencing schema and upgrades stored target policies before old effects drain.
      if (
        path === "packages/mail/src/migrate.ts" &&
        ["service/workflow-effect-order-schema", "service/incoming-automation-targets-migrate"].some(
          (migration) => localMailTarget === resolve(mailRoot, migration),
        )
      )
        return false;
      const local = relative(mailRoot, localMailTarget).replaceAll("\\", "/");
      if (
        local === "workflows" ||
        local.startsWith("workflows/") ||
        /^service\/workflows(?:\.ts)?$/u.test(local) ||
        (path.startsWith("packages/mail/src/service/") && /^service(?:\/index(?:\.ts)?)?$/u.test(local)) ||
        /^service\/(workflow-|incoming-automation|automation-|automatic-reply|auto-reply)/u.test(local)
      )
        return true;
      if (
        /^service\/command-legacy-effects(?:\.ts)?$/u.test(local) &&
        !["packages/mail/src/service/commands.ts", "packages/mail/src/service/command-runtime.ts"].includes(path)
      )
        return true;
    }
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
          message: "Retained services use AI tasks and Mail-owned helpers; rule adapters belong behind command-legacy-effects until drain.",
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return findings;
};

export const rule: Rule = {
  name: "workflow-boundaries",
  description: "shared platform and retained Mail services do not directly import the workflow engine",
  run: async ({ workspaceRoot }) =>
    ["packages/cloud/src", "packages/mail/src"].flatMap((directory) =>
      listFiles(join(workspaceRoot, directory), sourceFilePattern).flatMap((file) =>
        checkSource(file, readFileSync(file, "utf8"), workspaceRoot),
      ),
    ),
};
