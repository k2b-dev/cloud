import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { workspacePackages } from "../workspace";
import { listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const message =
  "hover with hoverInPlace(target, position) from packages/ui/test/browser.ts where a test reads geometry before and after the hover: Locator.hover() retries a failed actionability check with its own scrollIntoView, so one retry moves the page and every box read after it (#3013); add // hover: <reason> when the reads do not depend on the scroll position; see docs-site/docs/en/contributing/testing.md";
const readApis = new Set(["getBoundingClientRect", "getClientRects", "elementFromPoint", "elementsFromPoint"]);

type BodyFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
const isBodyFunction = (node: ts.Node): node is BodyFunction =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);

/** Calls in evaluation order; nested functions run in their own flow. */
const callsIn = (body: ts.Node): ts.CallExpression[] => {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (isBodyFunction(node)) return;
    ts.forEachChild(node, visit);
    if (ts.isCallExpression(node)) calls.push(node);
  };
  visit(body);
  return calls;
};

const mentions = (node: ts.Node, names: ReadonlySet<string>): boolean =>
  (ts.isIdentifier(node) && names.has(node.text)) || (ts.forEachChild(node, (child) => mentions(child, names)) ?? false);

export const isHover = (call: ts.CallExpression): call is ts.CallExpression & { expression: ts.PropertyAccessExpression } =>
  ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "hover";

/**
 * Each `hover()` between two geometry reads of one flow, as the call in that flow: the hover itself or a helper of
 * the same file that hovers. Reads are `boundingBox()` and page callbacks that read boxes or hit-test points.
 */
export const analyzeHoverInPlace = (file: string, source: string) => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const helpers = new Map<string, BodyFunction>();
  const bodies: ts.Node[] = [sourceFile];
  const collect = (node: ts.Node): void => {
    if (isBodyFunction(node) && node.body) {
      bodies.push(node.body);
      if (ts.isFunctionDeclaration(node) && node.name) helpers.set(node.name.text, node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isBodyFunction(node.initializer))
      helpers.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  const helperOf = (expression: ts.Expression) => (ts.isIdentifier(expression) ? helpers.get(expression.text) : undefined);

  const reads = (call: ts.CallExpression): boolean => {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) return false;
    if (callee.name.text === "boundingBox") return true;
    const callback = call.arguments[0];
    if (callee.name.text !== "evaluate" && callee.name.text !== "evaluateAll") return false;
    const fn = callback && (isBodyFunction(callback) ? callback : helperOf(callback));
    return Boolean(fn?.body && mentions(fn.body, readApis));
  };

  // A helper hovers or reads when its own flow does, through other helpers too.
  const hoveringHelpers = new Set<BodyFunction>();
  const readingHelpers = new Set<BodyFunction>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const fn of helpers.values()) {
      const calls = fn.body ? callsIn(fn.body) : [];
      const helperCalls = calls.map((call) => helperOf(call.expression)).filter((helper) => helper !== undefined);
      if (!hoveringHelpers.has(fn) && (calls.some(isHover) || helperCalls.some((helper) => hoveringHelpers.has(helper)))) {
        hoveringHelpers.add(fn);
        changed = true;
      }
      if (!readingHelpers.has(fn) && (calls.some(reads) || helperCalls.some((helper) => readingHelpers.has(helper)))) {
        readingHelpers.add(fn);
        changed = true;
      }
    }
  }

  // AST comment ranges keep markers in strings and template text out of the opt-outs.
  const optOuts = new Map<number, boolean>();
  const collectComments = (node: ts.Node): void => {
    for (const comment of [
      ...(ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(source, node.end) ?? []),
    ]) {
      if (comment.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
      const match = /^\/\/[ \t]*hover:(.*)$/.exec(source.slice(comment.pos, comment.end));
      if (match) optOuts.set(sourceFile.getLineAndCharacterOfPosition(comment.pos).line + 1, Boolean(match[1]?.trim()));
    }
    ts.forEachChild(node, collectComments);
  };
  collectComments(sourceFile);
  const lineOf = (call: ts.CallExpression) => sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1;

  const flagged: { call: ts.CallExpression; line: number; emptyReason: boolean }[] = [];
  for (const body of bodies) {
    const pending: ts.CallExpression[] = [];
    let measured = false;
    for (const call of callsIn(body)) {
      const helper = helperOf(call.expression);
      const read = reads(call) || Boolean(helper && readingHelpers.has(helper));
      if (read && pending.length)
        for (const hover of pending.splice(0)) {
          const line = lineOf(hover);
          const reason = optOuts.get(line) ?? optOuts.get(line - 1);
          if (!reason) flagged.push({ call: hover, line, emptyReason: reason === false });
        }
      if (read) measured = true;
      if (measured && (isHover(call) || (helper && hoveringHelpers.has(helper)))) pending.push(call);
    }
  }
  flagged.sort((a, b) => a.line - b.line);
  return { sourceFile, flagged, helperOf, hoveringHelpers, callsIn };
};

export const checkHoverInPlaceSource = (file: string, source: string): Finding[] =>
  analyzeHoverInPlace(file, source).flagged.map(({ line, emptyReason }) => ({
    file,
    line,
    message: emptyReason ? `${message}; the // hover: reason must be non-empty.` : message,
  }));

export const rule: Rule = {
  name: "hover-in-place",
  description:
    "Browser tests that read geometry before and after a hover use hoverInPlace(), so hover()'s retry scroll cannot move the page",
  run: async ({ workspaceRoot }) =>
    [...workspacePackages(workspaceRoot), "scripts", "tests"]
      .flatMap((root) => listFiles(join(workspaceRoot, root), sourceFilePattern))
      .filter((file) => /(?:\.browser\.test\.tsx?|\.browser-suite\.tsx?|\.browser-harness\.tsx)$/.test(file))
      .sort()
      .flatMap((file) =>
        checkHoverInPlaceSource(relative(workspaceRoot, file), readFileSync(file, "utf8")).map((finding) => ({ ...finding, file })),
      ),
};
