import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { hasIntegrationTarget } from "./fixtures/test-infra-env";
import {
  behaviorIgnore,
  discoverTestSuites,
  parseArgs,
  planShards,
  runTestCommand,
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
  const weights: TestWeights = { integration: {}, browser: {}, unit: { a: 10, b: 1, c: 10, d: 1, e: 10, f: 1 } };

  test("filters and shards deterministically by measured suite time", () => {
    const suites = makeSuites(["a", "b", "c", "d", "e", "f"]);
    expect(names(selectSuites(suites, { integration: false, filter: "packages/c" }, workspaceRoot))).toEqual(["c"]);
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
    expect(names(selectSuites(suites, { ...options, filter: "packages/c" }, workspaceRoot, weights))).toEqual(["c"]);
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

  test("spreads new unmeasured files across the least-loaded shards deterministically", () => {
    const suites = makeSuites(["slow", "fast", ...Array.from({ length: 9 }, (_, index) => `new-${index}`)]);
    const table = { slow: 90, fast: 10 };
    const plan = planShards(suites, 3, table);
    expect(planShards([...suites].reverse(), 3, table).map((shard) => names(shard.suites).toSorted())).toEqual(
      plan.map((shard) => names(shard.suites).toSorted()),
    );
    expect(plan.flatMap((shard) => names(shard.suites)).toSorted()).toEqual(names(suites).toSorted());
    expect(new Set(plan.flatMap((shard) => names(shard.suites))).size).toBe(suites.length);
    expect(Math.max(...plan.map((shard) => shard.seconds)) - Math.min(...plan.map((shard) => shard.seconds))).toBeLessThanOrEqual(50);
    expect(plan.every((shard) => shard.suites.some((suite) => suite.name.startsWith("new-")))).toBeTrue();
  });

  test("selects weights for the requested mode", () => {
    const suites = makeSuites(["a", "b", "c", "d", "e", "f"]);
    const tables: TestWeights = {
      integration: { a: 1, b: 1, c: 1, d: 10, e: 10, f: 10 },
      unit: weights.unit,
      browser: { a: 1, b: 10, c: 1, d: 10, e: 1, f: 10 },
    };
    const select = (browser: boolean, integration = false) =>
      [1, 2].map((index) => names(selectSuites(suites, { integration, browser, shard: { index, total: 2 } }, workspaceRoot, tables)));
    expect(select(false)).toEqual([
      ["a", "e"],
      ["b", "c", "d", "f"],
    ]);
    expect(select(false, true)).toEqual([
      ["d", "f"],
      ["a", "b", "c", "e"],
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
        {
          cwd: workspaceRoot,
          env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CLOUD_TEST_"))),
            CLOUD_HEAVY_LOCK: "held",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
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
    expect(parseArgs(["--integration", "--filter", "gateway", "--shard", "2/3", "--max-minutes", "20", "--list"])).toEqual({
      integration: true,
      filter: "gateway",
      maxMinutes: 20,
      list: true,
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

test("keeps the Mail workflow kernel in Cloud's isolated CI integration suites with Mail's fixture setup", async () => {
  const suites = await discoverTestSuites(workspaceRoot, { integration: true, filter: "mail-workflow-kernel" });
  expect(suites).toEqual([
    {
      name: "@k2b/cloud test/integration/mail-workflow-kernel.integration.test.ts",
      cwd: join(workspaceRoot, "packages/cloud"),
      command: ["bun", "test", "--preload", preload, "--timeout", "30000", "test/integration/mail-workflow-kernel.integration.test.ts"],
    },
  ]);
  expect(await Bun.file(join(suites[0]!.cwd, suites[0]!.command.at(-1)!)).text()).toContain(
    'import "../../../mail/test/integration-preload";',
  );
});

for (const mode of ["unit", "webkit", "integration"] as const) {
  test(`CI ${mode} shards cover the selection exactly once and fit the measured budget`, async () => {
    const matrixJob = z.object({
      "timeout-minutes": z.number(),
      strategy: z.object({ "fail-fast": z.boolean(), matrix: z.object({ shard: z.array(z.number().int().positive()) }) }),
      steps: z.array(z.object({ run: z.string().optional() })),
    });
    const workflow = z
      .object({
        jobs: z.object({ unit: matrixJob, webkit: matrixJob, integration: matrixJob, gate: z.object({ needs: z.array(z.string()) }) }),
      })
      .parse(Bun.YAML.parse(await Bun.file(join(workspaceRoot, ".github/workflows/ci.yml")).text()));
    const job = workflow.jobs[mode];
    const shards = job.strategy.matrix.shard;
    const command = job.steps.find((step) => step.run?.startsWith("bun run test "))?.run;
    if (!command) throw new Error(`${mode} job needs its test runner command`);
    const options = parseArgs(
      command.replace("${{ matrix.shard }}", "1").replace("${{ strategy.job-total }}", String(shards.length)).split(" ").slice(3),
    );
    expect(options.integration).toBe(mode === "integration");
    expect(Boolean(options.browser)).toBe(mode === "webkit");
    if (options.integration) expect(options.exclude).toBe("grids");
    expect(options.shard?.total).toBe(shards.length);
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, index) => index + 1));
    expect(job.strategy["fail-fast"]).toBeFalse();
    expect(options.maxMinutes).toBe(20);
    expect(options.maxMinutes).toBeLessThan(job["timeout-minutes"]);
    const all = await discoverTestSuites(workspaceRoot, { ...options, shard: undefined });
    const selected = await Promise.all(
      shards.map((index) => discoverTestSuites(workspaceRoot, { ...options, shard: { index, total: shards.length } })),
    );
    const names = selected.flat().map((suite) => suite.name);
    expect(names.toSorted()).toEqual(all.map((suite) => suite.name).toSorted());
    expect(new Set(names).size).toBe(all.length);
    const weights = (await import("./test-weights.json")).default[mode === "webkit" ? "browser" : mode];
    for (const shard of selected) {
      expect(shard.length).toBeGreaterThan(0);
      expect(shard.reduce((sum, suite) => sum + suiteWeight(suite.name, weights), 0)).toBeLessThanOrEqual(15 * 60);
    }
    expect(workflow.jobs.gate.needs).toContain(mode);
  });
}

test("integration --list prints the exact selection without a target, heavy slot or bootstrap", async () => {
  const args = ["--integration", "--exclude", "grids", "--shard", "2/3", "--list"];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("CLOUD_TEST_") && key !== "CLOUD_HEAVY_LOCK"),
  );
  const run = Bun.spawnSync(["bun", "--no-env-file", join(workspaceRoot, "scripts/run-tests.ts"), ...args], {
    cwd: workspaceRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode).toBe(0);
  expect(run.stderr.toString()).toBe("");
  const suites = await discoverTestSuites(workspaceRoot, parseArgs(args));
  expect(run.stdout.toString().trim().split("\n")).toEqual(suites.map((suite) => suite.name));
});

test("an active command fails at its budget instead of waiting for the job timeout", async () => {
  const suite: TestSuite = {
    name: "stalled suite",
    cwd: workspaceRoot,
    command: [process.execPath, "--no-env-file", "-e", "setInterval(() => {}, 1000)"],
  };
  // Capture the expected annotation so a passing regression test does not annotate the CI job as failed.
  const run = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `import { runTestCommand } from ${JSON.stringify(join(workspaceRoot, "scripts/run-tests.ts"))};
     await runTestCommand(${JSON.stringify(suite)}, process.env, 50);`,
    ],
    { cwd: workspaceRoot, env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
  expect(code).toBe(1);
  expect(stderr).toContain("::error title=Test shard over its time limit::");
  expect(stderr).toContain("test run exceeded its time budget");
  await expect(runTestCommand({ name: "late suite", cwd: workspaceRoot, command: [] }, process.env, 0)).rejects.toThrow("time budget");
});

test("deadline cleanup also stops descendants that start a separate session", async () => {
  if (process.platform === "win32") return;
  const leaf = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
  const suite: TestSuite = {
    name: "detached browser fixture",
    cwd: workspaceRoot,
    command: [
      process.execPath,
      "--no-env-file",
      "-e",
      `
      const leaf = Bun.spawn([process.execPath, "--no-env-file", "-e", ${JSON.stringify(leaf)}], {
        detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      leaf.unref();
      console.log("OWNED_LEAF_PID=" + leaf.pid);
      setInterval(() => {}, 1000);`,
    ],
  };
  const run = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `import { runTestCommand } from ${JSON.stringify(join(workspaceRoot, "scripts/run-tests.ts"))};
     await runTestCommand(${JSON.stringify(suite)}, process.env, 500);`,
    ],
    { cwd: workspaceRoot, env: process.env, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
  const pid = Number(/OWNED_LEAF_PID=(\d+)/.exec(stdout)?.[1]);
  expect(pid).toBeGreaterThan(0);
  try {
    expect(code).toBe(1);
    expect(stderr).toContain("test run exceeded its time budget");
    let alive = true;
    try {
      process.kill(pid, 0);
      if (process.platform === "linux") {
        const stat = await Bun.file(`/proc/${pid}/stat`).text();
        alive = !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && ["ESRCH", "ENOENT"].includes(String(error.code)))) throw error;
      alive = false;
    }
    expect(alive).toBeFalse();
  } finally {
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
  }
});

test("integration NATS housekeeping is stopped by the shard deadline", async () => {
  const sockets = new Set<Socket>();
  // A local broker that accepts the connection but never replies to the NATS handshake.
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test broker port");
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CLOUD_TEST_")));
    const run = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(workspaceRoot, "scripts/run-tests.ts"),
        "--integration",
        "--filter",
        "no-such-suite",
        "--max-minutes",
        "0.02",
      ],
      { cwd: workspaceRoot, env: { ...env, CLOUD_TEST_NATS_SERVERS: `nats://127.0.0.1:${address.port}` }, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("::error title=Test shard over its time limit::Time budget exhausted during integration NATS housekeeping");
    expect(sockets.size).toBeGreaterThan(0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
