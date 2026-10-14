import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { hasIntegrationTarget } from "./fixtures/test-infra-env";

/**
 * Heavy local runs (`bun run check`, `bun run test`, `scripts/heavy.ts`) share
 * CLOUD_HEAVY_SLOTS slots per machine (default 1). Parallel sessions in several
 * worktrees otherwise start dozens of type checkers and browsers at once and
 * exhaust the machine's memory. Each slot is one `flock` file in the temp
 * directory: cloud-heavy-run.lock, cloud-heavy-run.1.lock, …
 * A run whose environment sets a CLOUD_TEST_* target always takes slot 0,
 * so such runs serialize with each other and with the legacy flock form.
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

export const chooseSlot = (
  slots: number,
  pid: number,
  isFree: (slot: number) => boolean,
  sharesTestTargets: boolean,
): { slot: number; wait: boolean } => {
  if (sharesTestTargets) return { slot: 0, wait: !isFree(0) };
  for (let slot = slots - 1; slot >= 0; slot--) if (isFree(slot)) return { slot, wait: false };
  return { slot: pid % slots, wait: true };
};

const needsSlot = (): boolean => !process.env.CI && process.env.CLOUD_HEAVY_LOCK !== "held" && Bun.which("flock") !== null;

const runCommand = (command: string[], env = process.env): number => {
  try {
    const child = spawnSync(command, { stdio: ["inherit", "inherit", "inherit"], env });
    return child.exitCode ?? (child.signalCode ? 128 + constants.signals[child.signalCode] : 1);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    console.error(`heavy.ts: command not found: ${command[0]}`);
    return 127;
  }
};

export const runInHeavySlot = (command: string[]): number => {
  if (!needsSlot()) return runCommand(command);
  const slots = heavySlots();
  const sharesTestTargets = hasIntegrationTarget(process.env);
  const { slot, wait } = chooseSlot(
    slots,
    process.pid,
    (slot) => spawnSync(["flock", "-n", slotLock(slot), "true"]).exitCode === 0,
    sharesTestTargets,
  );
  const lock = slotLock(slot);
  if (wait)
    console.error(
      slots === 1
        ? `Waiting for another check or test run on this machine to finish (${lock})…`
        : sharesTestTargets
          ? `Waiting for the first slot because integration runs share test targets (${lock})…`
          : `Waiting for one of ${slots} heavy check or test runs on this machine to finish (${lock})…`,
    );
  // Probing and locking are not atomic: if another run takes the slot, we wait.
  // A waiter is pinned to one slot, so another may free up first; accepted for simplicity.
  // The kernel releases a dead process's flock when its descriptor closes.
  return runCommand(["flock", lock, ...command], { ...process.env, CLOUD_HEAVY_LOCK: "held" });
};

export const runUnderHeavyLock = (): void => {
  if (!needsSlot()) return;
  process.exit(runInHeavySlot([process.execPath, ...process.execArgv, ...process.argv.slice(1)]));
};
