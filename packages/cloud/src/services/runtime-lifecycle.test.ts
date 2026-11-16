import { describe, expect, spyOn, test } from "bun:test";
import {
  createRuntimeLifecycle,
  createRuntimeTaskTracker,
  startRuntimeInterval,
  stopRuntimeJobs,
  stopRuntimeResources,
  superviseRuntimeTask,
} from "./runtime-lifecycle";
import { createQuiesceController, QuiesceTimeoutError } from "./runtime-quiesce";

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

  test("continues recovering when error reporting itself throws", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const failures: number[] = [];

    await superviseRuntimeTask({
      signal: controller.signal,
      minRetryMs: 1,
      maxRetryMs: 2,
      jitter: 0,
      run: async () => {
        attempts += 1;
        if (attempts === 3) controller.abort();
        else throw new Error("reader failed");
      },
      onError: ({ failureCount }) => {
        failures.push(failureCount);
        throw new Error("reporter failed");
      },
    });

    expect(attempts).toBe(3);
    expect(failures).toEqual([1, 2]);
  });

  test("does not report or restart a task that rejects during shutdown", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let attempts = 0;
    let failures = 0;
    const supervised = superviseRuntimeTask({
      signal: controller.signal,
      run: (signal) => {
        attempts += 1;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("reader closed")), { once: true });
          started.resolve();
        });
      },
      onError: () => {
        failures += 1;
      },
    });

    await started.promise;
    controller.abort();
    await supervised;
    expect(attempts).toBe(1);
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

  test("serializes stop and restart behind an in-flight start", async () => {
    const firstStart = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const events: string[] = [];
    let starts = 0;
    const runtime = createRuntimeLifecycle({
      start: async () => {
        const attempt = ++starts;
        events.push(`start:${attempt}`);
        if (attempt === 1) {
          started.resolve();
          await firstStart.promise;
        }
        events.push(`ready:${attempt}`);
      },
      stop: async () => {
        events.push("stop");
      },
    });

    const initial = runtime.start();
    await started.promise;
    const stopping = runtime.stop();
    const restarting = runtime.start();
    try {
      await Promise.resolve();
      expect(events).toEqual(["start:1"]);
    } finally {
      firstStart.resolve();
      await Promise.all([initial, stopping, restarting]);
      await runtime.stop();
    }
    expect(events).toEqual(["start:1", "ready:1", "stop", "start:2", "ready:2", "stop"]);
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

describe("maintenance quiesce", () => {
  test("a tracker accepts nothing while quiet, drains its tasks, and accepts again on resume", async () => {
    const controller = createQuiesceController();
    const tracker = createRuntimeTaskTracker({ controller });
    tracker.open();
    const running = Promise.withResolvers<void>();
    const task = tracker.run(() => running.promise);
    expect(task).not.toBeNull();
    const quiet = controller.quiesce();
    expect(tracker.run(async () => {})).toBeNull();
    expect(controller.inFlight()).toBe(1);
    running.resolve();
    expect(await quiet).toEqual([]);
    expect(controller.inFlight()).toBe(0);
    await controller.resume();
    expect(tracker.run(async () => {})).not.toBeNull();
  });

  test("a closed tracker leaves the controller", async () => {
    const controller = createQuiesceController();
    const tracker = createRuntimeTaskTracker({ controller });
    tracker.open();
    tracker.close();
    expect(tracker.run(async () => {})).toBeNull();
    expect(controller.inFlight()).toBe(0);
  });

  test("a started lifecycle stops on quiesce and starts again on resume", async () => {
    const controller = createQuiesceController();
    const events: string[] = [];
    const lifecycle = createRuntimeLifecycle(
      { start: async () => void events.push("start"), stop: async () => void events.push("stop") },
      { controller },
    );
    await lifecycle.start();
    await controller.quiesce();
    await controller.quiesce();
    await controller.resume();
    await controller.resume();
    expect(events).toEqual(["start", "stop", "start"]);
  });

  test("start while quiet waits for resume, and stop while quiet keeps it stopped", async () => {
    const controller = createQuiesceController();
    const events: string[] = [];
    const lifecycle = createRuntimeLifecycle(
      { start: async () => void events.push("start"), stop: async () => void events.push("stop") },
      { controller },
    );
    await controller.quiesce();
    await lifecycle.start();
    expect(events).toEqual([]);
    await controller.resume();
    expect(events).toEqual(["start"]);

    await controller.quiesce();
    await lifecycle.stop();
    await controller.resume();
    expect(events).toEqual(["start", "stop"]);
  });

  test("a lifecycle whose stop timed out during quiesce starts on resume without stopping again", async () => {
    const controller = createQuiesceController();
    const events: string[] = [];
    let failStop = false;
    const lifecycle = createRuntimeLifecycle(
      {
        start: async () => void events.push("start"),
        stop: async () => {
          events.push("stop");
          if (failStop) throw new QuiesceTimeoutError("Runtime tasks did not drain within 30000ms");
        },
      },
      { controller },
    );
    await lifecycle.start();
    failStop = true;
    expect((await controller.quiesce()).map((error) => (error as Error).message)).toEqual(["Runtime tasks did not drain within 30000ms"]);
    // A second stop would time out the same way and fail the resume.
    expect(await controller.resume()).toEqual([]);
    expect(events).toEqual(["start", "stop", "start"]);
  });

  test("a lifecycle whose stop failed for another reason during quiesce stops again before it starts on resume", async () => {
    const controller = createQuiesceController();
    const events: string[] = [];
    let failStop = false;
    const lifecycle = createRuntimeLifecycle(
      {
        start: async () => void events.push("start"),
        stop: async () => {
          events.push("stop");
          if (failStop) {
            failStop = false;
            throw new Error("connection close failed");
          }
        },
      },
      { controller },
    );
    await lifecycle.start();
    failStop = true;
    expect((await controller.quiesce()).map((error) => (error as Error).message)).toEqual(["connection close failed"]);
    expect(await controller.resume()).toEqual([]);
    expect(events).toEqual(["start", "stop", "stop", "start"]);
    await lifecycle.stop();
  });

  test("a lifecycle that cannot start again is reported by resume after its retries", async () => {
    const controller = createQuiesceController({ retryMs: 1 });
    let starts = 0;
    const lifecycle = createRuntimeLifecycle(
      {
        start: async () => {
          starts += 1;
          if (starts > 1) throw new Error("database unavailable");
        },
        stop: async () => {},
      },
      { controller },
    );
    await lifecycle.start();
    await controller.quiesce();
    expect((await controller.resume()).map((error) => (error as Error).message)).toEqual(["database unavailable"]);
    expect(starts).toBe(1 + 5);
  });

  test("a runtime interval skips ticks while quiet and runs missed ticks once on resume", async () => {
    const controller = createQuiesceController();
    let runs = 0;
    // An hour: the timer never fires during the test; transitions drive every run.
    const interval = startRuntimeInterval({
      run: async () => {
        runs += 1;
      },
      intervalMs: 3_600_000,
      runNow: false,
      onError: () => {},
      controller,
    });
    await controller.quiesce();
    expect(runs).toBe(0);
    await controller.resume();
    expect(runs).toBe(0);

    const missed = startRuntimeInterval({
      run: async () => {
        runs += 1;
      },
      intervalMs: 3_600_000,
      onError: () => {},
      controller,
    });
    await Promise.resolve();
    await missed.stop();
    expect(runs).toBe(1);

    await controller.quiesce();
    const quiet = startRuntimeInterval({
      run: async () => {
        runs += 1;
      },
      intervalMs: 3_600_000,
      onError: () => {},
      controller,
    });
    expect(runs).toBe(1);
    await controller.resume();
    await quiet.stop();
    expect(runs).toBe(2);
    await interval.stop();
  });

  test("a runtime interval catches up once after resume, also when its pass outlived the drain", async () => {
    const controller = createQuiesceController({ timeoutMs: 5 });
    let tickNow: () => void = () => {};
    // The interval's own timer never fires; the test ticks by hand.
    const timers = spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void) => {
      tickNow = handler;
      return 0;
    }) as unknown as typeof setInterval);
    try {
      let runs = 0;
      const first = Promise.withResolvers<void>();
      const interval = startRuntimeInterval({
        run: async () => {
          runs += 1;
          if (runs === 1) await first.promise;
        },
        intervalMs: 60_000,
        onError: () => {},
        controller,
      });
      // The first pass ignores the drain and keeps running.
      expect((await controller.quiesce()).length).toBe(1);
      tickNow();
      await controller.resume();
      expect(runs).toBe(1);
      first.resolve();
      while (runs < 2) await Bun.sleep(1);
      await Bun.sleep(5);
      expect(runs).toBe(2);
      await interval.stop();
    } finally {
      timers.mockRestore();
    }
  });

  test("a runtime interval started while quiet without runNow does not run at once on resume", async () => {
    const controller = createQuiesceController();
    let runs = 0;
    await controller.quiesce();
    const interval = startRuntimeInterval({
      run: async () => {
        runs += 1;
      },
      intervalMs: 3_600_000,
      runNow: false,
      onError: () => {},
      controller,
    });
    await controller.resume();
    await interval.stop();
    expect(runs).toBe(0);
  });

  test("a runtime interval whose error report throws leaves no unhandled rejection", async () => {
    const controller = createQuiesceController();
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const reported = Promise.withResolvers<void>();
      const interval = startRuntimeInterval({
        run: async () => {
          throw new Error("scan failed");
        },
        intervalMs: 3_600_000,
        onError: () => {
          reported.resolve();
          throw new Error("logger failed");
        },
        controller,
      });
      await reported.promise;
      await interval.stop();
      // Unhandled rejections surface after the microtask queue drains.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  test("a runtime interval reports a failed pass", async () => {
    const controller = createQuiesceController();
    const reported = Promise.withResolvers<string>();
    const interval = startRuntimeInterval({
      run: async () => {
        throw new Error("scan failed");
      },
      intervalMs: 3_600_000,
      onError: (error) => reported.resolve(error instanceof Error ? error.message : String(error)),
      controller,
    });
    expect(await reported.promise).toBe("scan failed");
    await interval.stop();
  });

  test("a runtime interval reports a pass that fails while it stops, but not the abort that stop() causes", async () => {
    const controller = createQuiesceController();
    const reported: string[] = [];
    const onError = (error: unknown) => reported.push(error instanceof Error ? error.message : String(error));

    // A pass that ignores the signal and fails during stop is a real failure, as with a plain timer.
    const failing = Promise.withResolvers<void>();
    const failed = startRuntimeInterval({ run: () => failing.promise, intervalMs: 3_600_000, onError, controller });
    await Promise.resolve();
    const stopping = failed.stop();
    failing.reject(new Error("recovery failed"));
    await stopping;

    // A pass that ends with the abort of stop() is expected.
    const aborted = startRuntimeInterval({
      run: (signal) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      intervalMs: 3_600_000,
      onError,
      controller,
    });
    await Promise.resolve();
    await aborted.stop();

    expect(reported).toEqual(["recovery failed"]);
  });
});
