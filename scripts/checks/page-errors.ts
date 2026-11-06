import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const BASELINE = "scripts/checks/page-errors.baseline";
const message =
  "collect page errors with pageErrors(page) from packages/ui/test/browser.ts; an own pageerror listener fails at random in WebKit, which reports a refused load during a test's navigation as a page error; see docs-site/docs/en/contributing/testing.md";
const subscribe = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener"]);
const browserCode = /(?:\.browser-suite\.ts|\.browser-harness\.tsx)$/;
/** The test of pageErrors() itself compares it with the raw reports. */
const exempt = "packages/ui/test/browser.browser.test.ts";

/** Every own `pageerror` listener in test code, as a relative path and line. */
export const collectPageErrorFindings = (workspaceRoot: string): Finding[] =>
  [...workspacePackages(workspaceRoot), "scripts", "tests"]
    .flatMap((root) => listFiles(join(workspaceRoot, root), sourceFilePattern))
    .filter((file) => (isTestFile(file) || browserCode.test(file)) && relative(workspaceRoot, file) !== exempt)
    .sort()
    .flatMap((file) => {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const findings: Finding[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          subscribe.has(node.expression.name.text) &&
          node.arguments[0] &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          node.arguments[0].text === "pageerror"
        )
          findings.push({
            file: relative(workspaceRoot, file),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            message,
          });
        ts.forEachChild(node, visit);
      };
      visit(source);
      return findings;
    });

const BASELINE_HEADER = [
  "# Known page-errors findings, one per file: <file> | <count>.",
  "# Migrations lower counts and remove entries; the rule never raises counts or adds lines.",
  "# `bun scripts/check.ts page-errors --fix` lowers counts whose findings are gone.",
];
const formatBaseline = (counts: ReadonlyMap<string, number>): string =>
  `${[...BASELINE_HEADER, ...[...counts].map(([file, count]) => `${file} | ${count}`).sort()].join("\n")}\n`;

const readBaseline = (path: string): Map<string, number> => {
  const counts = new Map<string, number>();
  if (!existsSync(path)) return counts;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const match = /^(.+) \| ([1-9]\d*)$/.exec(line);
    if (!match) throw new Error(`Invalid page-errors baseline entry: ${line}`);
    counts.set(match[1]!, Number(match[2]));
  }
  return counts;
};

/**
 * Browser tests collect page errors with `pageErrors(page)`. It ignores exactly the refused load that
 * WebKit reports as a page error while a test's own navigation runs, and reports everything else.
 * Older suites with their own listener are listed in the baseline, which only shrinks.
 */
export const rule: Rule = {
  name: "page-errors",
  description: "Browser tests collect page errors with pageErrors(page), not with an own pageerror listener",
  run: async ({ workspaceRoot, fix }) => {
    const baselinePath = join(workspaceRoot, BASELINE);
    const baseline = readBaseline(baselinePath);
    const byFile = new Map<string, Finding[]>();
    for (const finding of collectPageErrorFindings(workspaceRoot)) {
      const entries = byFile.get(finding.file!) ?? [];
      entries.push(finding);
      byFile.set(finding.file!, entries);
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
          message: `${file} has ${actual} finding(s), below its baseline of ${count}; lower/remove the entry (bun scripts/check.ts page-errors --fix).`,
        });
      }
    }
    if (lowered) writeFileSync(baselinePath, formatBaseline(baseline));
    return failures;
  },
};
