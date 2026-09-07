import { describe, expect, test } from "bun:test";
import {
  createRuntimeLifecycle,
  createRuntimeTaskTracker,
  stopRuntimeJobs,
  stopRuntimeResources,
  superviseRuntimeTask,
} from "./runtime-lifecycle";

describe("runtime lifecycle", () => {
  test("restarts failed and unexpectedly completed tasks", async () => {
    const controller = new AbortController();
    const failures: Array<{ failureCount: number; retryInMs: number; message: string }> = [];
    let attempts = 0;

    await superviseRuntimeTask({
      name: "test reader",
      signal: controller.signal,
      minRetryMs: 1,
      maxRetryMs: 2,
      resetAfterMs: 10,
      jitter: 0,
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("reader failed");
        if (attempts === 3) controller.abort();
      },
      onError: ({ error, failureCount, retryInMs }) =>
        failures.push({ failureCount, retryInMs, message: error instanceof Error ? error.message : String(error) }),
    });

    expect(attempts).toBe(3);
    expect(failures).toEqual([
      { failureCount: 1, retryInMs: 1, message: "reader failed" },
      { failureCount: 2, retryInMs: 2, message: "test reader stopped unexpectedly" },
    ]);
  });

  test("aborts a pending retry and ignores reporting failures", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const supervised = superviseRuntimeTask({
      signal: controller.signal,
      minRetryMs: 1_000,
      maxRetryMs: 1_000,
      run: async () => {
        attempts += 1;
        throw new Error("reader failed");
      },
      onError: () => {
        controller.abort();
        throw new Error("logger failed");
      },
    });

    await supervised;
    expect(attempts).toBe(1);
  });

  test("resets the backoff after a stable run", async () => {
    const controller = new AbortController();
    const failureCounts: number[] = [];
    let attempts = 0;

    await superviseRuntimeTask({
      signal: controller.signal,
      minRetryMs: 1,
      maxRetryMs: 4,
      resetAfterMs: 2,
      jitter: 0,
      run: async () => {
        attempts += 1;
        if (attempts === 2) await Bun.sleep(3);
        if (attempts === 3) controller.abort();
        else throw new Error("reader failed");
      },
      onError: ({ failureCount }) => failureCounts.push(failureCount),
    });

    expect(failureCounts).toEqual([1, 1]);
  });

  test("treats abort-driven task completion as a clean shutdown", async () => {
    const controller = new AbortController();
    let failures = 0;
    const supervised = superviseRuntimeTask({
      signal: controller.signal,
      run: (signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
      onError: () => {
        failures += 1;
      },
    });

    controller.abort();
    await supervised;

    expect(failures).toBe(0);
  });

  test("drains every in-flight task", async () => {
    const tracker = createRuntimeTaskTracker();
    const completed: string[] = [];
    tracker.open();
    tracker.run(async () => completed.push("first"));
    tracker.run(async () => {
      throw new Error("expected failure");
    });

    await tracker.drain();

    expect(completed).toEqual(["first"]);
  });

  test("rejects new work after close", async () => {
    const tracker = createRuntimeTaskTracker();
    const completed: string[] = [];
    tracker.open();
    tracker.run(async () => {
      completed.push("outer");
      tracker.run(async () => completed.push("inner"));
    });
    tracker.close();

    expect(tracker.run(async () => completed.push("late"))).toBeNull();
    await tracker.drain();

    expect(completed).toEqual(["outer"]);
  });

  test("drains until the tracked set is stable", async () => {
    const tracker = createRuntimeTaskTracker();
    const completed: string[] = [];
    tracker.open();
    tracker.run(async () => {
      await Promise.resolve();
      tracker.run(async () => completed.push("inner"));
      completed.push("outer");
    });

    await tracker.drain();

    expect(completed).toEqual(["outer", "inner"]);
  });

  test("stops workers before draining and still waits for non-worker tasks", async () => {
    const tracker = createRuntimeTaskTracker();
    const events: string[] = [];
    let finish!: () => void;
    tracker.open();
    tracker.run(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      events.push("tasks drained");
    });

    const stopping = stopRuntimeJobs(tracker, [
      {
        stop: () => void events.push("stopped"),
        drain: async () => void events.push("worker drained"),
      },
    ]);
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(events).toEqual(["stopped", "worker drained"]);
    expect(stopped).toBe(false);
    finish();
    await stopping;

    expect(events).toEqual(["stopped", "worker drained", "tasks drained"]);
  });

  test("reaches worker drain when a tracked handler waits for its abort signal", async () => {
    const tracker = createRuntimeTaskTracker();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    tracker.open();
    const task = tracker.run(
      () =>
        new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
          started.resolve();
        }),
    );
    await started.promise;
    let drainCalled = false;
    const stopping = stopRuntimeJobs(tracker, [
      {
        // Sync stops pulls here; it aborts handler signals only during drain.
        stop: () => {},
        drain: async () => {
          drainCalled = true;
          controller.abort();
        },
      },
    ]);
    try {
      await Promise.resolve();
      expect(drainCalled).toBe(true);
    } finally {
      controller.abort();
      await stopping;
    }
    await task;
  });

  test("bounds tracked handlers that remain pending after worker drain", async () => {
    for (const failDrain of [false, true]) {
      const tracker = createRuntimeTaskTracker();
      const unfinished = Promise.withResolvers<void>();
      tracker.open();
      tracker.run(() => unfinished.promise);
      let receivedTimeout: number | undefined;
      try {
        await expect(
          stopRuntimeJobs(
            tracker,
            [
              {
                stop: () => {},
                drain: async (options) => {
                  receivedTimeout = options?.timeoutMs;
                  if (failDrain) throw new Error("worker drain failed");
                },
              },
            ],
            { timeoutMs: 5 },
          ),
        ).rejects.toThrow(failDrain ? "Multiple runtime jobs failed to stop" : "Runtime tasks did not drain within 5ms");
        expect(receivedTimeout).toBe(5);
      } finally {
        unfinished.resolve();
        await tracker.drain();
      }
    }
  });

  test("drains every worker and reports all failures", async () => {
    const tracker = createRuntimeTaskTracker();
    const events: string[] = [];
    tracker.open();
    tracker.run(async () => events.push("tasks drained"));

    await expect(
      stopRuntimeJobs(tracker, [
        {
          stop: () => void events.push("first stopped"),
          drain: async () => {
            events.push("first");
            throw new Error("first drain failed");
          },
        },
        { stop: () => void events.push("second stopped"), drain: async () => void events.push("second") },
        {
          stop: () => void events.push("third stopped"),
          drain: async () => {
            throw new Error("third drain failed");
          },
        },
      ]),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(events).toEqual(["first stopped", "second stopped", "third stopped", "first", "second", "tasks drained"]);
  });

  test("serializes duplicate starts and stops", async () => {
    let starts = 0;
    let stops = 0;
    const runtime = createRuntimeLifecycle({
      start: async () => {
        starts += 1;
        await Promise.resolve();
      },
      stop: async () => {
        stops += 1;
      },
    });

    await Promise.all([runtime.start(), runtime.start()]);
    await Promise.all([runtime.stop(), runtime.stop()]);

    expect({ starts, stops }).toEqual({ starts: 1, stops: 1 });
  });

  test("cleans up a partial start before allowing a retry", async () => {
    let starts = 0;
    let stops = 0;
    const runtime = createRuntimeLifecycle({
      start: async () => {
        starts += 1;
        if (starts === 1) throw new Error("startup failed");
      },
      stop: async () => {
        stops += 1;
      },
    });

    await expect(runtime.start()).rejects.toThrow("startup failed");
    await runtime.start();
    await runtime.stop();

    expect({ starts, stops }).toEqual({ starts: 2, stops: 2 });
  });

  test("keeps failed cleanup retryable", async () => {
    let stopAttempts = 0;
    const runtime = createRuntimeLifecycle({
      start: async () => {
        throw new Error("startup failed");
      },
      stop: async () => {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error("cleanup failed");
      },
    });

    await expect(runtime.start()).rejects.toBeInstanceOf(AggregateError);
    await runtime.stop();

    expect(stopAttempts).toBe(2);
  });

  test("cleans up a failed stop before starting again", async () => {
    let starts = 0;
    let stopAttempts = 0;
    const runtime = createRuntimeLifecycle({
      start: async () => {
        starts += 1;
      },
      stop: async () => {
        stopAttempts += 1;
        if (stopAttempts === 1) throw new Error("cleanup failed");
      },
    });

    await runtime.start();
    await expect(runtime.stop()).rejects.toThrow("cleanup failed");
    await runtime.start();

    expect({ starts, stopAttempts }).toEqual({ starts: 2, stopAttempts: 2 });
  });

  test("attempts every teardown even when one fails", async () => {
    const stopped: string[] = [];
    await expect(
      stopRuntimeResources([
        () => {
          stopped.push("first");
          throw new Error("first failed");
        },
        () => {
          stopped.push("second");
        },
      ]),
    ).rejects.toThrow("first failed");
    expect(stopped).toEqual(["first", "second"]);
  });

  test("reports every teardown failure", async () => {
    const first = new Error("first failed");
    const second = new Error("second failed");

    try {
      await stopRuntimeResources([
        () => {
          throw first;
        },
        async () => {
          throw second;
        },
      ]);
      throw new Error("expected teardown to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([first, second]);
    }
  });
});
