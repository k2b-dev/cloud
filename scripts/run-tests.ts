/**
 * Workspace test runner.
 *
 *   bun run test                    every suite (integration files skip without CLOUD_TEST_*)
 *   bun run test --integration      bootstrap the CLOUD_TEST_ database, then only files that import scripts/fixtures/test-infra
 *   bun run test --browser          only non-integration files that start a browser through packages/ui/test/browser
 *   bun run test --filter gateway   suites whose name or path contains "gateway"
 *   bun run test --exclude grids    everything except suites matching "grids"
 *   bun run test --shard 2/4        slice balanced by measured suite time in scripts/test-weights.json
 *   bun run test --list             print the selected suite names without running or connecting
 *   bun run test --max-minutes 20   fail the run when it takes longer than 20 minutes, even when every suite passed
 *
 * Browser behavior tests (`*.behavior.test.{ts,tsx}`) belong to this runner:
 * each workspace gets one extra suite that runs them with browser conditions
 * and the Solid DOM preload, started from the repository root so a package's
 * own server-rendering preload in `bunfig.toml` does not apply. Package `test`
 * scripts and the default package run leave those files out.
 *
 * `bun run test` starts this runner with `--no-env-file` and passes the flag to
 * every process it spawns through `BUN_OPTIONS`, so no test reads a checkout's
 * `.env`: tests see the same configuration as in CI and worktrees, not the
 * development stack's `APP_URL`, secrets, or origins.
 *
 * Every `bun test` this runner spawns loads `scripts/fixtures/test-infra.ts`
 * first. Package-owned `test` scripts receive it through `BUN_OPTIONS`. The
 * runtime aliases for `CLOUD_TEST_*` are exported into every child before Bun
 * starts because Bun's default `redis` handle reads `REDIS_URL` at startup,
 * ahead of any preload.
 *
 * `--browser` runs the Playwright tests alone, for example in another engine:
 * `TEST_BROWSER=webkit bun run test --browser` (see `packages/ui/test/browser.ts`).
 * Each file runs in a process of its own, a behavior test with the browser
 * conditions and preload above. The run fails when it selects no file, and it
 * uses the existing `packages/ui/dist` without building it.
 *
 * With `CLOUD_TEST_NATS_SERVERS` set, the runner first deletes the test Sync
 * namespaces that killed test processes left on the broker
 * (`scripts/fixtures/test-sync.ts`).
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { applyTestRuntimeEnv, dotenvLeak, hasIntegrationTarget, noEnvFile, readTestTarget } from "./fixtures/test-infra-env";
import { runUnderHeavyLock } from "./heavy-lock";
import committedWeights from "./test-weights.json";

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

export type TestWeights = {
  browser: Record<string, number>;
  unit: Record<string, number>;
  integration: Record<string, number>;
};

export type Options = {
  integration: boolean;
  browser?: boolean;
  list?: boolean;
  filter?: string;
  exclude?: string;
  shard?: { index: number; total: number };
  maxMinutes?: number;
};

const ignoredTestPaths = ["node_modules/", "dist/", "build/", "_ssr/"];
const testFiles = new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx}");
const integrationImport = /scripts\/fixtures\/test-infra/;
const browserImport = /\/test\/browser["']/;
/** Browser behavior tests, which this runner runs with browser conditions and the Solid DOM preload. */
export const behaviorTest = /\.behavior\.test\.tsx?$/;
/** Leaves browser behavior tests out of a package's own `bun test` run; the runner runs them in browser mode. */
export const behaviorIgnore = "--path-ignore-patterns=**/*.behavior.test.*";

const readPackageJson = (path: string): PackageJson => JSON.parse(readFileSync(path, "utf8")) as PackageJson;

/** Test files of one workspace, relative to `cwd`, as this runner discovers them. */
export const listTestFiles = async (cwd: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const path of testFiles.scan({ cwd, onlyFiles: true })) {
    if (!ignoredTestPaths.some((prefix) => path.startsWith(prefix))) out.push(path);
  }
  return out.sort();
};

/** Test files that gate themselves on `CLOUD_TEST_*` infrastructure. */
export const listIntegrationFiles = async (cwd: string): Promise<string[]> =>
  (await listTestFiles(cwd)).filter((path) => integrationImport.test(readFileSync(join(cwd, path), "utf8")));

