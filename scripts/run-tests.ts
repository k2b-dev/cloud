/**
 * Workspace test runner.
 *
 *   bun scripts/run-tests.ts                    every suite (integration files skip without CLOUD_TEST_*)
 *   bun scripts/run-tests.ts --integration      bootstrap the CLOUD_TEST_ database, then only files that import scripts/fixtures/test-infra
 *   bun scripts/run-tests.ts --filter gateway   suites whose name or path contains "gateway"
 *   bun scripts/run-tests.ts --exclude grids    everything except suites matching "grids"
 *   bun scripts/run-tests.ts --shard 2/4        deterministic slice of the suite list
 *
 * Browser behavior tests (`*.behavior.test.{ts,tsx}`) belong to this runner:
 * each workspace gets one extra suite that runs them with browser conditions
 * and the Solid DOM preload, started from the repository root so a package's
 * own server-rendering preload in `bunfig.toml` does not apply. Package `test`
 * scripts and the default package run leave those files out.
 *
 * Every `bun test` this runner spawns loads `scripts/fixtures/test-infra.ts`
 * first. Package-owned `test` scripts receive it through `BUN_OPTIONS`. The
 * runtime aliases for `CLOUD_TEST_*` are exported into every child before Bun
 * starts because Bun's default `redis` handle reads `REDIS_URL` at startup,
 * ahead of any preload.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { applyTestRuntimeEnv } from "./fixtures/test-infra-env";

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: { packages?: string[] };
};

export type TestSuite = {
  name: string;
  cwd: string;
  command: string[];
};

export type Options = { integration: boolean; filter?: string; exclude?: string; shard?: { index: number; total: number } };

const ignoredTestPaths = ["node_modules/", "dist/", "build/", "_ssr/"];
const testFiles = new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx}");
const integrationImport = /scripts\/fixtures\/test-infra/;
const behaviorTest = /\.behavior\.test\.tsx?$/;
/** Leaves browser behavior tests out of a package's own `bun test` run; the runner runs them in browser mode. */
export const behaviorIgnore = "--path-ignore-patterns=**/*.behavior.test.*";

const readPackageJson = (path: string): PackageJson => JSON.parse(readFileSync(path, "utf8")) as PackageJson;

const listTestFiles = async (cwd: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const path of testFiles.scan({ cwd, onlyFiles: true })) {
    if (!ignoredTestPaths.some((prefix) => path.startsWith(prefix))) out.push(path);
  }
  return out.sort();
};

/** Test files that gate themselves on `CLOUD_TEST_*` infrastructure. */
export const listIntegrationFiles = async (cwd: string): Promise<string[]> =>
  (await listTestFiles(cwd)).filter((path) => integrationImport.test(readFileSync(join(cwd, path), "utf8")));

export const hasIntegrationTarget = (env: Record<string, string | undefined> = process.env): boolean =>
  Object.entries(env).some(([key, value]) => key.startsWith("CLOUD_TEST_") && Boolean(value?.trim()));

export const discoverTestSuites = async (workspaceRoot: string, options: Options = { integration: false }): Promise<TestSuite[]> => {
  const preload = ["--preload", join(workspaceRoot, "scripts", "fixtures", "test-infra.ts")];
  const browser = ["--isolate", "--conditions=browser", "--preload", join(workspaceRoot, "packages", "ui", "test", "solid-dom-preload.ts")];
  // Integration files migrate schemas and wait on brokers in their hooks; 5 s is too short on a slow runner.
  const integrationTimeout = "30000";
  const rootPackage = readPackageJson(join(workspaceRoot, "package.json"));
  const workspaces = rootPackage.workspaces?.packages ?? [];
  const suites: TestSuite[] = [];

  const add = async (name: string, cwd: string, packageCommand: string[] | null, integrationCommand: string[] | null) => {
    if (options.integration) {
      // A package that owns its integration preload (private database, isolation) runs its own script.
      if (integrationCommand) {
        suites.push({ name, cwd, command: integrationCommand });
        return;
      }
      // Bun's default sql/redis handles and the process-wide Sync binding are shared by every file in
      // one process, so each integration file runs in a process of its own.
      for (const file of await listIntegrationFiles(cwd)) {
        suites.push({ name: `${name} ${file}`, cwd, command: ["bun", "test", ...preload, "--timeout", integrationTimeout, file] });
      }
      return;
    }
    const files = await listTestFiles(cwd);
    const behavior = files.filter((path) => behaviorTest.test(path));
    if (packageCommand) suites.push({ name, cwd, command: packageCommand });
    else if (files.length > behavior.length) suites.push({ name, cwd, command: ["bun", "test", ...preload, behaviorIgnore] });
    if (behavior.length > 0) {
      const command = [
        "bun",
        "--no-env-file",
        `--cwd=${workspaceRoot}`,
        "test",
        ...preload,
        ...browser,
        ...behavior.map((path) => join(cwd, path)),
      ];
      suites.push({ name: `${name} behavior`, cwd, command });
    }
  };

  for (const workspace of workspaces.toSorted()) {
    const cwd = join(workspaceRoot, workspace);
    const pkg = readPackageJson(join(cwd, "package.json"));
    await add(
      pkg.name ?? workspace,
      cwd,
      pkg.scripts?.test ? ["bun", "run", "test"] : null,
      pkg.scripts?.["test:integration"] ? ["bun", "run", "test:integration"] : null,
    );
  }
  await add("workspace root tests", join(workspaceRoot, "tests"), null, null);
  await add("workspace root scripts", join(workspaceRoot, "scripts"), null, null);

  return selectSuites(suites, options, workspaceRoot);
};

