import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";

/**
 * Heavy local runs (`bun run check`, `bun run test`, `scripts/heavy.ts`) share
 * CLOUD_HEAVY_SLOTS slots per machine (default 1). Parallel sessions in several
 * worktrees otherwise start dozens of type checkers and browsers at once and
 * exhaust the machine's memory. Each slot is one `flock` file in the temp
 * directory: cloud-heavy-run.lock, cloud-heavy-run.1.lock, …
 *
 * CI jobs, hosts without `flock` and children (`CLOUD_HEAVY_LOCK=held`) skip it.
 */
export const heavySlots = (value = process.env.CLOUD_HEAVY_SLOTS): number => {
  const trimmed = value?.trim();
  if (!trimmed) return 1;
  if (!/^[1-9]\d*$/.test(trimmed)) throw new Error(`CLOUD_HEAVY_SLOTS expects a positive integer, got ${JSON.stringify(value)}`);
  return Number(trimmed);
};

export const slotLock = (slot: number, dir = tmpdir()): string =>
  join(dir, slot === 0 ? "cloud-heavy-run.lock" : `cloud-heavy-run.${slot}.lock`);

export const chooseSlot = (slots: number, pid: number, isFree: (slot: number) => boolean): { slot: number; wait: boolean } => {
  for (let slot = 0; slot < slots; slot++) if (isFree(slot)) return { slot, wait: false };
  return { slot: pid % slots, wait: true };
};

const needsSlot = (): boolean => !process.env.CI && process.env.CLOUD_HEAVY_LOCK !== "held" && Bun.which("flock") !== null;

export const runInHeavySlot = (command: string[]): number => {
  if (!needsSlot()) return spawnSync(command, { stdio: ["inherit", "inherit", "inherit"] }).exitCode ?? 1;
  const slots = heavySlots();
  const { slot, wait } = chooseSlot(slots, process.pid, (slot) => spawnSync(["flock", "-n", slotLock(slot), "true"]).exitCode === 0);
  const lock = slotLock(slot);
  if (wait)
    console.error(
      slots === 1
        ? `Waiting for another check or test run on this machine to finish (${lock})…`
        : `Waiting for one of ${slots} heavy check or test runs on this machine to finish (${lock})…`,
    );
  // Probing and locking are not atomic: if another run takes the slot, we wait.
  // The kernel releases a dead process's flock when its descriptor closes.
  const child = spawnSync(["flock", lock, ...command], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, CLOUD_HEAVY_LOCK: "held" },
  });
  return child.exitCode ?? 1;
};

export const runUnderHeavyLock = (): void => {
  if (!needsSlot()) return;
  process.exit(runInHeavySlot([process.execPath, ...process.execArgv, ...process.argv.slice(1)]));
};
