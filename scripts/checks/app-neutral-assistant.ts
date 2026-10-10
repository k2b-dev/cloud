import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * Code that words app capabilities for people in the Assistant: the chat, the shared sentence renderer with the
 * approval text the CLI prints, Cloud's own tool sentences, and the Assistant app's web, CLI, and code approval
 * presentation.
 */
const PRESENTATION_ROOTS = [
  "packages/cloud/src/ai/chat",
  "packages/cloud/src/_internal/capability-sentences.ts",
  "packages/cloud/src/ai/tool-sentences.ts",
  "packages/assistant/src/frontend",
  "packages/assistant/src/cli",
  "packages/assistant/src/artifacts/CapabilityApproval.tsx",
  "packages/assistant/src/artifacts/code-approval-message.ts",
];

const unwrap = (node: ts.Node): ts.Node =>
  ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) ? unwrap(node.expression) : node;

const APP_IDENTITY = new Set(["appId", "appName"]);

/** One app's identity: `appId` or `appName`, as a name, a property, or `x["appId"]`. */
const isAppIdentity = (node: ts.Node): boolean => {
  const inner = unwrap(node);
  if (ts.isIdentifier(inner)) return APP_IDENTITY.has(inner.text);
  if (ts.isPropertyAccessExpression(inner)) return APP_IDENTITY.has(inner.name.text);
  return (
    ts.isElementAccessExpression(inner) &&
    ts.isStringLiteralLike(inner.argumentExpression) &&
    APP_IDENTITY.has(inner.argumentExpression.text)
  );
};

const mentionsAppIdentity = (node: ts.Node): boolean =>
  isAppIdentity(node) || (ts.forEachChild(node, (child) => mentionsAppIdentity(child) || undefined) ?? false);

/** A constant such as `MAIL_APP_ID` or `BUILT_IN_APPS`. */
const isConstant = (node: ts.Node): boolean => {
  const inner = unwrap(node);
  return ts.isIdentifier(inner) && /^[A-Z][A-Z0-9_]*$/.test(inner.text);
};

/** One fixed app: a string, a pattern, or a constant. */
const isFixedApp = (node: ts.Node): boolean => {
  const inner = unwrap(node);
  return ts.isStringLiteralLike(inner) || ts.isRegularExpressionLiteral(inner) || isConstant(inner);
};

/** A fixed set of apps: a literal list or object, a new Set or Map, or a constant. */
const isFixedApps = (node: ts.Node): boolean => {
  const inner = unwrap(node);
  return (
    ts.isArrayLiteralExpression(inner) ||
    ts.isObjectLiteralExpression(inner) ||
    (ts.isNewExpression(inner) && ts.isIdentifier(inner.expression) && ["Set", "Map"].includes(inner.expression.text)) ||
    isConstant(inner)
  );
};

/** Capability tool names encode the app: `mail__action__draft_dot_send`, or a prefix such as `mail__`. */
const isAppToolName = (node: ts.Node): boolean => {
  const inner = unwrap(node);
  return ts.isStringLiteralLike(inner) && /__(action|query)__|^[a-z0-9-]+__$/.test(inner.text);
};

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const MATCHES = new Set(["startsWith", "endsWith", "includes", "match", "test", "localeCompare"]);
const LOOKUPS = new Set(["includes", "indexOf", "has", "get"]);

/** Places where presentation code treats one app differently from another by its id, name, or tool name. */
export const appIdBranches = (fileName: string, source: string): { line: number; text: string }[] => {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { line: number; text: string }[] = [];
  const report = (node: ts.Node) =>
    found.push({ line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, text: node.getText(sourceFile) });
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      const [left, right] = [node.left, node.right];
      if ((isAppIdentity(left) && isFixedApp(right)) || (isAppIdentity(right) && isFixedApp(left))) report(node);
      else if (isAppToolName(left) || isAppToolName(right)) report(node);
    }
    if (ts.isSwitchStatement(node) && mentionsAppIdentity(node.expression)) report(node.expression);
    if (ts.isElementAccessExpression(node) && isAppIdentity(node.argumentExpression) && isFixedApps(node.expression)) report(node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      const appArgument = node.arguments.some(isAppIdentity);
      if (LOOKUPS.has(method) && appArgument && isFixedApps(receiver)) report(node);
      else if (MATCHES.has(method) && isAppIdentity(receiver) && node.arguments.some(isFixedApp)) report(node);
      else if (MATCHES.has(method) && appArgument && isFixedApp(receiver)) report(node);
      else if (MATCHES.has(method) && node.arguments.some(isAppToolName)) report(node);
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
  description: "Assistant and chat presentation code never branches on app ids, names, or tool names",
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
          message: `Branches on one app (${branch.text}). Word app capabilities through the presentation catalog instead.`,
        });
      }
    }
    return findings;
  },
};
