import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { discoverTestSuites } from "../run-tests";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/** `launch()`, `launchPersistentContext()`, `connect()`, `connectOverCDP()`, and the like. */
const directLaunch = /\b(?:chromium|firefox|webkit)\.(?:launch|connect)\w*\(/g;
/** An import of Playwright or of the shared launcher, in any spelling. */
const playwrightImport = /\bfrom\s+["'](?:playwright|[^"']*\/test\/browser(?:\.ts)?)["']/;
/** Integration tests run with `bun run test --integration`, in Chromium only. */
const integrationImport = /scripts\/fixtures\/test-infra/;
/** Assistant's artifact suites run nightly in Google Chrome, a Chromium channel, and never in the gate. */
const exempt = /^packages\/assistant\/src\/artifacts\//;

/**
 * A test starts its browser with `launchBrowser()` from
 * `packages/ui/test/browser.ts`, so `TEST_BROWSER` chooses the engine and the
 * gate's WebKit job (`bun run test --browser`) finds it. Test code is every
 * test file plus the browser suites that a test file runs in a child process.
 * A Playwright test that the WebKit run would not find, for example one that
 * imports the launcher with a file extension or through a helper, fails too.
 */
export const rule: Rule = {
  name: "browser-launch",
  description: "Playwright tests start their browser through packages/ui/test/browser, so they also run in WebKit",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const browserRun = await discoverTestSuites(workspaceRoot, { integration: false, browser: true });
    const found = new Set(browserRun.map((suite) => resolve(suite.cwd, suite.command.at(-1)!)));
    const roots = workspacePackages(workspaceRoot).map((path) => join(workspaceRoot, path));
    for (const file of roots.flatMap((root) => listFiles(root, sourceFilePattern)).sort()) {
      const test = isTestFile(file);
      if (!(test || file.endsWith(".browser-suite.ts")) || exempt.test(relative(workspaceRoot, file))) continue;
      const source = readFileSync(file, "utf8");
      for (const call of source.matchAll(directLaunch)) {
        findings.push({
          file,
          line: source.slice(0, call.index).split("\n").length,
          message: "start the browser with launchBrowser() from packages/ui/test/browser; see docs-site/docs/en/contributing/testing.md",
        });
      }
      if (test && playwrightImport.test(source) && !integrationImport.test(source) && !found.has(file)) {
        findings.push({
          file,
          message: '`bun run test --browser` does not find this Playwright test: import launchBrowser() from ".../test/browser" in it',
        });
      }
    }
    return findings;
  },
};
