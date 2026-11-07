import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverTestSuites, planShards, suiteWeight, type TestSuite, type TestWeights } from "./run-tests";

/** Read only completed suite timing lines, keeping the slowest observation of each suite. */
export const parseSuiteTimes = (log: string): Map<string, number> => {
  const times = new Map<string, number>();
  const timing = /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z )?=== (.+): (\d+(?:\.\d+)?)s$/;
  for (const line of log.split(/\r?\n/)) {
    const match = timing.exec(line);
    if (!match) continue;
    const name = match[1]!;
    const seconds = Number(match[2]);
    if (Number.isFinite(seconds)) times.set(name, Math.max(times.get(name) ?? 0, seconds));
  }
  return times;
};

const github = (args: string[]): string => {
  const result = Bun.spawnSync(["gh-agent", "api", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`gh-agent api failed: ${result.stderr.toString().trim() || "could not fetch workflow data"}`);
  return result.stdout.toString();
};

const modes = ["browser", "unit", "integration"] as const;

/** Failed jobs still measured completed suites; an aborted tail is not a complete observation. */
export const collectJobTimes = (
  jobs: unknown[],
  readLog: (id: number) => string,
  selectedModes: readonly (keyof TestWeights)[] = modes,
) => {
  const times = { browser: new Map<string, number>(), unit: new Map<string, number>(), integration: new Map<string, number>() };
  for (const job of jobs) {
    if (typeof job !== "object" || job === null || !("name" in job) || typeof job.name !== "string") {
      throw new Error("malformed job response");
    }
    const mode = jobMode(job.name);
    if (!mode || !selectedModes.includes(mode)) continue;
    if ("conclusion" in job && job.conclusion === "skipped") continue;
    if (
      !("conclusion" in job) ||
      typeof job.conclusion !== "string" ||
      !["success", "failure", "timed_out", "cancelled"].includes(job.conclusion)
    ) {
      throw new Error(`${job.name}: expected success, failure, timed_out, or cancelled before importing measurements`);
    }
    if (!("id" in job) || typeof job.id !== "number" || !Number.isSafeInteger(job.id) || job.id <= 0) {
      throw new Error(`${job.name}: invalid job id`);
    }
    for (const [name, seconds] of parseSuiteTimes(readLog(job.id))) {
      times[mode].set(name, Math.max(times[mode].get(name) ?? 0, seconds));
    }
  }
  return times;
};

/** Replace measured suites with this window's maxima; keep the unexecuted tail and prune deleted suites. */
export const refreshSuiteWeights = (suites: TestSuite[], previous: Record<string, number>, times: Map<string, number>) =>
  Object.fromEntries(
    suites
      .filter((suite) => times.has(suite.name) || previous[suite.name] !== undefined)
      .map((suite) => [suite.name, times.get(suite.name) ?? previous[suite.name]!] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, seconds]) => [name, Math.round(seconds * 10) / 10] as const),
  );

/** Both the old single integration job and the matrix jobs use the integration table. */
export const jobMode = (name: string): keyof TestWeights | undefined => {
  const match = /^(unit|webkit|integration)(?: \(\d+\))?$/.exec(name);
  return match ? (match[1] === "webkit" ? "browser" : match[1] === "integration" ? "integration" : "unit") : undefined;
};

/** A shard cannot split a suite, even when more runners are available. */
export const recommendShardCount = (suites: TestSuite[], table: Record<string, number>): number | undefined => {
  if (suites.some((suite) => suiteWeight(suite.name, table) > 15 * 60)) return undefined;
  for (let total = 1; total <= suites.length; total += 1) {
    if (planShards(suites, total, table).every((shard) => shard.seconds <= 15 * 60)) return total;
  }
  return undefined;
};

