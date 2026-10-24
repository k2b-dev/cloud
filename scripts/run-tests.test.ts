import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { hasIntegrationTarget } from "./fixtures/test-infra-env";
import {
  behaviorIgnore,
  discoverTestSuites,
  parseArgs,
  planShards,
  selectSuites,
  suiteWeight,
  type TestSuite,
  type TestWeights,
} from "./run-tests";

const workspaceRoot = join(import.meta.dir, "..");
const preload = join(workspaceRoot, "scripts", "fixtures", "test-infra.ts");

describe("root test orchestration", () => {
  test("preserves package-owned test commands and preloads the infrastructure gate elsewhere", async () => {
    const suites = await discoverTestSuites(workspaceRoot);
    const byName = new Map(suites.map((suite) => [suite.name, suite]));

    expect(byName.get("@k2b/ui")?.command).toEqual(["bun", "run", "test"]);
    expect(byName.get("@k2b/cloud-app-pulse")?.command).toEqual(["bun", "run", "test"]);
    expect(byName.get("@k2b/cloud-app-accounts")?.command).toEqual(["bun", "run", "test"]);
    expect(byName.get("@k2b/cloud-app-tools")?.command).toEqual(["bun", "test", "--preload", preload, behaviorIgnore]);
    expect(byName.get("workspace root tests")?.command).toEqual(["bun", "test", "--preload", preload, behaviorIgnore]);
    expect(byName.get("workspace root scripts")?.command).toEqual(["bun", "test", "--preload", preload, behaviorIgnore]);
  });

  test("runs every workspace's behavior tests from the root in browser mode with the Solid DOM preload", async () => {
    const suites = await discoverTestSuites(workspaceRoot);
    const core = suites.find((suite) => suite.name === "@k2b/cloud-app-core behavior");
    expect(core?.cwd).toBe(join(workspaceRoot, "packages", "core"));
    expect(core?.command.slice(0, 10)).toEqual([
      "bun",
      "--no-env-file",
      `--cwd=${workspaceRoot}`,
      "test",
      "--preload",
      preload,
      "--isolate",
      "--conditions=browser",
      "--preload",
      join(workspaceRoot, "packages", "ui", "test", "solid-dom-preload.ts"),
    ]);
    expect(core?.command).toContain(join(workspaceRoot, "packages/core/src/pages/admin/CacheNotice.behavior.test.ts"));
    expect(core?.command.some((arg) => arg.endsWith(".test.ts") && !arg.includes(".behavior."))).toBeFalse();
    expect(suites.some((suite) => suite.name === "@k2b/cloud-app-tools behavior")).toBeTrue();
  });

  test("covers every configured workspace that contains tests", async () => {
    const suites = await discoverTestSuites(workspaceRoot);
    const names = suites.map((suite) => suite.name);

    expect(names).toContain("@k2b/cloud-docs");
    expect(names).toContain("@k2b/cloud-app-gateway");
    expect(names).toContain("@k2b/cloud-app-tools");
    expect(names.slice(-2)).toEqual(["workspace root tests", "workspace root scripts"]);
    expect(names).toContain("@k2b/cloud-app-mail behavior");
  });

  test("integration mode runs one process per gated file or the package's own integration script", async () => {
    const suites = await discoverTestSuites(workspaceRoot, { integration: true });
    expect(suites.length).toBeGreaterThan(0);
    for (const suite of suites) {
      if (suite.command[1] === "run") {
        expect(suite.command).toEqual(["bun", "run", "test:integration"]);
        continue;
      }
      expect(suite.command.slice(0, 6)).toEqual(["bun", "test", "--preload", preload, "--timeout", "30000"]);
      expect(suite.command).toHaveLength(7);
      expect(await Bun.file(join(suite.cwd, suite.command[6]!)).text()).toContain("scripts/fixtures/test-infra");
    }
  });

  test("browser mode runs each file that starts a browser in a process of its own, without integration files", async () => {
    const suites = await discoverTestSuites(workspaceRoot, { integration: false, browser: true });
    const byName = new Map(suites.map((suite) => [suite.name, suite]));
    expect(byName.get("@k2b/ui src/styles/touch-targets.browser.test.ts")?.command).toEqual([
      "bun",
      "test",
      "--preload",
      preload,
      "src/styles/touch-targets.browser.test.ts",
    ]);
    // A behavior test that starts a browser keeps the browser conditions and the Solid DOM preload.
    expect(byName.get("@k2b/pwa-auth src/status-bar.behavior.test.ts")?.command).toContain("--conditions=browser");
    expect(byName.has("@k2b/cloud-app-spaces src/frontend/[id]/_components/kanban/kanban-board.browser.test.ts")).toBeTrue();
    expect(suites.some((suite) => suite.name.includes("consent-browser.integration"))).toBeFalse();
    // Assistant's artifact suites run nightly in Google Chrome; only the HTML app frame suites use the shared launcher.
    expect(suites.filter((suite) => suite.name.startsWith("@k2b/cloud-app-assistant src/artifacts/")).map((suite) => suite.name)).toEqual(
      expect.arrayContaining([
        "@k2b/cloud-app-assistant src/artifacts/chat-presentation.browser.test.ts",
        "@k2b/cloud-app-assistant src/artifacts/html/html-app.browser.test.ts",
        "@k2b/cloud-app-assistant src/artifacts/runner.browser.test.ts",
      ]),
    );
    expect(byName.has("@k2b/cloud-app-assistant src/artifacts/workspace.browser.test.ts")).toBeFalse();
    expect(byName.has("@k2b/cloud-app-assistant src/frontend/AssistantChatSidebar.browser.test.ts")).toBeTrue();
  });

  test("browser mode fails instead of passing when it selects no test file", () => {
    const run = Bun.spawnSync(
      ["bun", "--no-env-file", join(workspaceRoot, "scripts", "run-tests.ts"), "--browser", "--filter", "no-such-suite"],
      {
        cwd: workspaceRoot,
        // This empty selection starts no suites and must not wait for a local heavy slot.
        env: { ...process.env, CLOUD_HEAVY_LOCK: "held" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain("--browser selected no test file");
    expect(run.stdout.toString()).not.toContain("passed");
  });

  const makeSuites = (names: string[]): TestSuite[] =>
    names.map((name) => ({
      name,
      cwd: join(workspaceRoot, "packages", name),
      command: [],
    }));
  const names = (suites: TestSuite[]) => suites.map((suite) => suite.name);
  const weights: TestWeights = { browser: {}, unit: { a: 10, b: 1, c: 10, d: 1, e: 10, f: 1 } };

  test("help explains repeated filters without acquiring a heavy slot or running suites", () => {
    const run = Bun.spawnSync(["bun", "--no-env-file", join(workspaceRoot, "scripts", "run-tests.ts"), "--help"], {
      cwd: workspaceRoot,
      env: { ...process.env, CLOUD_HEAVY_LOCK: "", CI: "" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("Repeat to run the union of all matches, each suite once.");
    expect(run.stdout.toString()).toContain("--exclude");
    expect(run.stdout.toString()).not.toContain("test suites passed");
    expect(run.stderr.toString()).toBe("");
  });

  test("repeated filters preserve every parser value", () => {
    expect(parseArgs(["--filter", "packages/a", "--browser", "--filter", "packages/b"])).toEqual({
      integration: false,
      browser: true,
      filters: ["packages/a", "packages/b"],
    });
    expect(parseArgs([])).toEqual({ integration: false });
  });

  test("repeated filters select the union by name or path exactly once in discovery order", () => {
    const suites = makeSuites(["a", "b", "c"]);
    const options = parseArgs(["--filter", "packages/b", "--filter", "named-a", "--filter", "packages/b", "--filter", "missing"]);
    // Match named-a by name only; b matches its relative workspace path.
    suites[0]!.name = "named-a";
    suites[0]!.cwd = join(workspaceRoot, "other");
    expect(names(selectSuites(suites, options, workspaceRoot))).toEqual(["named-a", "b"]);
    expect(names(selectSuites(suites, parseArgs([]), workspaceRoot))).toEqual(["named-a", "b", "c"]);
    expect(names(selectSuites(suites, parseArgs(["--filter", "missing"]), workspaceRoot))).toEqual([]);
    expect(names(selectSuites(suites, parseArgs(["--filter", ""]), workspaceRoot))).toEqual(["named-a", "b", "c"]);
  });

  test("repeated filters apply exclusions to the union before sharding", () => {
    const suites = makeSuites(["a", "b", "c", "d", "e", "f"]);
    const args = ["--filter", "packages/a", "--filter", "packages/b", "--filter", "packages/c", "--exclude", "packages/b"];
    expect(names(selectSuites(suites, parseArgs(args), workspaceRoot, weights))).toEqual(["a", "c"]);
    expect(names(selectSuites(suites, parseArgs([...args, "--shard", "1/2"]), workspaceRoot, weights))).toEqual(["a"]);
    expect(names(selectSuites(suites, parseArgs([...args, "--shard", "2/2"]), workspaceRoot, weights))).toEqual(["c"]);
    expect(names(selectSuites(suites, parseArgs(["--exclude", "packages/b"]), workspaceRoot))).toEqual(["a", "c", "d", "e", "f"]);
  });

  test("repeated filters reject a missing value at every occurrence", () => {
    for (const args of [
      ["--filter"],
      ["--filter", "packages/a", "--filter"],
      ["--filter", "--filter", "packages/b"],
      ["--filter", "packages/a", "--filter", "--browser"],
    ])
      expect(() => parseArgs(args)).toThrow("--filter expects a workspace substring");
  });

  test("filters and shards deterministically by measured suite time", () => {
    const suites = makeSuites(["a", "b", "c", "d", "e", "f"]);
    expect(names(selectSuites(suites, { integration: false, filters: ["packages/c"] }, workspaceRoot))).toEqual(["c"]);
    const select = (index: number) => selectSuites(suites, { integration: false, shard: { index, total: 2 } }, workspaceRoot, weights);
    // a -> 1, c -> 2, e -> 1, then all three 1-second suites -> 2.
    expect(names(select(1))).toEqual(["a", "e"]);
    expect(names(select(2))).toEqual(["b", "c", "d", "f"]);
    const loads = [select(1), select(2)].map((shard) => shard.reduce((sum, suite) => sum + suiteWeight(suite.name, weights.unit), 0));
    expect(loads).toEqual([20, 13]);
    expect(Math.abs(loads[0]! - loads[1]!)).toBeLessThanOrEqual(10);
    expect(planShards(suites, 2, weights.unit).map((shard) => shard.seconds)).toEqual(loads);
  });

  test("filters and excludes before planning shards", () => {
    const suites = makeSuites(["a", "b", "c", "d", "e", "f"]);
    const options = { integration: false, exclude: "packages/e", shard: { index: 1, total: 2 } };
    expect(names(selectSuites(suites, options, workspaceRoot, weights))).toEqual(["a", "b", "f"]);
    expect(names(selectSuites(suites, { ...options, filters: ["packages/c"] }, workspaceRoot, weights))).toEqual(["c"]);
  });

  test("covers every suite exactly once for every shard count, including empty shards", () => {
    const suites = makeSuites(["a", "b", "c", "d", "e", "f", "g", "h", "unknown"]);
    const table = { a: 10, b: 1, c: 10, d: 1, e: 0, f: 3, g: 3, h: 5 };
    for (const total of [1, 2, 3, 4, 5, 6, 12]) {
      const shards = planShards(suites, total, table);
      const all = shards.flatMap((shard) => names(shard.suites));
      expect(shards).toHaveLength(total);
      expect(all.toSorted()).toEqual(names(suites).toSorted());
      expect(new Set(all).size).toBe(suites.length);
    }
    expect(planShards([], 3, table)).toEqual(Array.from({ length: 3 }, () => ({ suites: [], seconds: 0 })));
  });

  test("keeps membership independent of input order, and runs each shard in discovery order", () => {
    const suites = makeSuites(["a", "b", "c", "d", "e", "f"]);
    const shuffled = makeSuites(["f", "c", "e", "b", "d", "a"]);
    const original = planShards(suites, 2, weights.unit);
    const reordered = planShards(shuffled, 2, weights.unit);
    expect(reordered.map((shard) => names(shard.suites))).toEqual([
      ["e", "a"],
      ["f", "c", "b", "d"],
    ]);
    expect(reordered.map((shard) => names(shard.suites).toSorted())).toEqual(original.map((shard) => names(shard.suites).toSorted()));
    expect(names(suites)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(names(shuffled)).toEqual(["f", "c", "e", "b", "d", "a"]);
  });

  test("breaks weight ties by code-unit name order and load ties by count, then index", () => {
    const suites = makeSuites(["ä", "a", "Z", "A"]);
    expect(planShards(suites, 2, {}).map((shard) => names(shard.suites))).toEqual([
      ["a", "A"],
      ["ä", "Z"],
    ]);
    // All loads tie at zero; suite counts must still spread work over every shard.
    expect(planShards(makeSuites(["d", "b", "c", "a"]), 3, { a: 0, b: 0, c: 0, d: 0 }).map((shard) => names(shard.suites))).toEqual([
      ["d", "a"],
      ["b"],
      ["c"],
    ]);
  });

  test("unknown and invalid weights use the mode's median, or one for an empty table", () => {
    expect(suiteWeight("unknown", { a: 9, b: 1, c: 4 })).toBe(4);
    expect(suiteWeight("unknown", { a: 9, b: 1, c: 4, d: 6 })).toBe(5);
    expect(suiteWeight("unknown", {})).toBe(1);
    const table = { a: 0, b: 4, negative: -1, infinite: Infinity, nan: NaN };
    for (const name of ["unknown", "negative", "infinite", "nan"]) expect(suiteWeight(name, table)).toBe(2);
    expect(suiteWeight("a", table)).toBe(0);
    expect(suiteWeight("unknown", { invalid: -1 })).toBe(1);
  });

  test("selects weights for the requested mode", () => {
    const suites = makeSuites(["a", "b", "c", "d", "e", "f"]);
    const tables: TestWeights = { unit: weights.unit, browser: { a: 1, b: 10, c: 1, d: 10, e: 1, f: 10 } };
    const select = (browser: boolean) =>
      [1, 2].map((index) =>
        names(selectSuites(suites, { integration: false, browser, shard: { index, total: 2 } }, workspaceRoot, tables)),
      );
    expect(select(false)).toEqual([
      ["a", "e"],
      ["b", "c", "d", "f"],
    ]);
    expect(select(true)).toEqual([
      ["b", "f"],
      ["a", "c", "d", "e"],
    ]);
  });

  test("reports wall time and fails a run that exceeds its budget even with no failed suites", () => {
    for (const maxMinutes of ["0.000001", "60"]) {
      const run = Bun.spawnSync(
        ["bun", "--no-env-file", join(workspaceRoot, "scripts", "run-tests.ts"), "--filter", "no-such-suite", "--max-minutes", maxMinutes],
        { cwd: workspaceRoot, env: { ...process.env, CLOUD_HEAVY_LOCK: "held" }, stdout: "pipe", stderr: "pipe" },
      );
      const stdout = run.stdout.toString();
      expect(stdout).toMatch(/test run took \d+\.\d min \(limit /);
      if (maxMinutes === "60") {
        expect(run.exitCode).toBe(0);
        expect(stdout).not.toContain("::error");
        expect(stdout).toContain("All 0 test suites passed.");
      } else {
        expect(run.exitCode).toBe(1);
        expect(stdout.split("::error title=Test shard over its time limit::")).toHaveLength(2);
        expect(stdout.trim().endsWith("All 0 test suites passed.")).toBeFalse();
      }
    }
  });

  test("parses arguments and rejects malformed shards", () => {
    expect(parseArgs(["--integration", "--filter", "gateway", "--shard", "2/3"])).toEqual({
      integration: true,
      filters: ["gateway"],
      shard: { index: 2, total: 3 },
    });
    expect(parseArgs(["--browser", "--shard", "1/2"])).toEqual({ integration: false, browser: true, shard: { index: 1, total: 2 } });
    expect(() => parseArgs(["--shard", "0/3"])).toThrow();
    expect(() => parseArgs(["--shard", "4/3"])).toThrow();
    expect(() => parseArgs(["--bogus"])).toThrow();
  });

  test("parses positive minute budgets and rejects malformed values", () => {
    expect(parseArgs(["--max-minutes", "20"])).toEqual({ integration: false, maxMinutes: 20 });
    expect(parseArgs(["--browser", "--shard", "2/5", "--max-minutes", "20"])).toEqual({
      integration: false,
      browser: true,
      shard: { index: 2, total: 5 },
      maxMinutes: 20,
    });
    expect(parseArgs(["--max-minutes", "0.0001"]).maxMinutes).toBe(0.0001);
    for (const value of ["0", "-1", "abc", "Infinity", "--browser", undefined]) {
      const args = value === undefined ? ["--max-minutes"] : ["--max-minutes", value];
      expect(() => parseArgs(args)).toThrow(`--max-minutes expects a positive number of minutes, got "${value}"`);
    }
  });

  test("detects configured integration targets", () => {
    expect(hasIntegrationTarget({})).toBeFalse();
    expect(hasIntegrationTarget({ CLOUD_TEST_DATABASE_URL: " " })).toBeFalse();
    expect(hasIntegrationTarget({ CLOUD_TEST_NATS_SERVERS: "nats://localhost:4222" })).toBeTrue();
  });
});

test("discovers ClickHouse and versioned Pulse migration files as isolated integration suites", async () => {
  const suites = await discoverTestSuites(workspaceRoot, { integration: true });
  for (const name of [
    "src/store/check.integration.test.ts",
    "src/api/admin-store.integration.test.ts",
    "src/migrate.integration.test.ts",
    "integration/test-clickhouse-cleanup.integration.test.ts",
  ]) {
    const suite = suites.find((item) => item.name.endsWith(name));
    expect(suite).toBeDefined();
    expect(suite?.command.at(-1)).toBe(name);
  }
  expect(suites.some((suite) => suite.name.endsWith("src/schema.integration.test.ts") && suite.name.includes("cloud-app-pulse"))).toBe(
    false,
  );
});
