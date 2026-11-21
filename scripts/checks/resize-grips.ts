import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { workspacePackages } from "../workspace";
import { compareBaseline, type KeyedFinding } from "./baseline";
import { isTestFile, listFiles, parseSource } from "./files";
import type { Rule } from "./rule";

/**
 * K13 of Cloud flach, as an approximation: an edge a person can drag carries the grip, and only such an edge does.
 * In TSX, a focusable separator (`role="separator"` with `tabindex`, or on a `<button>`) is the shared grip: it carries
 * the class `k2b-resize-separator` (`ResizeSeparator`). In CSS, the column cursors `col-resize` and `row-resize` appear
 * only on that grip. Handles that resize an object (an event, a crop) use `ew-resize`/`ns-resize` and stay out of scope.
 * Known findings live in `resize-grips.baseline`; migrations remove lines, the rule never adds one.
 */
const RULE = "resize-grips";
const HEADER = [
  "Known draggable edges without the shared grip (K13), one per occurrence: <file> | <separator|cursor> | <detail>.",
  "Lanes remove lines as they move an edge onto ResizeSeparator; the rule never adds lines.",
  "`bun scripts/check.ts resize-grips --fix` removes lines whose finding is gone.",
];
const GRIP = "k2b-resize-separator";
const message = `a draggable edge is the shared grip: use ResizeSeparator (class \`${GRIP}\`); see /en/ui/surfaces/flat-criteria (K13)`;

const attribute = (element: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined =>
  element.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText().toLowerCase() === name,
  );

const literal = (attr: ts.JsxAttribute | undefined): string | undefined => {
  const value = attr?.initializer;
  if (!value) return undefined;
  if (ts.isStringLiteral(value)) return value.text;
  if (ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression)) return value.expression.text;
  return "";
};

const sourceFindings = (workspaceRoot: string, file: string, source: string): KeyedFinding[] => {
  if (!source.includes("separator")) return [];
  const { sourceFile, findings: unparsed } = parseSource(file, source);
  const path = relative(workspaceRoot, file);
  const findings: KeyedFinding[] = unparsed.map((finding) => ({ ...finding, file, key: `${path} | parse | ${finding.message}` }));
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      const focusable = tag === "button" || attribute(node, "tabindex") !== undefined;
      if (
        literal(attribute(node, "role")) === "separator" &&
        focusable &&
        !(attribute(node, "class")?.initializer?.getText() ?? "").includes(GRIP)
      ) {
        const className = literal(attribute(node, "class")) || "-";
        findings.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          key: `${path} | separator | <${tag} class="${className}">`,
          message: `focusable separator <${tag} class="${className}"> without the grip: ${message}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

const cssFindings = (workspaceRoot: string, file: string, original: string): KeyedFinding[] => {
  const source = original.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const path = relative(workspaceRoot, file);
  const findings: KeyedFinding[] = [];
  for (const match of source.matchAll(/(?<=[{;]\s*)cursor\s*:\s*(col-resize|row-resize)/g)) {
    const at = match.index ?? 0;
    const open = source.lastIndexOf("{", at);
    const selector = source
      .slice(Math.max(source.lastIndexOf("}", open), source.lastIndexOf(";", open), source.lastIndexOf("{", open - 1)) + 1, open)
      .trim()
      .replace(/\s+/g, " ");
    if (selector.split(",").every((part) => part.includes(GRIP))) continue;
    findings.push({
      file,
      line: source.slice(0, at).split("\n").length,
      key: `${path} | cursor | ${selector} ${match[1]}`,
      message: `${selector} sets cursor: ${match[1]}: ${message}`,
    });
  }
  return findings;
};

export const collectGripFindings = (workspaceRoot: string): KeyedFinding[] =>
  workspacePackages(workspaceRoot)
    .flatMap((pkg) => listFiles(join(workspaceRoot, pkg, "src"), /\.(?:tsx|css)$/))
    .filter((file) => !isTestFile(file))
    .sort()
    .flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return file.endsWith(".css") ? cssFindings(workspaceRoot, file, source) : sourceFindings(workspaceRoot, file, source);
    });

export const rule: Rule = {
  name: RULE,
  description: "A draggable edge (focusable separator, column cursor) is the shared ResizeSeparator grip; known findings in a baseline",
  run: async ({ workspaceRoot, fix }) => compareBaseline(workspaceRoot, RULE, HEADER, collectGripFindings(workspaceRoot), fix),
};
