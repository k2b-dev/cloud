import { describe, expect, test } from "bun:test";
import { withLeaseHeartbeat } from "./lease-heartbeat";

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
    const deadlineError = new Error("operation deadline passed");
    let beats = 0;
    let beatsAtAbort = -1;
    let observedReason: unknown;
    await expect(
      withLeaseHeartbeat({
        intervalMs: 5,
        heartbeat: async () => {
          beats += 1;
        },
        deadline: { ms: 20, error: () => deadlineError },
        work: async (assertLeaseActive, signal) => {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          observedReason = signal.reason;
          beatsAtAbort = beats;
          // Cleanup that spans several heartbeat intervals must not renew the lease.
          await Bun.sleep(30);
          await assertLeaseActive();
          return "late result";
        },
      }),
    ).rejects.toBe(deadlineError);
    expect(observedReason).toBe(deadlineError);
    expect(beatsAtAbort).toBeGreaterThanOrEqual(1);
    expect(beats).toBe(beatsAtAbort);
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
