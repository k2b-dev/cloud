import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverTestSuites } from "../run-tests";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const topLevelModuleMock = /^mock\.module\(/m;
const testFile = /\.(?:test|spec)\.tsx?$/;
const behaviorTest = /\.behavior\.test\.tsx?$/;

const packageTestScript = (cwd: string): string =>
  (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts?.test ?? "";

/**
 * `mock.module` replaces a module for the whole process. Without `--isolate`,
 * `bun test` runs every file of a suite in one process in directory order, so
 * a top-level module mock leaks into the files loaded after it and failures
 * depend on the machine's file-system order.
 */
export const rule: Rule = {
  name: "module-mocks",
  description: "top-level mock.module calls run only in test suites that isolate their files",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const suite of await discoverTestSuites(workspaceRoot)) {
      const script = suite.command[1] === "run" ? packageTestScript(suite.cwd) : "";
      if (suite.command.includes("--isolate") || script.includes("--isolate")) continue;
      for (const file of listFiles(suite.cwd, testFile).filter((path) => !behaviorTest.test(path))) {
        const source = readFileSync(file, "utf8");
        const index = source.search(topLevelModuleMock);
        if (index === -1) continue;
        findings.push({
          file,
          line: source.slice(0, index).split("\n").length,
          message: `\`${suite.name}\` shares one process across its test files, so this module mock leaks into later files; add \`--isolate\` to the package test script or run the mock in a child process like packages/notebooks/src/ws-lifecycle.test.ts`,
        });
      }
    }
    return findings;
  },
};