/** Test files that start a browser through `packages/ui/test/browser.ts` and need no `CLOUD_TEST_*` infrastructure. */
export const listBrowserFiles = async (cwd: string): Promise<string[]> =>
  (await listTestFiles(cwd)).filter((path) => {
    const source = readFileSync(join(cwd, path), "utf8");
    return browserImport.test(source) && !integrationImport.test(source);
  });

export const discoverTestSuites = async (workspaceRoot: string, options: Options = { integration: false }): Promise<TestSuite[]> => {
  const preload = ["--preload", join(workspaceRoot, "scripts", "fixtures", "test-infra.ts")];
  const browser = ["--isolate", "--conditions=browser", "--preload", join(workspaceRoot, "packages", "ui", "test", "solid-dom-preload.ts")];
  // Integration files migrate schemas and wait on brokers in their hooks; 5 s is too short on a slow runner.
  const integrationTimeout = "30000";
  const rootPackage = readPackageJson(join(workspaceRoot, "package.json"));
  const workspaces = rootPackage.workspaces?.packages ?? [];
  const suites: TestSuite[] = [];

  const behaviorCommand = (paths: string[]) => ["bun", "--no-env-file", `--cwd=${workspaceRoot}`, "test", ...preload, ...browser, ...paths];

  const add = async (name: string, cwd: string, packageCommand: string[] | null, integrationCommand: string[] | null) => {
    if (options.browser) {
      for (const file of await listBrowserFiles(cwd)) {
        const command = behaviorTest.test(file) ? behaviorCommand([join(cwd, file)]) : ["bun", "test", ...preload, file];
        suites.push({ name: `${name} ${file}`, cwd, command });
      }
      return;
    }
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
      suites.push({ name: `${name} behavior`, cwd, command: behaviorCommand(behavior.map((path) => join(cwd, path))) });
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

/** Unknown or invalid weights use the median of the table's valid measurements. */
export const suiteWeight = (name: string, table: Record<string, number>): number => {
  const valid = (value: number): boolean => Number.isFinite(value) && value >= 0;
  const weight = table[name];
  if (weight !== undefined && valid(weight)) return weight;
  const values = Object.values(table)
    .filter(valid)
    .sort((a, b) => a - b);
  if (values.length === 0) return 1;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle]! : values[middle - 1]! / 2 + values[middle]! / 2;
};

/** Longest processing time first, with stable membership and discovery order inside each shard. */
export const planShards = (
  suites: TestSuite[],
  total: number,
  table: Record<string, number>,
): { suites: TestSuite[]; seconds: number }[] => {
  const shards: { suites: TestSuite[]; seconds: number }[] = Array.from({ length: total }, () => ({ suites: [], seconds: 0 }));
  const assignments: number[] = [];
  const counts = Array.from({ length: total }, () => 0);
  const weighted = suites.map((suite, position) => ({ suite, position, seconds: suiteWeight(suite.name, table) }));
  weighted.sort((a, b) => b.seconds - a.seconds || (a.suite.name < b.suite.name ? -1 : a.suite.name > b.suite.name ? 1 : 0));
  for (const entry of weighted) {
    let target = 0;
    for (let index = 1; index < shards.length; index += 1) {
      if (
        shards[index]!.seconds < shards[target]!.seconds ||
        (shards[index]!.seconds === shards[target]!.seconds && counts[index]! < counts[target]!)
      )
        target = index;
    }
    assignments[entry.position] = target;
    shards[target]!.seconds += entry.seconds;
    counts[target]! += 1;
  }
  for (const [position, suite] of suites.entries()) shards[assignments[position]!]!.suites.push(suite);
  return shards;
};

export const selectSuites = (
  suites: TestSuite[],
  options: Options,
  workspaceRoot: string,
  weights: TestWeights = committedWeights,
): TestSuite[] => {
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
    selected = planShards(selected, total, options.integration ? weights.integration : options.browser ? weights.browser : weights.unit)[
      index - 1
    ]!.suites;
  }
  return selected;
};

