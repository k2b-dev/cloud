import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverTestSuites } from "../run-tests";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const behaviorTest = /\.behavior\.test\.tsx?$/;
const branchesOnServer = /\bisServer\b/;

/**
 * Browser behavior tests run only through `scripts/run-tests.ts`, which gives
 * every `*.behavior.test.{ts,tsx}` browser conditions and the Solid DOM
 * preload. A test that depends on the browser build must carry that name, and
 * the runner must pick up every such file; otherwise it skips silently.
 */
export const rule: Rule = {
  name: "behavior-tests",
  description: "tests that need the browser build are *.behavior.test files and the root test runner runs every one of them",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const covered = new Set(
      (await discoverTestSuites(workspaceRoot))
        .filter((suite) => suite.command.includes("--conditions=browser"))
        .flatMap((suite) => suite.command),
    );
    const roots = ["packages", "pwas", "fixtures", "docs-site", "tests", "scripts"].map((dir) => join(workspaceRoot, dir));
    for (const file of roots.flatMap((root) => listFiles(root, /\.(?:test|spec)\.tsx?$/))) {
      if (behaviorTest.test(file)) {
        if (!covered.has(file))
          findings.push({ file, message: "no browser suite of `bun run test` runs this behavior test; move it into a workspace" });
        continue;
      }
      const source = readFileSync(file, "utf8");
      const index = source.search(branchesOnServer);
      if (index === -1) continue;
      findings.push({
        file,
        line: source.slice(0, index).split("\n").length,
        message:
          "branches on `isServer`, so it needs the browser build; name it `*.behavior.test.ts(x)` so the runner runs it in browser mode",
      });
    }
    return findings;
  },
};
