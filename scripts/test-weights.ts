import { readFileSync, writeFileSync } from "node:fs";
import { planShards, type TestSuite, type TestWeights } from "./run-tests";

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

const gh = (args: string[]): string => {
  const result = Bun.spawnSync(["gh", "api", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`gh api failed: ${result.stderr.toString().trim() || "could not fetch workflow data"}`);
  return result.stdout.toString();
};

const modes = ["browser", "unit", "integration"] as const;

/** Both the old single integration job and the matrix jobs use the integration table. */
export const jobMode = (name: string): keyof TestWeights | undefined => {
  const match = /^(unit|webkit|integration)(?: \(\d+\))?$/.exec(name);
  return match ? (match[1] === "webkit" ? "browser" : match[1] === "integration" ? "integration" : "unit") : undefined;
};

const run = (): void => {
  const args = Bun.argv.slice(2);
  if (args.includes("--help")) {
    console.log(`Refresh measured test suite times from successful CI jobs.

Usage: bun scripts/test-weights.ts --run <id> [<id>...] [--mode browser|unit|integration]
       bun scripts/test-weights.ts --run <id> --run <id>

Use the three newest green merge-queue runs. Requires gh authentication.
Writes scripts/test-weights.json with the maximum seconds per suite across runs.
Prints predicted slowest shards for 1–8 shards and the smallest count at or below
15 minutes (half the 30-minute job limit).`);
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
    const jobs = gh([
      "--paginate",
      `repos/k2b-dev/cloud/actions/runs/${id}/jobs?per_page=100`,
      "--jq",
      ".jobs[] | {id, name, conclusion} | @json",
    ]);
    for (const line of jobs.split("\n").filter((line) => line.trim())) {
      const job: unknown = JSON.parse(line);
      if (typeof job !== "object" || job === null || !("name" in job) || typeof job.name !== "string") {
        throw new Error(`run ${id}: malformed job response`);
      }
      const mode = jobMode(job.name);
      if (!mode || !selectedModes.includes(mode)) continue;
      if (!("conclusion" in job) || job.conclusion !== "success") {
        throw new Error(
          `run ${id}: ${job.name} did not succeed (conclusion: ${"conclusion" in job ? job.conclusion : "missing"}); refusing to write weights`,
        );
      }
      if (!("id" in job) || typeof job.id !== "number" || !Number.isSafeInteger(job.id) || job.id <= 0) {
        throw new Error(`run ${id}: ${job.name} has an invalid job id`);
      }
      const log = gh([`repos/k2b-dev/cloud/actions/jobs/${job.id}/logs`]);
      for (const [name, seconds] of parseSuiteTimes(log)) {
        times[mode].set(name, Math.max(times[mode].get(name) ?? 0, seconds));
      }
    }
  }
  for (const mode of selectedModes) {
    if (times[mode].size === 0) throw new Error(`no ${mode} suite times found; refusing to write scripts/test-weights.json`);
  }
  const table = (mode: keyof TestWeights): Record<string, number> =>
    Object.fromEntries(
      [...times[mode]].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, seconds]) => [name, Math.round(seconds * 10) / 10]),
    );
  const weights: TestWeights = JSON.parse(readFileSync(new URL("./test-weights.json", import.meta.url), "utf8"));
  for (const mode of selectedModes) weights[mode] = table(mode);
  writeFileSync(new URL("./test-weights.json", import.meta.url), `${JSON.stringify(weights, null, 2)}\n`);
  console.log("Wrote scripts/test-weights.json");

  for (const mode of selectedModes) {
    const suites: TestSuite[] = Object.keys(weights[mode]).map((name) => ({ name, cwd: "", command: [] }));
    let smallest: number | undefined;
    console.log(`\n${mode}: predicted slowest shard`);
    for (let total = 1; total <= 8; total += 1) {
      const minutes = Math.max(...planShards(suites, total, weights[mode]).map((shard) => shard.seconds)) / 60;
      console.log(`  ${total} shard(s): ${minutes.toFixed(1)} min`);
      if (smallest === undefined && minutes <= 15) smallest = total;
    }
    console.log(
      smallest === undefined
        ? "  No count from 1–8 fits 15 min (half the 30-minute job limit)."
        : `  Smallest count at or below 15 min (half the 30-minute job limit): ${smallest}`,
    );
  }
};

if (import.meta.main) {
  try {
    run();
  } catch (error) {
    console.error(`test-weights: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
