import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

export type HostBreakpointFinding = { file: string; line: number; key: string; message: string };
const BASELINE = "scripts/checks/host-breakpoints.baseline";
// The Cloud shell and panel select their window modes before an app host exists.
const WINDOW_FILES = new Set([
  "packages/cloud/src/ssr/CloudShell.island.tsx",
  "packages/cloud/src/styles/global.css",
  "packages/cloud/src/styles/panel.css",
  "packages/cloud/src/browser/panel-slot.ts",
  "packages/cloud/src/browser/spotlight-position.ts",
]);
const width = /\b(?:min|max)-width\s*:\s*(?:64rem|63\.99\d*rem|80rem|79\.99\d*rem|1024px|1023px|1280px|1279px)\b/i;
const inScope = (file: string) =>
  /^packages\/[^/]+\/src\//.test(file) &&
  /\.(?:css|ts|tsx)$/.test(file) &&
  !isTestFile(file) &&
  !/\.(?:test|spec)\.css$/.test(file) &&
  !/\.(?:browser-(?:harness|fixture))\./.test(file) &&
  !/(?:^|\/)(?:dist|__tests__|test|tests)\//.test(file);

/** Separators inside arbitrary variants are part of their selector, not another variant. */
const isViewportDisplay = (token: string): boolean => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    if (token[index] === "[") depth++;
    else if (token[index] === "]") depth--;
    else if (token[index] === ":" && depth === 0) {
      parts.push(token.slice(start, index));
      start = index + 1;
    }
  }
  const utility = token.slice(start).replace(/^!|!$/g, "");
  return (
    parts.some((part) => /^(?:lg|xl|max-lg|max-xl)$/.test(part)) &&
    /^(?:hidden|block|inline-block|flex|inline-flex|grid|inline-grid|contents)$/.test(utility)
  );
};

export const checkHostBreakpointSource = (file: string, source: string): HostBreakpointFinding[] => {
  if (!inScope(file) || WINDOW_FILES.has(file)) return [];
  const findings: HostBreakpointFinding[] = [];
  const add = (position: number, kind: string, detail: string) => {
    const normalized = detail.replace(/\s+/g, " ").trim();
    findings.push({
      file,
      line: source.slice(0, position).split("\n").length,
      key: `${file} | ${kind} | ${normalized}`,
      message: `${normalized} follows the viewport; workspace chrome uses the k2b-app-area host.`,
    });
  };
  if (file.endsWith(".css")) {
    const css = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
    for (const match of css.matchAll(/@media\b([^{}]+)\{/g)) {
      if (width.test(match[1]!)) add(match.index, "media", `@media ${match[1]!.trim()}`);
    }
    return findings;
  }
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "matchMedia") ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "matchMedia"))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument) && width.test(argument.text)) {
        add(argument.getStart(parsed), "query", argument.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /_QUERY$/.test(node.name.text) &&
      node.initializer &&
      ts.isStringLiteralLike(node.initializer) &&
      width.test(node.initializer.text)
    ) {
      add(node.initializer.getStart(parsed), "query", node.initializer.text);
    }
    // Literal class fragments also live in constants, templates and class-list keys.
    if (
      file.endsWith(".tsx") &&
      (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
    ) {
      for (const token of node.text.split(/\s+/)) {
        if (isViewportDisplay(token)) add(node.getStart(parsed), "display", token);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return findings;
};

export const collectHostBreakpointFindings = (workspaceRoot: string): HostBreakpointFinding[] =>
  listFiles(join(workspaceRoot, "packages"), /\.(?:css|ts|tsx)$/)
    .sort()
    .flatMap((path) => {
      const file = relative(workspaceRoot, path);
      return inScope(file) ? checkHostBreakpointSource(file, readFileSync(path, "utf8")) : [];
    });

const HEADER = [
  "# Known viewport findings: content layout (migration tracked in #1454) and app rules that follow the Cloud shell's window modes.",
  "# One occurrence per line: <file> | <media|query|display> | <detail>.",
  "# The rule never adds lines; `bun scripts/check.ts host-breakpoints --fix` removes resolved findings.",
];
export const formatBaseline = (keys: readonly string[]): string => `${[...HEADER, ...[...keys].sort()].join("\n")}\n`;

export const rule: Rule = {
  name: "host-breakpoints",
  description: "Workspace chrome follows the k2b-app-area host, not viewport breakpoints",
  run: async ({ workspaceRoot, fix, flags }) => {
    const baselinePath = join(workspaceRoot, BASELINE);
    const lines = existsSync(baselinePath) ? readFileSync(baselinePath, "utf8").split("\n") : [];
    const remaining = new Map<string, number>();
    for (const line of lines.map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))) {
      remaining.set(line, (remaining.get(line) ?? 0) + 1);
    }
    const known: HostBreakpointFinding[] = [];
    const failures: Finding[] = [];
    for (const finding of collectHostBreakpointFindings(workspaceRoot)) {
      const count = remaining.get(finding.key) ?? 0;
      if (count > 0) {
        remaining.set(finding.key, count - 1);
        known.push(finding);
      } else failures.push({ file: join(workspaceRoot, finding.file), line: finding.line, message: finding.message });
    }
    const stale = [...remaining].flatMap(([key, count]) => Array<string>(count).fill(key));
    if (stale.length > 0 && fix) writeFileSync(baselinePath, formatBaseline(known.map((finding) => finding.key)));
    else
      for (const key of stale) {
        failures.push({
          file: baselinePath,
          message: `Fixed: remove “${key}” from the baseline (bun scripts/check.ts host-breakpoints --fix).`,
        });
      }
    if (known.length > 0) {
      console.warn(`warn  host-breakpoints: ${known.length} known finding(s) in ${BASELINE}; list them with --warnings`);
      if (flags.has("--warnings")) for (const finding of known) console.warn(`  - ${finding.file}:${finding.line} ${finding.message}`);
    }
    return failures;
  },
};
