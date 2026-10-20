import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const principalId =
  /^(?:user|group|serviceAccount|service_account|principal|subject|actor|author|owner|assignee|member|recipient)(?:Id|_id)$/;
const isId = (node: ts.Node): boolean => {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return isId(node.expression);
  return principalId.test(ts.isPropertyAccessExpression(node) ? node.name.text : ts.isIdentifier(node) ? node.text : "");
};

const isLogical = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) &&
  [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind);

const nameOf = (node: ts.Node | undefined): string => (node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : "");
const isLabelFunction = (node: ts.SignatureDeclaration): boolean => {
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)) parent = parent.parent;
  const name = ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) ? parent.name : node.name;
  return /(?:label|name|displayname|title|text)$/i.test(nameOf(name));
};
const enclosingFunction = (node: ts.Node): ts.SignatureDeclaration | undefined => {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  return current;
};
const cliFile = /\/cli(?:\/|(?:-[^/]*)?\.ts$)/;

const isBooleanCondition = (node: ts.Node): boolean => {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (isLogical(parent)) {
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.left === current) return true;
    } else if (!ts.isParenthesizedExpression(parent) && !ts.isNonNullExpression(parent)) {
      return (
        ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && parent.expression === current) ||
        ((ts.isForStatement(parent) || ts.isConditionalExpression(parent)) && parent.condition === current) ||
        (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) ||
        (ts.isCallExpression(parent) &&
          ts.isIdentifier(parent.expression) &&
          parent.expression.text === "Boolean" &&
          parent.arguments.some((argument) => argument === current))
      );
    }
    current = parent;
  }
  return false;
};

export const checkSource = (file: string, source: string): Finding[] => {
  if (isTestFile(file)) return [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const ids = new Set<ts.Node>();
  // Follow only value-producing text branches, never conditions, calls or structured data.
  const inspectText = (node: ts.Node): void => {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) inspectText(node.expression);
    else if (isId(node)) ids.add(node);
    else if (isLogical(node) && node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) inspectText(node.right);
    else if (ts.isConditionalExpression(node)) {
      inspectText(node.whenTrue);
      inspectText(node.whenFalse);
    } else if (ts.isTemplateExpression(node)) node.templateSpans.forEach((span) => inspectText(span.expression));
  };
  const visit = (node: ts.Node) => {
    if (isLogical(node) && node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken && !isBooleanCondition(node))
      inspectText(node.right);
    if (ts.isJsxExpression(node) && node.expression) {
      const parent = node.parent;
      if (
        ts.isJsxElement(parent) ||
        ts.isJsxFragment(parent) ||
        (ts.isJsxAttribute(parent) && /^(?:label|title|aria-label|aria-description|alt|placeholder)$/.test(parent.name.getText(ast)))
      )
        inspectText(node.expression);
    }
    if (ts.isPropertyAssignment(node) && /^(?:label|title|displayName|description)$/.test(nameOf(node.name))) inspectText(node.initializer);
    if (ts.isReturnStatement(node) && node.expression) {
      const fn = enclosingFunction(node);
      if (fn && isLabelFunction(fn)) inspectText(node.expression);
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body) && isLabelFunction(node)) inspectText(node.body);
    if (
      cliFile.test(file) &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(ast) === "ctx" &&
      /^(?:print|error)$/.test(node.expression.name.text)
    )
      node.arguments.forEach(inspectText);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const findings: Finding[] = [];
  for (const node of ids) {
    // Exempt only the nearest local boundary; a function's comment cannot exempt its body.
    let current: ts.Node | undefined = node;
    let allowed = false;
    while (current && !ts.isSourceFile(current)) {
      if (ts.isFunctionLike(current)) break;
      const leading = source.slice(
        current.getFullStart(),
        ts.isJsxExpression(current) && current.expression ? current.expression.getStart(ast) : current.getStart(ast),
      );
      if (/\/\/ principal-id-labels: \S[^\n]*/.test(leading)) allowed = true;
      if (ts.isStatement(current) || ts.isJsxExpression(current) || ts.isJsxAttribute(current) || ts.isPropertyAssignment(current)) break;
      current = current.parent;
    }
    if (!allowed)
      findings.push({
        file,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        message:
          "A principal ID must not be a human label. Use principalLabel; document deliberate IDs with // principal-id-labels: <reason>.",
      });
  }
  return findings;
};

export const rule: Rule = {
  name: "principal-id-labels",
  description: "Principal IDs never replace human names",
  run: async ({ workspaceRoot }) =>
    listFiles(join(workspaceRoot, "packages"), /\.(?:tsx|ts)$/)
      .filter((file) => file.endsWith(".tsx") || cliFile.test(file))
      .sort()
      .flatMap((file) => checkSource(file, readFileSync(file, "utf8"))),
};
