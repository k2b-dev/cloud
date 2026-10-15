import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseSlot, heavySlots, slotLock } from "./heavy-lock";

describe("heavy-run slots", () => {
  test("defaults to one slot and accepts positive integers", () => {
    const previous = process.env.CLOUD_HEAVY_SLOTS;
    delete process.env.CLOUD_HEAVY_SLOTS;
    try {
      expect(heavySlots(undefined)).toBe(1);
      for (const value of ["", "  ", "1"]) expect(heavySlots(value)).toBe(1);
      expect(heavySlots("3")).toBe(3);
      expect(heavySlots(" 4 ")).toBe(4);
    } finally {
      if (previous === undefined) delete process.env.CLOUD_HEAVY_SLOTS;
      else process.env.CLOUD_HEAVY_SLOTS = previous;
    }
  });

  test("rejects invalid slot counts loudly", () => {
    for (const value of ["0", "-1", "2.5", "abc", "3x"]) {
      expect(() => heavySlots(value)).toThrow("CLOUD_HEAVY_SLOTS");
      expect(() => heavySlots(value)).toThrow(value);
      expect(() => heavySlots(value)).toThrow("positive integer");
    }
  });

  test("preserves the original lock path for slot zero", () => {
    expect(slotLock(0, "/isolated")).toBe("/isolated/cloud-heavy-run.lock");
    expect(slotLock(2, "/isolated")).toBe("/isolated/cloud-heavy-run.2.lock");
  });

  test("takes the highest free slot and stops probing", () => {
    const probed: number[] = [];
    expect(
      chooseSlot(
        4,
        7,
        (slot) => {
          probed.push(slot);
          return slot >= 1;
        },
        false,
      ),
    ).toEqual({ slot: 3, wait: false });
    expect(probed).toEqual([3]);
    expect(chooseSlot(3, 7, () => true, false)).toEqual({ slot: 2, wait: false });
    expect(chooseSlot(3, 7, (slot) => slot === 0, false)).toEqual({ slot: 0, wait: false });
  });

  test("spreads waiters over busy slots by pid", () => {
    for (const pid of [6, 7, 8, 19]) {
      const probed: number[] = [];
      expect(
        chooseSlot(
          3,
          pid,
          (slot) => {
            probed.push(slot);
            return false;
          },
          false,
        ),
      ).toEqual({ slot: pid % 3, wait: true });
      expect(probed).toEqual([2, 1, 0]);
    }
    expect(chooseSlot(1, 17, () => false, false)).toEqual({ slot: 0, wait: true });
  });

  test("pins runs sharing test targets to slot zero and probes only that slot", () => {
    for (const free of [true, false]) {
      const probed: number[] = [];
      expect(
        chooseSlot(
          4,
          7,
          (slot) => {
            probed.push(slot);
            return slot === 0 ? free : true;
          },
          true,
        ),
      ).toEqual({ slot: 0, wait: !free });
      expect(probed).toEqual([0]);
    }
  });
});

const heavy = join(import.meta.dir, "heavy.ts");
const spawn = (command: string[], env: NodeJS.ProcessEnv) =>
  Bun.spawn([process.execPath, "--no-env-file", heavy, ...command], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    detached: true,
  });

const waitFor = async (condition: () => boolean, deadline: number) => {
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for heavy-run signal");
    await Bun.sleep(10);
  }
};