const run = async (): Promise<void> => {
  const args = Bun.argv.slice(2);
  if (args.includes("--help")) {
    console.log(`Refresh measured test suite times from finished CI jobs.

Usage: bun scripts/test-weights.ts --run <id> [<id>...] [--mode browser|unit|integration]
       bun scripts/test-weights.ts --run <id> --run <id>

Include slow and failed runs, not only green runs. Requires gh-agent authentication.
Writes scripts/test-weights.json with the maximum seconds per suite in the selected runs, retaining
previous measurements when the selected runs have no complete observation. Only
completed suites count; an interrupted suite's runtime is a lower bound.
Plans the current checkout, excluding Grids from integration, and prints the
smallest shard count at or below 15 minutes (half the 30-minute job limit).`);
    return;
  }
  let selectedModes: readonly (keyof TestWeights)[] = modes;
  const runs: string[] = [];
  let hasRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--mode") {
      const mode = args[++index];
      const selected = modes.find((candidate) => candidate === mode);
      if (!selected) throw new Error("--mode expects browser, unit, or integration");
      selectedModes = [selected];
    } else if (arg === "--run") {
      if (!/^\d+$/.test(args[index + 1] ?? "")) throw new Error("--run expects a workflow run id");
      hasRun = true;
    } else if (hasRun && /^\d+$/.test(arg)) runs.push(arg);
    else throw new Error(`unexpected argument "${arg}"; use --help for usage`);
  }
  if (runs.length === 0) throw new Error("provide --run <id> [<id>...]; use --help for usage");

  const times = { browser: new Map<string, number>(), unit: new Map<string, number>(), integration: new Map<string, number>() };
  for (const id of runs) {
    // @json yields one JSON object per line, including when --paginate fetches several pages.
    const jobs = github([
      "--paginate",
      `repos/k2b-dev/cloud/actions/runs/${id}/jobs?per_page=100`,
      "--jq",
      ".jobs[] | {id, name, conclusion} | @json",
    ]);
    let observed: ReturnType<typeof collectJobTimes>;
    try {
      observed = collectJobTimes(
        jobs
          .split("\n")
          .filter((line) => line.trim())
          .map((line): unknown => JSON.parse(line)),
        (jobId) => github([`repos/k2b-dev/cloud/actions/jobs/${jobId}/logs`]),
        selectedModes,
      );
    } catch (error) {
      throw new Error(`run ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const mode of selectedModes) {
      for (const [name, seconds] of observed[mode]) {
        times[mode].set(name, Math.max(times[mode].get(name) ?? 0, seconds));
      }
    }
  }
  for (const mode of selectedModes) {
    if (times[mode].size === 0) throw new Error(`no ${mode} suite times found; refusing to write scripts/test-weights.json`);
  }
  const weights: TestWeights = JSON.parse(readFileSync(new URL("./test-weights.json", import.meta.url), "utf8"));
  for (const mode of selectedModes) {
    const suites = await discoverTestSuites(join(import.meta.dir, ".."), {
      integration: mode === "integration",
      browser: mode === "browser",
      exclude: mode === "integration" ? "grids" : undefined,
    });
    weights[mode] = refreshSuiteWeights(suites, weights[mode], times[mode]);
    console.log(`\n${mode}: predicted slowest shard`);
    if (suites.length === 0) {
      console.log("  No suites selected in the current checkout.");
      continue;
    }
    const smallest = recommendShardCount(suites, weights[mode]);
    if (smallest === undefined) {
      console.log("  No fitting matrix; split any suite above 15 min before adding shards.");
      continue;
    }
    for (let total = 1; total <= smallest; total += 1) {
      const minutes = Math.max(...planShards(suites, total, weights[mode]).map((shard) => shard.seconds)) / 60;
      console.log(`  ${total} shard(s): ${minutes.toFixed(1)} min`);
    }
    console.log(`  Smallest count at or below 15 min (half the 30-minute job limit): ${smallest}`);
  }
  writeFileSync(new URL("./test-weights.json", import.meta.url), `${JSON.stringify(weights, null, 2)}\n`);
  console.log("\nWrote scripts/test-weights.json");
};

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    console.error(`test-weights: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
