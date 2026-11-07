import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverTestSuites } from "../run-tests";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const topLevelModuleMock = /^mock\.module\(/m;

/** A restored import-time spy still leaves its replacement captured by the imported module. */
export const importTimeSpy = (source: string): number => {
  for (const spy of source.matchAll(/^(?:const|let) ([\w$]+) = spyOn\(/gm)) {
    const tail = source.slice(spy.index);
    const restore = tail.indexOf(`\n${spy[1]}.mockRestore()`);
    if (restore !== -1 && /\bawait import\(/.test(tail.slice(0, restore))) return spy.index;
  }
  return -1;
};
const testFile = /\.(?:test|spec)\.tsx?$/;
const behaviorTest = /\.behavior\.test\.tsx?$/;

const packageTestScript = (cwd: string): string =>
  (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts?.test ?? "";

/**
 * `mock.module` replaces a module for the whole process. Without `--isolate`,
 * `bun test` runs every file of a suite in one process in directory order, so
 * a top-level module mock leaks into the files loaded after it and failures
 * depend on the machine's file-system order. Import-time spies have the same
 * problem in both directions: an earlier import bypasses the spy, and a later
 * import reuses the module that captured the spy before it was restored.
 * The rule reads each package's own test script, so a runner that loads an
 * isolated package's files together, like the Grids certification, must pass
 * `--isolate` as well.
 */
export const rule: Rule = {
  name: "module-mocks",
  description: "module mocks and import-time spies run only in test suites that isolate their files",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const suite of await discoverTestSuites(workspaceRoot)) {
      const script = suite.command[1] === "run" ? packageTestScript(suite.cwd) : "";
      if (suite.command.includes("--isolate") || script.includes("--isolate")) continue;
      for (const file of listFiles(suite.cwd, testFile).filter((path) => !behaviorTest.test(path))) {
        const source = readFileSync(file, "utf8");
        const moduleMock = source.search(topLevelModuleMock);
        const index = moduleMock === -1 ? importTimeSpy(source) : moduleMock;
        if (index === -1) continue;
        findings.push({
          file,
          line: source.slice(0, index).split("\n").length,
          message: `\`${suite.name}\` shares one process across its test files, so this module replacement depends on file import order; add \`--isolate\` to the package test script or run the mock in a child process like packages/notebooks/src/ws-lifecycle.test.ts`,
        });
      }
    }
    return findings;
  },
};
