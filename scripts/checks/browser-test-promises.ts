import { readFileSync } from "node:fs";
import { playwrightImport } from "./browser-launch";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

export const rule: Rule = {
  name: "browser-test-promises",
  description: "Playwright tests await promises directly instead of using Bun's nested event loop matchers",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const file of listFiles(workspaceRoot, sourceFilePattern).sort()) {
      if (!isTestFile(file) && !file.endsWith(".browser-suite.ts")) continue;
      const source = readFileSync(file, "utf8");
      if (!playwrightImport.test(source)) continue;
      // Blank comments and literals without changing positions or line numbers.
      const code = source.replace(
        /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
        (token) => token.replace(/[^\r\n]/g, " "),
      );
      for (const match of code.matchAll(/\.\s*(?:resolves|rejects)(?![\w$])/g)) {
        findings.push({
          file,
          line: code.slice(0, match.index).split("\n").length,
          message:
            "await the promise and assert on its value instead of expect(...).resolves/.rejects: Bun's matcher runs a nested event loop that reorders Playwright's channel messages and can close the browser connection (#1502); see docs-site/docs/en/contributing/testing.md",
        });
      }
    }
    return findings;
  },
};
