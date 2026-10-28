import { readFileSync } from "node:fs";
import { relative } from "node:path";
import ts from "@typescript/typescript6";
import { playwrightImport } from "./browser-launch";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

// These two probes assert the raw WebKit diagnostic actually occurred, alongside pageErrors().
// Match the specific listener once, rather than exempting either test file from the rule.
const diagnosticProbes = new Map([
  ["packages/ui/test/browser.browser.test.ts", 'page.on("pageerror", (error) => reported.push(`${error.name}:/${error.message}`))'],
  [
    "packages/assistant/src/frontend/AssistantWaitingStrip.browser.test.ts",
    'page.on("pageerror", (error) => { if (error.message.endsWith(" due to access control checks.")) refused.push(error.message); })',
  ],
]);
const compact = (source: string) => source.replace(/\s+/g, "");
const testSupportFile = /[.-](?:fixture|harness|suite)\.tsx?$/;
const listenerMethods = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener"]);

export const rule: Rule = {
  name: "browser-page-errors",
  description: "Browser tests collect page errors through pageErrors(), preserving WebKit navigation handling",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const file of listFiles(workspaceRoot, sourceFilePattern).sort()) {
      const support = testSupportFile.test(file);
      if (!isTestFile(file) && !support) continue;
      const source = readFileSync(file, "utf8");
      if (!support && !/\.browser\.(?:test|spec)\.tsx?$/.test(file) && !playwrightImport.test(source)) continue;
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let probe = diagnosticProbes.get(relative(workspaceRoot, file));
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const target = node.expression;
          const method = ts.isPropertyAccessExpression(target)
            ? target.name.text
            : ts.isElementAccessExpression(target) && target.argumentExpression && ts.isStringLiteralLike(target.argumentExpression)
              ? target.argumentExpression.text
              : undefined;
          const event = node.arguments[0];
          if (
            method &&
            listenerMethods.has(method) &&
            event &&
            ts.isStringLiteralLike(event) &&
            (event.text === "pageerror" || event.text === "weberror")
          ) {
            if (probe && compact(node.getText(tree)) === compact(probe)) probe = undefined;
            else
              findings.push({
                file,
                line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
                message:
                  "collect page errors with pageErrors(page) from packages/ui/test/browser instead of a hand-rolled pageerror/weberror listener; retain specific console assertions separately; see docs-site/docs/en/contributing/testing.md",
              });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    return findings;
  },
};
