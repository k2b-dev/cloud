import { describe, expect, jest, test } from "bun:test";
import { withLeaseHeartbeat } from "./lease-heartbeat";

// Lets heartbeat and work continuations queued by fired timers run.
const flushMicrotasks = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

const advance = async (ms: number): Promise<void> => {
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
};

describe("mail job lease heartbeat", () => {
  test("renews a lease while work is running", async () => {
    let beats = 0;
    const result = await withLeaseHeartbeat({
      intervalMs: 5,
      heartbeat: async () => {
        beats += 1;
      },
      work: async () => {
        await Bun.sleep(18);
        return "done";
      },
    });

    expect(result).toBe("done");
    expect(beats).toBeGreaterThanOrEqual(1);
  });

  test("surfaces a failed heartbeat before work starts", async () => {
    const leaseError = new Error("lease lost");
    await expect(
      withLeaseHeartbeat({
        intervalMs: 5,
        heartbeat: async () => {
          throw leaseError;
        },
        work: async () => undefined,
      }),
    ).rejects.toBe(leaseError);
  });

  test("blocks provider work when the lease cannot be renewed", async () => {
    let sideEffectStarted = false;
    await expect(
      withLeaseHeartbeat({
        intervalMs: 10,
        heartbeat: async () => {
          throw new Error("lease lost");
        },
        work: async (assertLeaseActive) => {
          await assertLeaseActive();
          sideEffectStarted = true;
        },
      }),
    ).rejects.toThrow("lease lost");
    expect(sideEffectStarted).toBe(false);
  });

  test("aborts active provider work when a later heartbeat loses the lease", async () => {
    const leaseError = new Error("lease lost during provider work");
    let beats = 0;
    let observedReason: unknown;
    await expect(
      withLeaseHeartbeat({
        intervalMs: 5,
        heartbeat: async () => {
          beats += 1;
          if (beats > 1) throw leaseError;
        },
        work: async (_assertLeaseActive, signal) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                observedReason = signal.reason;
                resolve();
              },
              { once: true },
            );
          });
        },
      }),
    ).rejects.toBe(leaseError);
    expect(observedReason).toBe(leaseError);
  });

  test("cancels overdue work and stops renewing its lease during cleanup", async () => {
    jest.useFakeTimers();
    try {
      const deadlineError = new Error("operation deadline passed");
      let beats = 0;
      let beatsAtAbort = -1;
      let observedReason: unknown;
      let finishCleanup = (): void => undefined;
      const cleanup = new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      const outcome = withLeaseHeartbeat({
        intervalMs: 1_000,
        heartbeat: async () => {
          beats += 1;
        },
        deadline: { ms: 2_500, error: () => deadlineError },
        work: async (assertLeaseActive, signal) => {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          observedReason = signal.reason;
          beatsAtAbort = beats;
          await cleanup;
          await assertLeaseActive();
          return "late result";
        },
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );

      // The first renewal, then one per interval until the deadline.
      await flushMicrotasks();
      await advance(1_000);
      await advance(1_000);
      await advance(500);
      expect(observedReason).toBe(deadlineError);
      expect(beatsAtAbort).toBe(3);

      // Cleanup that spans several heartbeat intervals must not renew the lease.
      await advance(5_000);
      expect(beats).toBe(beatsAtAbort);

      finishCleanup();
      expect(await outcome).toEqual({ error: deadlineError });
    } finally {
      jest.useRealTimers();
    }
  });

  test("keeps the result of work that passed its commit point before the deadline", async () => {
    jest.useFakeTimers();
    try {
      let beats = 0;
      let passedCommitPoint = (): void => undefined;
      const commitPoint = new Promise<void>((resolve) => {
        passedCommitPoint = resolve;
      });
      const outcome = withLeaseHeartbeat({
        intervalMs: 1_000,
        heartbeat: async () => {
          beats += 1;
        },
        deadline: { ms: 1_500, error: () => new Error("operation deadline passed") },
        work: async (_assertLeaseActive, signal) => {
          signal.throwIfAborted();
          passedCommitPoint();
          // The commit is still running when the deadline passes.
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return "committed";
        },
      });

      await commitPoint;
      await advance(1_000);
      await advance(500);
      expect(await outcome).toBe("committed");
      expect(beats).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("returns work that finishes before its deadline", async () => {
    let signal: AbortSignal | undefined;
    const result = await withLeaseHeartbeat({
      intervalMs: 5,
      heartbeat: async () => undefined,
      deadline: { ms: 1_000, error: () => new Error("deadline passed") },
      work: async (_assertLeaseActive, workSignal) => {
        signal = workSignal;
        return "done";
      },
    });
    expect(result).toBe("done");
    expect(signal?.aborted).toBe(false);
  });
});
