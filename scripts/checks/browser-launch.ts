import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "@typescript/typescript6";
import { launchBudgetMs, launchHookMs } from "../../packages/ui/test/browser-budget";
import { discoverTestSuites } from "../run-tests";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles, parseSource, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

/** `launch()`, `launchPersistentContext()`, `connect()`, `connectOverCDP()`, and the like. */
const directLaunch = /\b(?:chromium|firefox|webkit)\.(?:launch|connect)\w*\(/g;
/** An import of Playwright or of the shared launcher, in any spelling. */
export const playwrightImport = /\bfrom\s+["'](?:playwright|[^"']*\/test\/browser(?:\.ts)?)["']/;
/** Integration tests run with `bun run test --integration`, in Chromium only. */
const integrationImport = /scripts\/fixtures\/test-infra/;
const hooks = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);

/** The hook name a call starts from: `beforeAll(...)`, or `beforeAll.each(...)(...)` and the like. */
const calleeRoot = (expression: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression)) return calleeRoot(expression.expression);
  return undefined;
};

/** A literal timeout in ms or `launchHookMs`; undefined for Bun's default, NaN for a value this rule cannot read. */
const timeoutMs = (argument: ts.Expression | undefined): number | undefined => {
  if (!argument) return undefined;
  if (ts.isNumericLiteral(argument)) return Number(argument.text.replaceAll("_", ""));
  if (ts.isIdentifier(argument) && argument.text === "launchHookMs") return launchHookMs;
  return Number.NaN;
};

/**
 * A `launchBrowser()` call lexically inside a hook whose timeout is below `launchHookMs`, also inside a nested callback of
 * that hook. Bun's 5 s hook default is the close budget (#1473); a launch inside it fails nameless at 5 s on a stalled runner
 * (#3862) instead of with the launch's own error. A helper that a hook calls is outside this rule.
 */
export const launchHookFindings = (file: string, source: string): Finding[] => {
  const { sourceFile, findings } = parseSource(file, source);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "launchBrowser") {
      for (let child: ts.Node = node; child.parent; child = child.parent) {
        const call = child.parent;
        if (!ts.isCallExpression(call) || !(ts.isArrowFunction(child) || ts.isFunctionExpression(child))) continue;
        const index = call.arguments.indexOf(child);
        const hook = calleeRoot(call.expression);
        if (index < 0 || !hook || !hooks.has(hook)) continue;
        const ms = timeoutMs(call.arguments[index + 1]);
        if (ms === undefined || !(ms >= launchHookMs)) {
          findings.push({
            file,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            message: `${hook} launches a browser, so give it at least launchHookMs (${launchHookMs} ms) from packages/ui/test/browser: Bun's 5 s hook default is the close budget, and the launch has its own ${launchBudgetMs / 1000} s budget`,
          });
        }
        break;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

/**
 * A test starts its browser with `launchBrowser()` from
 * `packages/ui/test/browser.ts`, so `TEST_BROWSER` chooses the engine and the
 * gate's WebKit job (`bun run test --browser`) finds it. Test code is every
 * test file plus the browser suites that a test file runs in a child process.
 * A Playwright test that the WebKit run would not find, for example one that
 * imports the launcher with a file extension or through a helper, fails too.
 * A hook that calls `launchBrowser()` lexically inside it keeps at least `launchHookMs`, in test files and browser suites (#3874).
 */
export const rule: Rule = {
  name: "browser-launch",
  description:
    "Playwright tests start their browser through packages/ui/test/browser, so they also run in WebKit, and never inside a hook's 5 s default",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const browserRun = await discoverTestSuites(workspaceRoot, { integration: false, browser: true });
    const found = new Set(browserRun.map((suite) => resolve(suite.cwd, suite.command.at(-1)!)));
    const roots = workspacePackages(workspaceRoot).map((path) => join(workspaceRoot, path));
    for (const file of roots.flatMap((root) => listFiles(root, sourceFilePattern)).sort()) {
      const test = isTestFile(file);
      if (!(test || file.endsWith(".browser-suite.ts"))) continue;
      const source = readFileSync(file, "utf8");
      for (const call of source.matchAll(directLaunch)) {
        findings.push({
          file,
          line: source.slice(0, call.index).split("\n").length,
          message: "start the browser with launchBrowser() from packages/ui/test/browser; see docs-site/docs/en/contributing/testing.md",
        });
      }
      if (source.includes("launchBrowser(")) findings.push(...launchHookFindings(file, source));
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
