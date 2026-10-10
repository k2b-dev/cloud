import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";

/**
 * Runs heavy local commands (`bun run check`, `bun run test`) one at a time per
 * machine. Parallel sessions in several worktrees otherwise start dozens of
 * type checkers and browsers at once and exhaust the machine's memory.
 *
 * The current command re-runs itself under `flock` on one lock file in the
 * temp directory and waits while another heavy run holds it. CI jobs, hosts
 * without `flock` and the child itself (`CLOUD_HEAVY_LOCK=held`) skip it.
 */
export const runUnderHeavyLock = (): void => {
  if (process.env.CI || process.env.CLOUD_HEAVY_LOCK === "held" || !Bun.which("flock")) return;
  const lock = join(tmpdir(), "cloud-heavy-run.lock");
  if (spawnSync(["flock", "-n", lock, "true"]).exitCode !== 0)
    console.error(`Waiting for another check or test run on this machine to finish (${lock})…`);
  const child = spawnSync(["flock", lock, process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, CLOUD_HEAVY_LOCK: "held" },
  });
  process.exit(child.exitCode ?? 1);
};
