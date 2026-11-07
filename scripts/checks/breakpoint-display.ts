import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const display =
  /^(?:block|inline-block|inline|flex|inline-flex|grid|inline-grid|contents|hidden|table|inline-table|table-[a-z-]+|flow-root|list-item)$/;
// Media and container variants add no specificity, so which display wins depends only on stylesheet order.
const breakpoint = /^(?:(?:max-)?(?:sm|md|lg|xl|2xl)|min-\[[^\]]+\]|max-\[[^\]]+\]|@[\w-]*(?:\/[\w-]+)?)$/;

/** The display utility a breakpoint-scoped class sets, if every variant of the class is a breakpoint. */
const scopedDisplay = (token: string): string | undefined => {
  const parts = token.split(":");
  const utility = parts.pop()!;
  return parts.length > 0 && parts.every((part) => breakpoint.test(part)) && display.test(utility) ? utility : undefined;
};

/**
 * Shared UI (`@k2b/cloud`, `@k2b/ui`) renders next to an app's own Tailwind sheet, which repeats common utilities
 * such as `contents` or `hidden` in the same layer. Pages link the app sheet before `global.css`, but browser fixtures
 * and other hosts often append it after; then the app's `hidden` cancels a shared `md:flex`. A shared class list
 * therefore sets a responsive display only through breakpoint-scoped classes, such as `max-md:hidden md:flex`, and
 * looks the same in either order.
 */
export const rule: Rule = {
  name: "breakpoint-display",
  description: "shared UI sets a responsive display only with breakpoint-scoped classes",
  run: async ({ workspaceRoot }) => {
    const roots = [join(workspaceRoot, "packages/cloud/src"), join(workspaceRoot, "packages/ui/src")];
    const findings: Finding[] = [];

    for (const file of roots.flatMap((root) => listFiles(root, sourceFilePattern)).sort()) {
      if (isTestFile(file)) continue;
      const source = readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );

      const visit = (node: ts.Node): void => {
        // A template's static parts form one class list; its substitutions are visited on their own.
        const text = ts.isStringLiteralLike(node)
          ? node.text
          : ts.isTemplateExpression(node)
            ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ")
            : undefined;
        if (text !== undefined) {
          const tokens = text.split(/\s+/).map((token) => token.replace(/^!|!$/g, ""));
          const plain = tokens.find((token) => display.test(token));
          const scoped = tokens.find((token) => scopedDisplay(token));
          if (plain && scoped) {
            findings.push({
              file,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
              message: `"${plain}" with "${scoped}": an app stylesheet loaded later that repeats "${plain}" overrides the breakpoint; scope both, as in "max-md:hidden md:flex".`,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return findings;
  },
};
