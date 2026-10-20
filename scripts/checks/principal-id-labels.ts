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
  const findings: Finding[] = [];
  const visit = (node: ts.Node) => {
    const fallback =
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind) &&
      isId(node.right) &&
      !isBooleanCondition(node);
    const text =
      ts.isJsxExpression(node) &&
      node.expression &&
      isId(node.expression) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent));
    if (fallback || text) {
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
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return findings;
};

export const rule: Rule = {
  name: "principal-id-labels",
  description: "Principal IDs never replace human names",
  run: async ({ workspaceRoot }) =>
    listFiles(join(workspaceRoot, "packages"), /\.(?:tsx|ts)$/)
      .filter((file) => file.endsWith(".tsx") || /\/cli(?:\/|(?:-[^/]*)?\.ts$)/.test(file))
      .sort()
      .flatMap((file) => checkSource(file, readFileSync(file, "utf8"))),
};
