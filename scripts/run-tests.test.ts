import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverTestSuites, hasIntegrationTarget, parseArgs, selectSuites, type TestSuite } from "./run-tests";

const workspaceRoot = join(import.meta.dir, "..");
const preload = join(workspaceRoot, "scripts", "fixtures", "test-infra.ts");

describe("root test orchestration", () => {
  test("preserves package-owned test commands and preloads the infrastructure gate elsewhere", async () => {
    const suites = await discoverTestSuites(workspaceRoot);
    const byName = new Map(suites.map((suite) => [suite.name, suite]));

    expect(byName.get("@k2b/ui")?.command).toEqual(["bun", "run", "test"]);
    expect(byName.get("@k2b/cloud-app-pulse")?.command).toEqual(["bun", "run", "test"]);
    expect(byName.get("@k2b/cloud-app-accounts")?.command).toEqual(["bun", "run", "test"]);
    expect(byName.get("@k2b/cloud-app-tools")?.command).toEqual(["bun", "test", "--preload", preload]);
    expect(byName.get("workspace root tests")?.command).toEqual(["bun", "test", "--preload", preload]);
    expect(byName.get("workspace root scripts")?.command).toEqual(["bun", "test", "--preload", preload]);
  });

  test("covers every configured workspace that contains tests", async () => {
    const suites = await discoverTestSuites(workspaceRoot);
    const names = suites.map((suite) => suite.name);

    expect(names).toContain("@k2b/cloud-docs");
    expect(names).toContain("@k2b/cloud-app-gateway");
    expect(names).toContain("@k2b/cloud-app-tools");
    expect(names.slice(-2)).toEqual(["workspace root tests", "workspace root scripts"]);
  });

  test("integration mode runs one process per gated file or the package's own integration script", async () => {
    const suites = await discoverTestSuites(workspaceRoot, { integration: true });
    expect(suites.length).toBeGreaterThan(0);
    for (const suite of suites) {
      if (suite.command[1] === "run") {
        expect(suite.command).toEqual(["bun", "run", "test:integration"]);
        continue;
      }
      expect(suite.command.slice(0, 4)).toEqual(["bun", "test", "--preload", preload]);
      expect(suite.command).toHaveLength(5);
      expect(await Bun.file(join(suite.cwd, suite.command[4]!)).text()).toContain("scripts/fixtures/test-infra");
    }
  });

  test("filters and shards deterministically", () => {
    const suites: TestSuite[] = ["a", "b", "c", "d", "e"].map((name) => ({
      name,
      cwd: join(workspaceRoot, "packages", name),
      command: [],
    }));
    expect(selectSuites(suites, { integration: false, filter: "packages/c" }, workspaceRoot).map((suite) => suite.name)).toEqual(["c"]);
    expect(selectSuites(suites, { integration: false, shard: { index: 1, total: 2 } }, workspaceRoot).map((suite) => suite.name)).toEqual([
      "a",
      "c",
      "e",
    ]);
    expect(selectSuites(suites, { integration: false, shard: { index: 2, total: 2 } }, workspaceRoot).map((suite) => suite.name)).toEqual([
      "b",
      "d",
    ]);
  });

  test("parses arguments and rejects malformed shards", () => {
    expect(parseArgs(["--integration", "--filter", "gateway", "--shard", "2/3"])).toEqual({
      integration: true,
      filter: "gateway",
      shard: { index: 2, total: 3 },
    });
    expect(() => parseArgs(["--shard", "0/3"])).toThrow();
    expect(() => parseArgs(["--shard", "4/3"])).toThrow();
    expect(() => parseArgs(["--bogus"])).toThrow();
  });

  test("detects configured integration targets", () => {
    expect(hasIntegrationTarget({})).toBeFalse();
    expect(hasIntegrationTarget({ CLOUD_TEST_DATABASE_URL: " " })).toBeFalse();
    expect(hasIntegrationTarget({ CLOUD_TEST_NATS_SERVERS: "nats://localhost:4222" })).toBeTrue();
  });
});
