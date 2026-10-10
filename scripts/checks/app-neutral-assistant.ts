import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Code that words app capabilities for people in the Assistant: the chat, the shared sentence renderer, Cloud's own
 * tool sentences, and the Assistant app's web and CLI presentation.
 */
const PRESENTATION_ROOTS = [
  "packages/cloud/src/ai/chat",
  "packages/cloud/src/_internal/capability-sentences.ts",
  "packages/cloud/src/ai/tool-sentences.ts",
  "packages/assistant/src/frontend",
  "packages/assistant/src/cli",
];

/** `appId`, `x.appId`, or `x?.appId`. */
const isAppId = (node: ts.Node): boolean => {
  const inner = ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) ? node.expression : node;
  if (ts.isIdentifier(inner)) return inner.text === "appId";
  return ts.isPropertyAccessExpression(inner) && inner.name.text === "appId";
};

const mentionsAppId = (node: ts.Node): boolean =>
  isAppId(node) || (ts.forEachChild(node, (child) => mentionsAppId(child) || undefined) ?? false);

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** Places where presentation code treats one app differently from another by its id. */
export const appIdBranches = (fileName: string, source: string): { line: number; text: string }[] => {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { line: number; text: string }[] = [];
  const report = (node: ts.Node) =>
    found.push({ line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, text: node.getText(sourceFile) });
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      const [left, right] = [node.left, node.right];
      if ((isAppId(left) && ts.isStringLiteralLike(right)) || (isAppId(right) && ts.isStringLiteralLike(left))) report(node);
    }
    if (ts.isSwitchStatement(node) && mentionsAppId(node.expression)) report(node.expression);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      const literalList = ts.isArrayLiteralExpression(receiver) && receiver.elements.some(ts.isStringLiteralLike);
      if (literalList && (method === "includes" || method === "indexOf") && node.arguments.some(isAppId)) report(node);
      if (isAppId(receiver) && (method === "startsWith" || method === "endsWith") && node.arguments.some(ts.isStringLiteralLike))
        report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
};

/**
 * The Assistant presents every app through the same public contract: titles, sentences, and fields come from the app's
 * presentation catalog, never from code that knows an app. Built-in and third-party apps then read the same.
 */
export const rule: Rule = {
  name: "app-neutral-assistant",
  description: "Assistant and chat presentation code never branches on app ids",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const files = PRESENTATION_ROOTS.flatMap((root) => {
      const path = join(workspaceRoot, root);
      if (!sourceFilePattern.test(path)) return listFiles(path, sourceFilePattern);
      return existsSync(path) ? [path] : [];
    });
    for (const file of files.sort()) {
      if (isTestFile(file)) continue;
      for (const branch of appIdBranches(file, readFileSync(file, "utf8"))) {
        findings.push({
          file,
          line: branch.line,
          message: `Branches on an app id (${branch.text}). Word app capabilities through the presentation catalog instead.`,
        });
      }
    }
    return findings;
  },
};
