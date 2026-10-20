import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const testSources = /\.(?:test|spec)\.tsx?$|[.-](?:test-)?fixtures?\.tsx?$|^test-.*\.tsx?$/;
const message =
  "Fixture short IDs come from testShortId() in scripts/fixtures/test-short-id; a random value cut to short-ID length repeats and fails the unique index at random (#1594).";
const shortIdName = /short_?id/i;

const numericLiteral = (node: ts.Expression | undefined): number | undefined => {
  if (!node) return undefined;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand) && node.operator === ts.SyntaxKind.MinusToken)
    return -Number(node.operand.text);
  return undefined;
};

const isShortCut = (call: ts.CallExpression, method: string): boolean => {
  const [start, end] = call.arguments.map(numericLiteral);
  if (start === undefined) return false;
  if (method === "substr") return end !== undefined && end <= 10;
  if (method === "substring") return end !== undefined && Math.abs(Math.max(0, end) - Math.max(0, start)) <= 10;
  if (method !== "slice") return false;
  if (end === undefined) return call.arguments.length === 1 && start < 0 && start >= -10;
  // Same-sign bounds have a known maximum width without knowing the input length.
  if (start >= 0 === end >= 0) return Math.max(0, end - start) <= 10;
  return start < 0 && Math.min(-start, end) <= 10;
};

const hasRandomCall = (node: ts.Node): boolean => {
  if (ts.isCallExpression(node)) {
    const target = node.expression;
    const name = ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : "";
    if (/^(?:randomUUID|randomUUIDv7|getRandomValues|testUuid|uuid)$/.test(name)) return true;
    if (
      name === "random" &&
      ts.isPropertyAccessExpression(target) &&
      ts.isIdentifier(target.expression) &&
      target.expression.text === "Math"
    )
      return true;
  }
  return ts.forEachChild(node, hasRandomCall) ?? false;
};

const isFixtureValue = (node: ts.Node): boolean => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isTaggedTemplateExpression(parent)) return true;
    if (
      (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isParameter(parent)) &&
      parent.initializer &&
      node.pos >= parent.initializer.pos &&
      node.end <= parent.initializer.end &&
      (ts.isIdentifier(parent.name) || ts.isStringLiteralLike(parent.name)) &&
      shortIdName.test(parent.name.text)
    )
      return true;
  }
  return false;
};

/** Reports short random expressions in SQL values or declarations named shortId/short_id. */
export const checkTestShortIdsSource = (file: string, source: string): Finding[] => {
  if (!/\b(?:randomUUID|randomUUIDv7|getRandomValues|testUuid|uuid|random|gen_random_uuid)\b/.test(source)) return [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const report = (position: number) => findings.push({ file, line: sourceFile.getLineAndCharacterOfPosition(position).line + 1, message });
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (
        (isShortCut(node, method) || (method === "toString" && numericLiteral(node.arguments[0]) === 36)) &&
        hasRandomCall(node.expression.expression) &&
        isFixtureValue(node)
      ) {
        report(node.getStart(sourceFile));
        return; // A random base36 conversion followed by slice is one finding.
      }
    }
    // Cheap coverage for literal SQL cuts; leave interpolated SQL and arbitrary SQL parsing alone.
    if (ts.isTaggedTemplateExpression(node)) {
      const parts = ts.isNoSubstitutionTemplateLiteral(node.template)
        ? [node.template]
        : [node.template.head, ...node.template.templateSpans.map((span) => span.literal)];
      for (const part of parts) {
        const sql = part.getText(sourceFile);
        for (const match of sql.matchAll(
          /\b(?:substr(?:ing)?|left)\s*\(\s*(?:md5\s*\(\s*)?(?:random|gen_random_uuid)\s*\(\s*\)[^,]*,\s*(?:\d+\s*,\s*)?(?:10|[1-9])\s*\)/gi,
        ))
          report(part.getStart(sourceFile) + match.index);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

export const collectTestShortIdsFindings = (workspaceRoot: string): Finding[] =>
  listFiles(join(workspaceRoot, "packages"), testSources)
    .sort()
    .flatMap((file) => checkTestShortIdsSource(relative(workspaceRoot, file), readFileSync(file, "utf8")));

export const rule: Rule = {
  name: "test-short-ids",
  description: "Raw test fixtures use deterministic short IDs instead of truncated random values",
  run: async ({ workspaceRoot }) => collectTestShortIdsFindings(workspaceRoot),
};
