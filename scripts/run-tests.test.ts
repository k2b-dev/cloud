import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverTestSuites } from "./run-tests";

const workspaceRoot = join(import.meta.dir, "..");

describe("root test orchestration", () => {
  test("preserves package-owned test commands and isolates unconfigured workspaces", async () => {
    const suites = await discoverTestSuites(workspaceRoot);
    const byName = new Map(suites.map((suite) => [suite.name, suite]));

    expect(byName.get("@k2b/ui")?.command).toEqual(["bun", "run", "test"]);
    expect(byName.get("@k2b/cloud-app-pulse")?.command).toEqual(["bun", "run", "test"]);
    expect(byName.get("@k2b/cloud-app-accounts")?.command).toEqual(["bun", "test"]);
    expect(byName.get("workspace root tests")?.command).toEqual(["bun", "test"]);
    expect(byName.get("workspace root scripts")?.command).toEqual(["bun", "test"]);
  });

  test("covers every configured workspace that contains tests", async () => {
    const suites = await discoverTestSuites(workspaceRoot);
    const names = suites.map((suite) => suite.name);

    expect(names).toContain("@k2b/cloud-docs");
    expect(names).toContain("@k2b/cloud-app-gateway");
    expect(names).toContain("@k2b/cloud-app-tools");
    expect(names.slice(-2)).toEqual(["workspace root tests", "workspace root scripts"]);
  });
});
