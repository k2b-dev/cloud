import { readFileSync } from "node:fs";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const unwrap = (node: ts.Expression): ts.Expression => {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
    node = node.expression;
  return node;
};

const statementOf = (node: ts.Node): ts.Node => {
  while (node.parent && !ts.isStatement(node)) node = node.parent;
  return node;
};

/** Resolve only straight-line, unused aliases declared in the same statement.
 * An intervening use might already await or execute the query; leave it alone.
 * No inference across statements or unknown helper functions.
 */
const isLazyQuery = (expression: ts.Expression, assertionStart = expression.getStart(), aliases = new Set<ts.Identifier>()): boolean => {
  const node = unwrap(expression);
  if (ts.isTaggedTemplateExpression(node)) {
    const tag = unwrap(node.tag);
    return ts.isIdentifier(tag) && (tag.text === "sql" || tag.text === "tx");
  }
  if (ts.isBinaryExpression(node)) {
    return (
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.CommaToken) &&
      isLazyQuery(node.right, assertionStart, aliases)
    );
  }
  if (!ts.isIdentifier(node)) return false;
  aliases.add(node);
  const statement = statementOf(node);
  let declaration: ts.VariableDeclaration | undefined;
  let used = false;
  const visit = (child: ts.Node): void => {
    if (child.getStart() >= assertionStart) return;
    if (
      ts.isVariableDeclaration(child) &&
      ts.isIdentifier(child.name) &&
      child.name.text === node.text &&
      child.end < node.getStart() &&
      statementOf(child) === statement
    ) {
      declaration = child;
      used = false;
    } else if (declaration && child.pos >= declaration.end && ts.isIdentifier(child) && child.text === node.text && !aliases.has(child))
      used = true;
    ts.forEachChild(child, visit);
  };
  visit(statement);
  return !!declaration?.initializer && !used && isLazyQuery(declaration.initializer, assertionStart, aliases);
};

export const checkSource = (file: string, source: string): Finding[] => {
  if (!/\b(?:rejects|resolves)\b/.test(source)) return [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && (node.name.text === "rejects" || node.name.text === "resolves")) {
      let assertion = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(assertion) && assertion.name.text === "not") assertion = unwrap(assertion.expression);
      if (
        ts.isCallExpression(assertion) &&
        ts.isIdentifier(assertion.expression) &&
        assertion.expression.text === "expect" &&
        assertion.arguments[0] &&
        isLazyQuery(assertion.arguments[0])
      ) {
        findings.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.name.getStart(sourceFile)).line + 1,
          message:
            "Bun SQL tagged queries are lazy: call .execute() before passing sql`...` or tx`...` to expect(...).rejects/.resolves, or await the query inside an async expectation function. The matcher alone does not start the query.",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

export const rule: Rule = {
  name: "lazy-sql-assertions",
  description: "SQL promise assertions start lazy tagged queries before checking their result",
  run: async ({ workspaceRoot }) =>
    listFiles(workspaceRoot, sourceFilePattern)
      .filter(isTestFile)
      .sort()
      .flatMap((file) => checkSource(file, readFileSync(file, "utf8"))),
};
