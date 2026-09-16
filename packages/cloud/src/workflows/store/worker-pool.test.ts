import { describe, expect, test } from "bun:test";
import { createWorkflowWorkerPool } from "./worker-pool";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("workflow worker slots", () => {
  test("a newly queued action starts while another slot is blocked, with bounded concurrency", async () => {
    const blocked = Promise.withResolvers<void>();
    const queue: Array<() => Promise<void>> = [() => blocked.promise];
    let active = 0;
    let peak = 0;
    let completed = 0;
    const errors: unknown[] = [];
    const pool = createWorkflowWorkerPool({
      concurrency: 2,
      onError: (error) => errors.push(error),
      run: async () => {
        const action = queue.shift();
        if (!action) return false;
        peak = Math.max(peak, ++active);
        try {
          await action();
          completed++;
        } finally {
          active--;
        }
        return true;
      },
    });
    pool.start();
    await flush();
    expect(active).toBe(1);
    queue.push(
      async () => {},
      async () => {},
      async () => {},
    );
    for (let i = 0; i < 30; i++) pool.wake();
    await flush();
    expect(completed).toBe(3);
    expect(active).toBe(1);
    expect(peak).toBe(2);
    blocked.resolve();
    await pool.stop();
    expect(completed).toBe(4);
    expect(errors).toEqual([]);
  });

  test("a wake racing an empty database claim is not lost", async () => {
    const claim = Promise.withResolvers<boolean>();
    let calls = 0;
    const pool = createWorkflowWorkerPool({
      concurrency: 1,
      onError: () => {},
      run: async () => {
        calls++;
        return calls === 1 ? claim.promise : false;
      },
    });
    pool.start();
    await flush();
    pool.wake();
    claim.resolve(false);
    await flush();
    expect(calls).toBe(2);
    await pool.stop();
  });

  test("stop drains an accepted action but never claims its successor", async () => {
    const action = Promise.withResolvers<boolean>();
    let calls = 0;
    const pool = createWorkflowWorkerPool({
      concurrency: 2,
      onError: () => {},
      run: async () => {
        calls++;
        return action.promise;
      },
    });
    pool.start();
    await flush();
    const stop = pool.stop();
    pool.wake();
    action.resolve(true);
    await stop;
    expect(calls).toBe(2);
    pool.start();
    await flush();
    await pool.stop();
    expect(calls).toBeGreaterThan(2);
  });

  test("database failure waits for a new wake instead of spinning", async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const pool = createWorkflowWorkerPool({
      concurrency: 1,
      onError: (error) => errors.push(error),
      run: async () => {
        calls++;
        throw new Error("database unavailable");
      },
    });
    pool.start();
    await flush();
    expect(calls).toBe(1);
    pool.wake();
    await flush();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(2);
    await pool.stop();
  });
});
