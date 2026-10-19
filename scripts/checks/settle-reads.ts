import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { workspacePackages } from "../workspace";
import { listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const BASELINE = "scripts/checks/settle-reads.baseline";
const message =
  "Read styles or geometry only after the page settled: await settled(page) from packages/ui/test/browser.ts, wait for the test's own condition (waitForFunction, expect.poll, locator.waitFor), or add // settled: <reason> when the first frame or the unsettled moment is the subject; see docs-site/docs/en/contributing/testing.md";
const actions = new Set([
  "goto",
  "reload",
  "goBack",
  "goForward",
  "setContent",
  "click",
  "dblclick",
  "tap",
  "press",
  "hover",
  "fill",
  "type",
  "check",
  "focus",
  "dispatchEvent",
  "emulateMedia",
  "setViewportSize",
  "newPage",
]);
const settles = new Set(["settled", "waitForFunction", "waitFor", "keptThrough", "mostAtOnce"]);
const readApis = new Set(["getComputedStyle", "getBoundingClientRect", "getClientRects", "checkVisibility", "elementFromPoint"]);
const devices = new Set(["mouse", "keyboard", "touchscreen"]);

type BodyFunction =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;
const isBodyFunction = (node: ts.Node): node is BodyFunction =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isConstructorDeclaration(node);

type Summary = { leadingRead: boolean; end: "action" | "settle" | "none" };
type Event = { kind: "read" | "action" | "settle"; call: ts.CallExpression };

/** Calls run after their receiver and arguments; nested functions run in their own flow. */
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

/**
 * An evaluate callback runs in the page, so it can only use what it defines itself: a same-file
 * function counts when it is the callback, not when the callback names it.
 */
const readsInBrowser = (callback: BodyFunction | undefined): boolean => Boolean(callback?.body && mentions(callback.body, readApis));

const deviceCall = (expression: ts.Expression): boolean => {
  if (ts.isIdentifier(expression)) return devices.has(expression.text);
  if (ts.isPropertyAccessExpression(expression)) return devices.has(expression.name.text) || deviceCall(expression.expression);
  return false;
};

export const checkSettleReadsSource = (file: string, source: string): Finding[] => {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions: BodyFunction[] = [];
  const named = new Map<string, BodyFunction>();
  const collect = (node: ts.Node): void => {
    if (isBodyFunction(node) && node.body) {
      functions.push(node);
      if (ts.isFunctionDeclaration(node) && node.name) named.set(node.name.text, node);
      if (
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name)
      ) {
        named.set(node.parent.name.text, node);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const summaries = new Map<string, Summary>();
  const calls = new Map<ts.Node, ts.CallExpression[]>();
  for (const body of [sourceFile, ...functions.flatMap((fn) => (fn.body ? [fn.body] : []))]) calls.set(body, callsIn(body));

  const eventsIn = (body: ts.Node): Event[] => {
    const events: Event[] = [];
    for (const call of calls.get(body) ?? []) {
      const callee = call.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      const propertyCall = ts.isPropertyAccessExpression(callee);
      const callback = call.arguments[0];
      const summary = ts.isIdentifier(callee) ? summaries.get(callee.text) : undefined;
      if (
        summary?.leadingRead ||
        name === "boundingBox" ||
        ((name === "evaluate" || name === "evaluateAll") &&
          callback &&
          readsInBrowser(isBodyFunction(callback) ? callback : ts.isIdentifier(callback) ? named.get(callback.text) : undefined))
      )
        events.push({ kind: "read", call });
      if (
        (name && settles.has(name) && (propertyCall || name !== "waitFor")) ||
        (propertyCall && name === "poll" && ts.isIdentifier(callee.expression) && callee.expression.text === "expect")
      ) {
        events.push({ kind: "settle", call });
      } else if ((propertyCall && name && actions.has(name)) || deviceCall(callee)) {
        events.push({ kind: "action", call });
      } else if (summary && summary.end !== "none") {
        events.push({ kind: summary.end, call });
      }
    }
    return events;
  };

  for (let round = 0; round <= named.size; round++) {
    let changed = false;
    const next = new Map<string, Summary>();
    for (const [name, fn] of named) {
      const summary: Summary = { leadingRead: false, end: "none" };
      if (fn.body)
        for (const event of eventsIn(fn.body)) {
          if (event.kind === "read") {
            if (summary.end === "none") summary.leadingRead = true;
          } else summary.end = event.kind;
        }
      if (fn.type && mentions(fn.type, new Set(["Page"])) && summary.end !== "settle") summary.end = "action";
      const previous = summaries.get(name);
      if (!previous || previous.leadingRead !== summary.leadingRead || previous.end !== summary.end) changed = true;
      next.set(name, summary);
    }
    for (const [name, summary] of next) summaries.set(name, summary);
    if (!changed) break;
  }

  // AST comment ranges keep markers in strings and template text out of the opt-outs.
  const optOuts = new Map<number, boolean>();
  const collectComments = (node: ts.Node): void => {
    const comments = [
      ...(ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(source, node.end) ?? []),
    ];
    for (const comment of comments) {
      if (comment.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
      const match = /^\/\/[ \t]*settled:(.*)$/.exec(source.slice(comment.pos, comment.end));
      if (!match) continue;
      const line = sourceFile.getLineAndCharacterOfPosition(comment.pos).line + 1;
      optOuts.set(line, Boolean(match[1]?.trim()));
    }
    ts.forEachChild(node, collectComments);
  };
  collectComments(sourceFile);
  const findings: Finding[] = [];
  for (const body of calls.keys()) {
    let dirty = false;
    for (const { kind, call } of eventsIn(body)) {
      if (kind === "action") dirty = true;
      if (kind === "settle") dirty = false;
      if (kind !== "read" || !dirty) continue;
      const line = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1;
      if (optOuts.get(line) || optOuts.get(line - 1)) continue;
      const emptyReason = optOuts.has(line) || optOuts.has(line - 1);
      findings.push({ file, line, message: emptyReason ? `${message}; the // settled: reason must be non-empty.` : message });
    }
  }
  return findings.sort((a, b) => a.line! - b.line!);
};

export const collectSettleReadsFindings = (workspaceRoot: string): Finding[] =>
  [...workspacePackages(workspaceRoot), "scripts", "tests"]
    .flatMap((root) => listFiles(join(workspaceRoot, root), sourceFilePattern))
    .filter((file) => /(?:\.browser\.test\.ts|\.browser-suite\.ts|\.browser-harness\.tsx)$/.test(file))
    .sort()
    .flatMap((file) => checkSettleReadsSource(relative(workspaceRoot, file), readFileSync(file, "utf8")));

const BASELINE_HEADER = [
  "# Known settle-reads findings, one per file: <file> | <count>.",
  "# Migrations lower counts and remove entries; the rule never raises counts or adds lines.",
  "# `bun scripts/check.ts settle-reads --fix` lowers counts whose findings are gone.",
];
export const formatBaseline = (counts: ReadonlyMap<string, number>): string =>
  `${[...BASELINE_HEADER, ...[...counts].map(([file, count]) => `${file} | ${count}`).sort()].join("\n")}\n`;

const readBaseline = (path: string): Map<string, number> => {
  const counts = new Map<string, number>();
  if (!existsSync(path)) return counts;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const match = /^(.+) \| ([1-9]\d*)$/.exec(line);
    if (!match) throw new Error(`Invalid settle-reads baseline entry: ${line}`);
    counts.set(match[1]!, Number(match[2]));
  }
  return counts;
};

export const rule: Rule = {
  name: "settle-reads",
  description: "Browser tests read styles and geometry only after the page settled",
  run: async ({ workspaceRoot, fix }) => {
    const baselinePath = join(workspaceRoot, BASELINE);
    const baseline = readBaseline(baselinePath);
    const byFile = new Map<string, Finding[]>();
    for (const finding of collectSettleReadsFindings(workspaceRoot)) {
      const file = finding.file!;
      const entries = byFile.get(file) ?? [];
      entries.push(finding);
      byFile.set(file, entries);
    }
    const failures: Finding[] = [];
    for (const [file, findings] of byFile) {
      if (findings.length > (baseline.get(file) ?? 0))
        failures.push(...findings.map((finding) => ({ ...finding, file: join(workspaceRoot, file) })));
    }
    let lowered = false;
    for (const [file, count] of baseline) {
      const actual = byFile.get(file)?.length ?? 0;
      if (actual >= count) continue;
      if (fix) {
        if (actual === 0) baseline.delete(file);
        else baseline.set(file, actual);
        lowered = true;
      } else {
        failures.push({
          file: baselinePath,
          message: `${file} has ${actual} finding(s), below its baseline of ${count}; lower/remove the entry (bun scripts/check.ts settle-reads --fix).`,
        });
      }
    }
    if (lowered) writeFileSync(baselinePath, formatBaseline(baseline));
    return failures;
  },
};