export const parseArgs = (argv: string[]): Options => {
  const options: Options = { integration: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--integration") options.integration = true;
    else if (arg === "--browser") options.browser = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--filter") options.filter = argv[++i];
    else if (arg === "--exclude") options.exclude = argv[++i];
    else if (arg === "--shard") {
      const match = /^(\d+)\/(\d+)$/.exec(argv[++i] ?? "");
      const index = Number(match?.[1]);
      const total = Number(match?.[2]);
      if (!match || index < 1 || index > total) throw new Error(`--shard expects i/n with 1 <= i <= n, got "${argv[i]}"`);
      options.shard = { index, total };
    } else if (arg === "--max-minutes") {
      const value = argv[++i];
      const minutes = Number(value);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error(`--max-minutes expects a positive number of minutes, got "${value}"`);
      }
      options.maxMinutes = minutes;
    } else throw new Error(`unknown argument "${arg}"`);
  }
  if (options.filter === undefined && argv.includes("--filter")) throw new Error("--filter expects a workspace substring");
  return options;
};

/** Stop a timed-out suite and its descendants before GitHub cancels the job without a runner error. */
export const runTestCommand = async (suite: TestSuite, env: Record<string, string | undefined>, timeoutMs?: number): Promise<number> => {
  if (timeoutMs !== undefined && timeoutMs <= 0) throw new Error("test run exceeded its time budget");
  const grouped = timeoutMs !== undefined && process.platform !== "win32";
  const child = Bun.spawn(suite.command, {
    cwd: suite.cwd,
    env,
    detached: grouped,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (timeoutMs === undefined) return child.exited;
  let expired = false;
  let interrupted: "SIGINT" | "SIGTERM" | undefined;
  let force: ReturnType<typeof setTimeout> | undefined;
  // Playwright starts browsers in their own sessions. Remember descendants before
  // signalling the suite, since they can be reparented as soon as it exits.
  // lstart prevents a recycled PID from becoming a cleanup target.
  const descendants = new Map<number, string>();
  const kill = (signal: NodeJS.Signals) => {
    if (!grouped) {
      child.kill(signal);
      return;
    }
    const result = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,lstart="], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`Cannot inspect test descendants: ${result.stderr.toString()}`);
    const processes = result.stdout
      .toString()
      .trim()
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        return match ? [{ pid: Number(match[1]), parent: Number(match[2]), started: match[3]! }] : [];
      });
    const leader = processes.find((entry) => entry.pid === child.pid);
    if (leader && (!descendants.has(child.pid) || descendants.get(child.pid) === leader.started)) {
      const pending = [child.pid];
      for (const pid of pending) {
        const entry = processes.find((entry) => entry.pid === pid);
        if (entry) descendants.set(pid, entry.started);
        pending.push(...processes.filter((entry) => entry.parent === pid).map((entry) => entry.pid));
      }
    }
    for (const [pid, started] of [...descendants].reverse()) {
      if (!processes.some((entry) => entry.pid === pid && entry.started === started)) continue;
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
  };
  const stop = (signal: NodeJS.Signals) => {
    kill(signal);
    force ??= setTimeout(() => kill("SIGKILL"), 5_000);
  };
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    interrupted = signal;
    stop(signal);
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  const timer = setTimeout(() => {
    expired = true;
    console.error(
      `::error title=Test shard over its time limit::Time budget exhausted during ${suite.name}; stopping the suite and its descendants`,
    );
    stop("SIGTERM");
  }, timeoutMs);
  try {
    const code = await child.exited;
    if (expired || interrupted) {
      // The direct child can exit before a descendant that ignored SIGTERM.
      kill("SIGKILL");
      throw new Error(interrupted ? `test run interrupted by ${interrupted}` : "test run exceeded its time budget");
    }
    return code;
  } finally {
    clearTimeout(timer);
    clearTimeout(force);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
};

const run = async (): Promise<void> => {
  const options = parseArgs(Bun.argv.slice(2));
  if (!options.list) runUnderHeavyLock();
  const started = performance.now();
  const workspaceRoot = join(import.meta.dir, "..");
  if (options.integration && !options.list && !hasIntegrationTarget()) {
    console.error("--integration needs at least one CLOUD_TEST_* variable (see scripts/fixtures/test-infra.ts).");
    process.exit(2);
  }

  const suites = await discoverTestSuites(workspaceRoot, options);
  if (options.list) {
    for (const suite of suites) console.log(suite.name);
    return;
  }
  const label = options.shard ? `shard ${options.shard.index}/${options.shard.total}` : "test run";
  if (options.shard) {
    const table = options.integration ? committedWeights.integration : options.browser ? committedWeights.browser : committedWeights.unit;
    const seconds = suites.reduce((sum, suite) => sum + suiteWeight(suite.name, table), 0);
    console.log(`${label}: ${suites.length} suites, about ${(seconds / 60).toFixed(1)} min by scripts/test-weights.json`);
  }
  // An empty browser run would pass while WebKit tested nothing, for example after the launcher moved.
  if (options.browser && suites.length === 0) {
    console.error("--browser selected no test file that imports packages/ui/test/browser.");
    process.exit(2);
  }
  const preload = `--preload=${join(workspaceRoot, "scripts", "fixtures", "test-infra.ts")}`;
  const envFile = dotenvLeak(process.cwd(), process.execArgv);
  if (envFile) {
    console.error(
      `The test runner started without --no-env-file next to ${envFile}; start it with \`bun run test\` so tests never see development values.`,
    );
    process.exit(2);
  }
  const env: Record<string, string | undefined> = { ...Bun.env, BUN_OPTIONS: [Bun.env.BUN_OPTIONS, noEnvFile].filter(Boolean).join(" ") };
  applyTestRuntimeEnv(env);
  const failed: string[] = [];

  const remainingMs = () => (options.maxMinutes === undefined ? undefined : options.maxMinutes * 60_000 - (performance.now() - started));

  const natsTarget = readTestTarget(process.env, "nats");
  if (natsTarget) {
    console.log("\n=== integration NATS housekeeping ===");
    const code = await runTestCommand(
      {
        name: "integration NATS housekeeping",
        cwd: workspaceRoot,
        command: ["bun", join(workspaceRoot, "scripts", "fixtures", "test-sync.ts")],
      },
      env,
      remainingMs(),
    );
    if (code !== 0) throw new Error("integration NATS housekeeping failed");
  }

  if (options.integration && process.env.CLOUD_TEST_DATABASE_URL) {
    console.log("\n=== integration database bootstrap ===");
    const bootstrap = await runTestCommand(
      {
        name: "integration database bootstrap",
        cwd: workspaceRoot,
        command: ["bun", join(workspaceRoot, "scripts", "fixtures", "integration-bootstrap.ts")],
      },
      env,
      remainingMs(),
    );
    if (bootstrap !== 0) {
      console.error("integration database bootstrap failed");
      process.exit(1);
    }
  }

  for (const suite of suites) {
    console.log(`\n=== ${suite.name} ===`);
    const started = performance.now();
    const code = await runTestCommand(
      suite,
      suite.command[1] === "run" ? { ...env, BUN_OPTIONS: [env.BUN_OPTIONS, preload].filter(Boolean).join(" ") } : env,
      remainingMs(),
    );
    if (code !== 0) failed.push(suite.name);
    console.log(`=== ${suite.name}: ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }

  if (!options.integration && !options.browser && !hasIntegrationTarget()) {
    let skipped = 0;
    for (const suite of suites) skipped += (await listIntegrationFiles(suite.cwd)).length;
    console.log(`\n${skipped} integration test file(s) skipped: no CLOUD_TEST_* variable is set.`);
  }

  const minutes = (performance.now() - started) / 60_000;
  const limit = options.maxMinutes === undefined ? "" : ` (limit ${options.maxMinutes} min)`;
  console.log(`\n${label} took ${minutes.toFixed(1)} min${limit}`);
  const overLimit = options.maxMinutes !== undefined && minutes > options.maxMinutes;
  if (overLimit) {
    console.log(
      `::error title=Test shard over its time limit::${label} took ${minutes.toFixed(1)} min, over its ${options.maxMinutes}-min limit; refresh scripts/test-weights.json with \`bun scripts/test-weights.ts --run <id>\` or add a shard`,
    );
  }
  if (failed.length > 0) {
    console.error(`\nFailed test suites (${failed.length}): ${failed.join(", ")}`);
    process.exit(1);
  }
  if (overLimit) process.exit(1);

  console.log(`\nAll ${suites.length} test suites passed.`);
};

if (import.meta.main) await run();