export const selectSuites = (suites: TestSuite[], options: Options, workspaceRoot: string): TestSuite[] => {
  let selected = suites;
  const matches = (suite: TestSuite, needle: string): boolean =>
    suite.name.includes(needle) || relative(workspaceRoot, suite.cwd).includes(needle);
  if (options.filter) {
    const needle = options.filter;
    selected = selected.filter((suite) => matches(suite, needle));
  }
  if (options.exclude) {
    const needle = options.exclude;
    selected = selected.filter((suite) => !matches(suite, needle));
  }
  if (options.shard) {
    const { index, total } = options.shard;
    selected = selected.filter((_, position) => position % total === index - 1);
  }
  return selected;
};

export const parseArgs = (argv: string[]): Options => {
  const options: Options = { integration: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--integration") options.integration = true;
    else if (arg === "--filter") options.filter = argv[++i];
    else if (arg === "--exclude") options.exclude = argv[++i];
    else if (arg === "--shard") {
      const match = /^(\d+)\/(\d+)$/.exec(argv[++i] ?? "");
      const index = Number(match?.[1]);
      const total = Number(match?.[2]);
      if (!match || index < 1 || index > total) throw new Error(`--shard expects i/n with 1 <= i <= n, got "${argv[i]}"`);
      options.shard = { index, total };
    } else throw new Error(`unknown argument "${arg}"`);
  }
  if (options.filter === undefined && argv.includes("--filter")) throw new Error("--filter expects a workspace substring");
  return options;
};

const run = async (): Promise<void> => {
  const workspaceRoot = join(import.meta.dir, "..");
  const options = parseArgs(Bun.argv.slice(2));
  if (options.integration && !hasIntegrationTarget()) {
    console.error("--integration needs at least one CLOUD_TEST_* variable (see scripts/fixtures/test-infra.ts).");
    process.exit(2);
  }

  const suites = await discoverTestSuites(workspaceRoot, options);
  const preload = `--preload=${join(workspaceRoot, "scripts", "fixtures", "test-infra.ts")}`;
  const env: Record<string, string | undefined> = { ...Bun.env };
  applyTestRuntimeEnv(env);
  const failed: string[] = [];

  if (options.integration && process.env.CLOUD_TEST_DATABASE_URL) {
    console.log("\n=== integration database bootstrap ===");
    const bootstrap = Bun.spawn(["bun", join(workspaceRoot, "scripts", "fixtures", "integration-bootstrap.ts")], {
      cwd: workspaceRoot,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await bootstrap.exited) !== 0) {
      console.error("integration database bootstrap failed");
      process.exit(1);
    }
  }

  for (const suite of suites) {
    console.log(`\n=== ${suite.name} ===`);
    const started = performance.now();
    const child = Bun.spawn(suite.command, {
      cwd: suite.cwd,
      env: suite.command[1] === "run" ? { ...env, BUN_OPTIONS: [env.BUN_OPTIONS, preload].filter(Boolean).join(" ") } : env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await child.exited) !== 0) failed.push(suite.name);
    console.log(`=== ${suite.name}: ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }

  if (!options.integration && !hasIntegrationTarget()) {
    let skipped = 0;
    for (const suite of suites) skipped += (await listIntegrationFiles(suite.cwd)).length;
    console.log(`\n${skipped} integration test file(s) skipped: no CLOUD_TEST_* variable is set.`);
  }

  if (failed.length > 0) {
    console.error(`\nFailed test suites (${failed.length}): ${failed.join(", ")}`);
    process.exit(1);
  }

  console.log(`\nAll ${suites.length} test suites passed.`);
};

if (import.meta.main) await run();