describe("heavy command processes", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const children: ReturnType<typeof spawn>[] = [];
  const start = (command: string[], overrides: NodeJS.ProcessEnv = {}) => {
    const child = spawn(command, { ...env, ...overrides });
    children.push(child);
    return child;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cloud-heavy-slots-"));
    env = { ...process.env, TMPDIR: dir, CLOUD_HEAVY_SLOTS: "2" };
    delete env.CI;
    delete env.CLOUD_HEAVY_LOCK;
    for (const key of Object.keys(env)) if (key.startsWith("CLOUD_TEST_")) delete env[key];
  });

  afterEach(async () => {
    try {
      for (const child of children) {
        // Kill the process group, including flock and its command, on failure too.
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
      await Promise.all(children.map((child) => child.exited));
    } finally {
      children.length = 0;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!Bun.which("flock"))(
    "runs two commands together and waits for a slot before starting a third",
    async () => {
      // Generous deadline: three Bun starts on a loaded machine must not fail the test.
      const deadline = performance.now() + 20_000;
      const release = join(dir, "release");
      const aStarted = join(dir, "a.started");
      const bStarted = join(dir, "b.started");
      const cStarted = join(dir, "c.started");
      const hold = 'touch "$0"; while [ ! -e "$1" ]; do sleep 0.05; done';
      const a = start(["sh", "-c", hold, aStarted, release]);
      // Let A hold its slot before B probes, avoiding the documented probe race.
      await waitFor(() => existsSync(aStarted), deadline);
      const b = start(["sh", "-c", hold, bStarted, release]);
      await waitFor(() => existsSync(aStarted) && existsSync(bStarted), deadline);
      expect(existsSync(slotLock(0, dir))).toBeTrue();
      expect(existsSync(slotLock(1, dir))).toBeTrue();

      const c = start(["sh", "-c", 'touch "$0"', cStarted]);
      let stderr = "";
      const output = (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of c.stderr) stderr += decoder.decode(chunk, { stream: true });
      })();
      await waitFor(() => stderr.includes("Waiting for one of 2"), deadline);
      expect(existsSync(cStarted)).toBeFalse();

      writeFileSync(release, "");
      await waitFor(() => [a, b, c].every((child) => child.exitCode !== null), deadline);
      expect(await Promise.all([a.exited, b.exited, c.exited])).toEqual([0, 0, 0]);
      await output;
      expect(existsSync(cStarted)).toBeTrue();
    },
    30_000,
  );

  test.skipIf(!Bun.which("flock"))(
    "serializes integration runs while a non-integration run uses the other slot",
    async () => {
      const deadline = performance.now() + 20_000;
      const release = join(dir, "release");
      const aStarted = join(dir, "a.started");
      const aFinished = join(dir, "a.finished");
      const bStarted = join(dir, "b.started");
      const cStarted = join(dir, "c.started");
      const targets = { CLOUD_TEST_VALKEY_URL: "redis://127.0.0.1:1" };
      const a = start(
        ["sh", "-c", 'touch "$0"; while [ ! -e "$1" ]; do sleep 0.05; done; touch "$2"', aStarted, release, aFinished],
        targets,
      );
      await waitFor(() => existsSync(aStarted), deadline);
      const b = start(["sh", "-c", 'test -e "$1" && touch "$0"', bStarted, aFinished], targets);
      let stderr = "";
      const output = (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of b.stderr) stderr += decoder.decode(chunk, { stream: true });
      })();
      await waitFor(() => stderr.includes("Waiting for the first slot because integration runs share test targets"), deadline);
      expect(existsSync(bStarted)).toBeFalse();

      const c = start(["sh", "-c", 'touch "$0"', cStarted]);
      await waitFor(() => c.exitCode !== null, deadline);
      expect(await c.exited).toBe(0);
      expect(existsSync(cStarted)).toBeTrue();
      expect(existsSync(slotLock(1, dir))).toBeTrue();
      expect(a.exitCode).toBeNull();
      expect(b.exitCode).toBeNull();
      expect(existsSync(bStarted)).toBeFalse();
      expect(existsSync(aFinished)).toBeFalse();

      writeFileSync(release, "");
      await waitFor(() => [a, b].every((child) => child.exitCode !== null), deadline);
      expect(await Promise.all([a.exited, b.exited])).toEqual([0, 0]);
      await output;
      expect(existsSync(bStarted)).toBeTrue();
    },
    30_000,
  );

  test.skipIf(!Bun.which("flock"))(
    "preserves the command's exit code and marks children as held",
    async () => {
      expect(await start(["sh", "-c", "exit 3"]).exited).toBe(3);
      expect(await start(["sh", "-c", 'test "$CLOUD_HEAVY_LOCK" = held']).exited).toBe(0);
      expect(existsSync(slotLock(1, dir))).toBeTrue();
    },
    30_000,
  );

  test("bypasses slots in CI, when held, or without flock, preserving the environment", async () => {
    for (const overrides of [{ CI: "1" }, { CLOUD_HEAVY_LOCK: "held" }, { PATH: dir }]) {
      const expected = overrides.CLOUD_HEAVY_LOCK ?? "";
      expect(
        await start(["/bin/sh", "-c", 'test "$CLOUD_HEAVY_LOCK" = "$0"', expected], {
          ...overrides,
          CLOUD_HEAVY_SLOTS: "invalid",
        }).exited,
      ).toBe(0);
    }
    expect(readdirSync(dir)).toEqual([]);
  }, 30_000);

  test("refuses a dotenv leak when started without --no-env-file", () => {
    writeFileSync(join(dir, ".env"), "HEAVY_LEAK=leaked\n");
    // `bun run test` passes --no-env-file to every process through BUN_OPTIONS;
    // drop it so this child really starts without the flag.
    const { BUN_OPTIONS: _, ...withoutOptions } = env;
    const child = Bun.spawnSync([process.execPath, heavy, "sh", "-c", 'test -z "$HEAVY_LEAK"'], {
      cwd: dir,
      env: withoutOptions,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(2);
    expect(child.stderr.toString()).toContain("--no-env-file");
    expect(child.stderr.toString()).toContain(join(dir, ".env"));
  }, 30_000);

  test("returns shell exit codes for a missing command and a signal on every path", async () => {
    for (const overrides of [{ CI: "1" }, {}]) {
      const missing = start(["cloud-heavy-missing-command"], overrides);
      const stderr = new Response(missing.stderr).text();
      expect(await missing.exited).toBe(127);
      expect(await stderr).toBe("heavy.ts: command not found: cloud-heavy-missing-command\n");
    }
    expect(readdirSync(dir)).toEqual([]);
    for (const overrides of [{ CI: "1" }, {}]) {
      expect(await start(["sh", "-c", "kill -TERM $$"], overrides).exited).toBe(143);
    }
  }, 30_000);
});

test("heavy command help and missing arguments", () => {
  for (const flag of ["--help", "-h"]) {
    const child = Bun.spawnSync([process.execPath, "--no-env-file", heavy, flag]);
    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain("CLOUD_HEAVY_SLOTS");
    expect(child.stderr.toString()).toBe("");
  }
  const child = Bun.spawnSync([process.execPath, "--no-env-file", heavy]);
  expect(child.exitCode).toBe(2);
  expect(child.stderr.toString()).toContain("Usage:");
  expect(child.stdout.toString()).toBe("");
}, 30_000);
