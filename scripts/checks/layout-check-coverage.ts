import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { workspacePackages } from "../workspace";
import { compareBaseline, type KeyedFinding } from "./baseline";
import { listFiles } from "./files";
import type { Rule } from "./rule";

/**
 * Cloud flach, testing: a browser test that calls `layoutProblems` runs at least once with classic, visible scrollbars
 * and covers 1100 px, where a docked detail column leaves the least room. Hidden scrollbars and a missing 1100 px let a
 * detail column that scrolls sideways and a head that wraps pass (flat-design QA, 21 November 2026).
 *
 * Classic scrollbars: the file uses `launchWithScrollbars` (`packages/ui/test/browser.ts`), `classicScrollbars`
 * (`@k2b/ui/layout-check`), or `--hide-scrollbars`, and checks `scrollbarWidth` (touch emulation draws overlay
 * scrollbars that take no room). 1100 px: the file uses `layoutWidths` or the number 1100.
 * Known findings live in `layout-check-coverage.baseline`; files remove their lines as they move, the rule never adds.
 */
const RULE = "layout-check-coverage";
const HEADER = [
  "Browser tests that call layoutProblems without classic scrollbars or without 1100 px, one per gap:",
  "<file> | <scrollbars|1100>. Lanes remove lines as they move a test to launchWithScrollbars and layoutWidths.",
  "`bun scripts/check.ts layout-check-coverage --fix` removes lines whose finding is gone.",
];
const page = "see /en/ui/surfaces/flat-criteria (Test a page)";

export const collectCoverageFindings = (workspaceRoot: string): KeyedFinding[] =>
  workspacePackages(workspaceRoot)
    .flatMap((pkg) => [
      ...listFiles(join(workspaceRoot, pkg, "src"), /\.browser\.test\.tsx?$/),
      ...listFiles(join(workspaceRoot, pkg, "test"), /\.browser\.test\.tsx?$/),
    ])
    .sort()
    .flatMap((file) => {
      const source = readFileSync(file, "utf8");
      if (!/\blayoutProblems\b/.test(source)) return [];
      const path = relative(workspaceRoot, file);
      const findings: KeyedFinding[] = [];
      // Classic scrollbars, and a probe that they take room: with touch emulation Chromium draws overlay scrollbars
      // that take none, so a "classic" run would measure nothing.
      if (!/\blaunchWithScrollbars\b|\bclassicScrollbars\b|--hide-scrollbars/.test(source) || !/\bscrollbarWidth\b/.test(source))
        findings.push({
          file,
          key: `${path} | scrollbars`,
          message: `calls layoutProblems without classic scrollbars that take room: launch with launchWithScrollbars() or classicScrollbars in a desktop window without touch, and assert page.evaluate(scrollbarWidth) above 0; ${page}`,
        });
      if (!/\blayoutWidths\b|(?<![\d.])1100(?![\d.])/.test(source))
        findings.push({
          file,
          key: `${path} | 1100`,
          message: `calls layoutProblems without 1100 px, where the detail column is open: check every width of layoutWidths; ${page}`,
        });
      return findings;
    });

export const rule: Rule = {
  name: RULE,
  description: "Browser tests that call layoutProblems run with classic scrollbars and cover 1100 px; known gaps in a baseline",
  run: async ({ workspaceRoot, fix }) => compareBaseline(workspaceRoot, RULE, HEADER, collectCoverageFindings(workspaceRoot), fix),
};
