import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const directLaunch = /\b(?:chromium|firefox|webkit)\.(?:launch|connect)\(/g;
/** Assistant's artifact suites run nightly in Google Chrome, a Chromium channel, and never in the gate. */
const exempt = /^packages\/assistant\/src\/artifacts\//;

/**
 * A test starts its browser with `launchBrowser()` from
 * `packages/ui/test/browser.ts`, so `TEST_BROWSER` chooses the engine and the
 * gate's WebKit job (`bun run test --browser`) finds it. Test code is every
 * test file plus the browser suites that a test file runs in a child process.
 */
export const rule: Rule = {
  name: "browser-launch",
  description: "Playwright tests start their browser through packages/ui/test/browser, so they also run in WebKit",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const roots = workspacePackages(workspaceRoot).map((path) => join(workspaceRoot, path));
    for (const file of roots.flatMap((root) => listFiles(root, sourceFilePattern)).sort()) {
      if (!(isTestFile(file) || file.endsWith(".browser-suite.ts")) || exempt.test(relative(workspaceRoot, file))) continue;
      const source = readFileSync(file, "utf8");
      for (const call of source.matchAll(directLaunch)) {
        findings.push({
          file,
          line: source.slice(0, call.index).split("\n").length,
          message: "start the browser with launchBrowser() from packages/ui/test/browser; see docs-site/docs/en/contributing/testing.md",
        });
      }
    }
    return findings;
  },
};
