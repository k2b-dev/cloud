import { describe, expect, spyOn, test } from "bun:test";
import type { Sync, Worker } from "@k2b/sync";
import { createRuntimeLifecycle, createRuntimeTaskTracker, stopRuntimeJobs, superviseRuntimeTask } from "./runtime-lifecycle";
import {
  createQuiesceController,
  createWorkerLineage,
  type QuiesceController,
  quiesceWorker,
  type ResumeRetry,
  runSupervised,
  StuckWorkerError,
  withQuiesce,
} from "./runtime-quiesce";

type FakeWorker = Worker & { stopped: boolean; drains: Array<number | undefined>; hold(): () => void };

/**
 * Behaves like a Sync 7 worker: `drain()` waits for handlers up to its budget and then resolves, also when a
 * handler ignores its abort and keeps running; `active` stays above 0 until that handler really ends.
 */
const fakeWorker = (): FakeWorker => {
  let active = 0;
  const worker: FakeWorker = {
    stopped: false,
    drains: [],
    get active() {
      return active;
    },
    capacity: 4,
    hold: () => {
      active += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        active -= 1;
      };
    },
    stop: () => {
      worker.stopped = true;
    },
    drain: async (options) => {
      worker.stopped = true;
      worker.drains.push(options?.timeoutMs);
      const deadline = Date.now() + (options?.timeoutMs ?? 30_000);
      while (active > 0 && Date.now() < deadline) await Bun.sleep(1);
    },
    [Symbol.asyncDispose]: async () => {},
  };
  return worker;
};

const starter = () => {
  const created: FakeWorker[] = [];
  return {
    created,
    start: async () => {
      const worker = fakeWorker();
      created.push(worker);
      return worker;
    },
  };
};

/** Polls a condition; the test timeout bounds it. */
const until = async (condition: () => boolean) => {
  while (!condition()) await Bun.sleep(1);
};

const messages = (errors: unknown[]) => errors.map((error) => (error instanceof Error ? error.message : String(error)));

describe("quiesce controller", () => {
  test("stop, drain and resume create the worker again behind the same handle", async () => {
    const controller = createQuiesceController();
    const { created, start } = starter();
    const handle = await quiesceWorker(start, { controller });
    expect(created).toHaveLength(1);
    expect(handle.capacity).toBe(4);

    expect(await controller.quiesce()).toEqual([]);
    expect(created[0]?.stopped).toBe(true);
    expect(created[0]?.drains).toEqual([controller.timeoutMs]);
    expect(handle.capacity).toBe(0);

    expect(await controller.resume()).toEqual([]);
    expect(created).toHaveLength(2);
    expect(created[1]?.stopped).toBe(false);
    expect(handle.capacity).toBe(4);
  });

  test("toggles are idempotent", async () => {
    const controller = createQuiesceController();
    const { created, start } = starter();
    await quiesceWorker(start, { controller });
    const first = controller.quiesce();
    expect(controller.quiesce()).toBe(first);
    await first;
    const resumed = controller.resume();
    expect(controller.resume()).toBe(resumed);
    await resumed;
    expect(created).toHaveLength(2);
    expect(created[1]?.stopped).toBe(false);
  });

  test("reports the work still in flight while it drains", async () => {
    const controller = createQuiesceController();
    const { created, start } = starter();
    const handle = await quiesceWorker(start, { controller });
    const releases = [created[0]!.hold(), created[0]!.hold()];
    const draining = controller.quiesce();
    expect(controller.inFlight()).toBe(2);
    expect(handle.active).toBe(2);
    for (const release of releases) release();
    expect(await draining).toEqual([]);
    expect(controller.inFlight()).toBe(0);
  });

  test("a drain that times out with handlers still running is a drain error; they keep counting and resume waits for them", async () => {
    // Step budget 100 ms, so the wait for the old handler may last 200 ms.
    const controller = createQuiesceController({ timeoutMs: 50, retryMs: 1 });
    const { created, start } = starter();
    await quiesceWorker(start, { controller });
    const release = created[0]!.hold();

    const errors = await controller.quiesce();
    expect(messages(errors)).toEqual([
      "A worker still runs 1 handler(s) 50ms after its drain began; it counts as in flight until they end",
    ]);
    expect(controller.inFlight()).toBe(1);

    let resumed = false;
    const resuming = controller.resume().then((failures) => {
      resumed = true;
      return failures;
    });
    await Bun.sleep(20);
    // No second generation while the first still runs a handler; the status still names it.
    expect(created).toHaveLength(1);
    expect(resumed).toBe(false);
    expect(controller.inFlight()).toBe(1);

    release();
    expect(await resuming).toEqual([]);
    expect(created).toHaveLength(2);
    expect(controller.inFlight()).toBe(0);
  });

  test("a worker created while quiet starts on resume", async () => {
    const controller = createQuiesceController();
    await controller.quiesce();
    const { created, start } = starter();
    const handle = await quiesceWorker(start, { controller });
    expect(created).toHaveLength(0);
    expect(handle.active).toBe(0);
    await controller.resume();
    expect(created).toHaveLength(1);
  });

  test("a stopped handle or an aborted signal does not come back, and an aborted signal leaves the controller", async () => {
    const controller = createQuiesceController();
    const stopped = starter();
    const handle = await quiesceWorker(stopped.start, { controller });
    const aborted = starter();
    const abort = new AbortController();
    await quiesceWorker(aborted.start, { controller, signal: abort.signal });
    abort.abort();
    await controller.quiesce();
    // Unregistered by the abort: quiesce no longer drains it.
    expect(aborted.created[0]?.drains).toEqual([]);
    handle.stop();
    await controller.resume();
    expect(stopped.created).toHaveLength(1);
    expect(aborted.created).toHaveLength(1);
  });

  test("a handle that ends while its handlers outlive the drain keeps counting them", async () => {
    const controller = createQuiesceController();
    const { created, start } = starter();
    const handle = await quiesceWorker(start, { controller });
    const release = created[0]!.hold();
    await handle.drain({ timeoutMs: 5 });
    expect(controller.inFlight()).toBe(1);
    release();
    expect(controller.inFlight()).toBe(0);
  });

  test("a worker that arrives after its end is drained with the controller's budget", async () => {
    const controller = createQuiesceController({ timeoutMs: 1_234 });
    const abort = new AbortController();
    const arrived = Promise.withResolvers<FakeWorker>();
    const handle = quiesceWorker(
      async () => {
        abort.abort();
        return arrived.promise;
      },
      { controller, signal: abort.signal },
    );
    const worker = fakeWorker();
    arrived.resolve(worker);
    await handle;
    expect(worker.drains).toEqual([1_234]);
  });

  test("a resume that cannot start a worker retries, and reports it after five attempts", async () => {
    const controller = createQuiesceController({ retryMs: 1 });
    let calls = 0;
    let failUntil = 0;
    await quiesceWorker(
      async () => {
        calls += 1;
        if (calls <= failUntil) throw new Error("consumer unavailable");
        return fakeWorker();
      },
      { controller },
    );

    // Four transient failures: the fifth attempt starts it.
    failUntil = 1 + 4;
    await controller.quiesce();
    const retries: ResumeRetry[] = [];
    expect(await controller.resume({ onRetry: (retry) => retries.push(retry) })).toEqual([]);
    expect(calls).toBe(6);
    expect(retries.map((retry) => retry.attempt)).toEqual([1, 2, 3, 4]);

    failUntil = Number.POSITIVE_INFINITY;
    await controller.quiesce();
    const before = calls;
    expect(messages(await controller.resume())).toEqual(["consumer unavailable"]);
    expect(calls - before).toBe(5);
  });

  test("a worker inside superviseRuntimeTask retries its resume without a limit and never fails the resume", async () => {
    const controller = createQuiesceController({ retryMs: 1 });
    let calls = 0;
    let failing = false;
    const shutdown = new AbortController();
    const created = Promise.withResolvers<void>();
    const supervised = superviseRuntimeTask({
      signal: shutdown.signal,
      run: async (signal) => {
        await quiesceWorker(
          async () => {
            calls += 1;
            if (failing) throw new Error("consumer unavailable");
            return fakeWorker();
          },
          { controller, signal },
        );
        created.resolve();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    });
    await created.promise;
    await controller.quiesce();
    failing = true;
    expect(await controller.resume()).toEqual([]);
    await until(() => calls >= 8);
    failing = false;
    const settled = calls;
    await until(() => calls > settled);
    await Bun.sleep(40);
    // Started once more, then no further attempts.
    expect(calls).toBe(settled + 1);
    shutdown.abort();
    await supervised;
  });

  test("listeners hear every transition once", async () => {
    const controller = createQuiesceController();
    const heard: boolean[] = [];
    controller.onChange((quiesced) => heard.push(quiesced));
    await controller.quiesce();
    await controller.quiesce();
    await controller.resume();
    expect(heard).toEqual([true, false]);
  });

  test("release clears quiet without starting anything again or calling listeners", async () => {
    const controller = createQuiesceController();
    const { created, start } = starter();
    await quiesceWorker(start, { controller });
    await controller.quiesce();
    const heard: boolean[] = [];
    controller.onChange((quiesced) => heard.push(quiesced));
    controller.release();
    expect(controller.quiesced).toBe(false);
    expect(created).toHaveLength(1);
    expect(heard).toEqual([]);
  });
});

describe("quiesce order", () => {
  /** A runtime lifecycle that logs its hooks; `inside` starts and stops another one within its own hooks. */
  const runtime = (controller: QuiesceController, name: string, events: string[], inside?: ReturnType<typeof createRuntimeLifecycle>) =>
    createRuntimeLifecycle(
      {
        start: async () => {
          events.push(`start ${name}`);
          await inside?.start();
        },
        stop: async () => {
          await inside?.stop();
          events.push(`stop ${name}`);
        },
      },
      { controller },
    );

  test("workers drain before runtimes stop last-first, and runtimes start in order before workers resume", async () => {
    const controller = createQuiesceController();
    const events: string[] = [];
    const first = runtime(controller, "first", events);
    const second = runtime(controller, "second", events);
    await first.start();
    await second.start();
    await quiesceWorker(
      async () => {
        const worker = fakeWorker();
        const drain = worker.drain;
        worker.drain = async (options) => {
          await drain(options);
          events.push("worker drained");
        };
        events.push("worker started");
        return worker;
      },
      { controller },
    );
    events.length = 0;

    await controller.quiesce();
    expect(events).toEqual(["worker drained", "stop second", "stop first"]);
    events.length = 0;
    await controller.resume();
    expect(events).toEqual(["start first", "start second", "worker started"]);
  });

  test("a runtime started inside another one stops before it and starts after it", async () => {
    const controller = createQuiesceController();
    const events: string[] = [];
    const inner = runtime(controller, "inner", events);
    const outer = runtime(controller, "outer", events, inner);
    await outer.start();
    events.length = 0;
    await controller.quiesce();
    expect(events).toEqual(["stop inner", "stop outer"]);
    events.length = 0;
    await controller.resume();
    expect(events).toEqual(["start outer", "start inner"]);
    await outer.stop();
  });

  test("a lifecycle that cannot start again is retried before resume reports it", async () => {
    const controller = createQuiesceController({ retryMs: 1 });
    let starts = 0;
    const lifecycle = createRuntimeLifecycle(
      {
        start: async () => {
          starts += 1;
          if (starts > 1 && starts < 4) throw new Error("database unavailable");
        },
        stop: async () => {},
      },
      { controller },
    );
    await lifecycle.start();
    await controller.quiesce();
    expect(await controller.resume()).toEqual([]);
    expect(starts).toBe(4);
  });

  test("a tracker closed by a lifecycle stop that timed out keeps counting its task, and resume does not stop again", async () => {
    // The lifecycle's own drain budget (5 ms) ends before the controller's step budget (40 ms) for its stop.
    const controller = createQuiesceController({ timeoutMs: 20 });
    const events: string[] = [];
    const tracker = createRuntimeTaskTracker({ controller });
    const unfinished = Promise.withResolvers<void>();
    const lifecycle = createRuntimeLifecycle(
      {
        start: async () => {
          events.push("start");
          tracker.open();
        },
        stop: async () => {
          events.push("stop");
          await stopRuntimeJobs(tracker, [], { timeoutMs: 5 });
        },
      },
      { controller },
    );
    await lifecycle.start();
    tracker.run(() => unfinished.promise);
    // The tracker's own drain times out first, then the lifecycle's stop closes it and times out too.
    expect(messages(await controller.quiesce())).toEqual([
      "Runtime tasks did not drain within 20ms",
      "Runtime tasks did not drain within 5ms",
    ]);
    expect(controller.inFlight()).toBe(1);
    expect(await controller.resume()).toEqual([]);
    expect(events).toEqual(["start", "stop", "start"]);
    unfinished.resolve();
    await until(() => controller.inFlight() === 0);
    await lifecycle.stop();
  });
});

describe("quiesce races", () => {
  test("a quiesce during a worker's start retires the worker once it arrives", async () => {
    const controller = createQuiesceController();
    const arrived = Promise.withResolvers<FakeWorker>();
    let starts = 0;
    const handle = quiesceWorker(
      async () => {
        starts += 1;
        return starts === 1 ? arrived.promise : fakeWorker();
      },
      { controller },
    );
    const quiet = controller.quiesce();
    const worker = fakeWorker();
    arrived.resolve(worker);
    await handle;
    expect(await quiet).toEqual([]);
    expect(worker.stopped).toBe(true);
    expect(worker.drains).toHaveLength(1);
    await controller.resume();
    expect(starts).toBe(2);
  });

  test("a resume during a drain starts the next generation only after the drain", async () => {
    const controller = createQuiesceController();
    const { created, start } = starter();
    await quiesceWorker(start, { controller });
    const release = created[0]!.hold();
    const quiet = controller.quiesce();
    const resumed = controller.resume();
    await Bun.sleep(10);
    expect(created).toHaveLength(1);
    release();
    expect(await quiet).toEqual([]);
    expect(await resumed).toEqual([]);
    expect(created).toHaveLength(2);
    expect(created[0]?.active).toBe(0);
  });

  test("a stop during quiesce keeps the worker stopped after resume", async () => {
    const controller = createQuiesceController();
    const { created, start } = starter();
    const handle = await quiesceWorker(start, { controller });
    const release = created[0]!.hold();
    const quiet = controller.quiesce();
    handle.stop();
    release();
    await quiet;
    await controller.resume();
    expect(created).toHaveLength(1);
  });
});

test("withQuiesce wraps process() of every working primitive and nothing else", async () => {
  const controller = createQuiesceController();
  const { created, start } = starter();
  const receipt = { messageId: "m-1", streamSequence: 1, duplicate: false, jobId: "job-1" };
  const submit = async () => receipt;
  const handle = { process: (..._args: unknown[]) => start(), submit };
  // Only the members withQuiesce touches; a full Sync is not needed for this seam.
  const sync = {
    job: () => handle,
    queue: () => handle,
    topic: () => handle,
    scheduler: () => handle,
    pump: () => handle,
    ready: async () => {},
  } as unknown as Sync;
  const wrapped = withQuiesce(sync, controller);
  const job = wrapped.job<{ id: string }>({ id: "example-job" });
  expect(await job.submit({ input: { id: "1" } } as never)).toEqual(receipt);
  await job.process({}, async () => {});
  await wrapped.scheduler({ id: "example-scheduler" }).process();
  expect(created).toHaveLength(2);
  await controller.quiesce();
  await controller.resume();
  expect(created).toHaveLength(4);
});

test("withQuiesce keeps every other member of each primitive working: getters, this and private state", async () => {
  const controller = createQuiesceController();
  const { start } = starter();
  /** A future Sync primitive written as a class, with a getter and private state. */
  class Primitive {
    #reads = 0;
    readonly id = "example";
    get reads(): number {
      return this.#reads;
    }
    read(): number {
      this.#reads += 1;
      return this.#reads;
    }
    process(..._args: unknown[]) {
      return start();
    }
  }
  const kinds = ["job", "queue", "topic", "scheduler", "pump"] as const;
  const originals = new Map<string, Primitive>();
  const sync = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      () => {
        const primitive = new Primitive();
        originals.set(kind, primitive);
        return primitive;
      },
    ]),
  ) as unknown as Sync;
  const wrapped = withQuiesce(sync, controller) as unknown as Record<(typeof kinds)[number], (config: unknown) => Primitive>;
  for (const kind of kinds) {
    const primitive = wrapped[kind]({ id: `example-${kind}` });
    const original = originals.get(kind)!;
    for (const key of [...Object.keys(original), ...Object.getOwnPropertyNames(Primitive.prototype)]) {
      expect(key in primitive).toBe(true);
    }
    expect(primitive.id).toBe("example");
    expect(primitive.read()).toBe(1);
    expect(primitive.reads).toBe(1);
    expect(original.reads).toBe(1);
    expect(primitive.process).not.toBe(original.process);
  }
});

test("withQuiesce keeps the process Sync and its primitives observable: a spy on a member sees the calls", async () => {
  const controller = createQuiesceController();
  const { start } = starter();
  let drains = 0;
  let submits = 0;
  const handle = {
    process: (..._args: unknown[]) => start(),
    submit: async () => {
      submits += 1;
    },
  };
  const sync = {
    job: () => handle,
    drain: async () => {
      drains += 1;
    },
  } as unknown as Sync;
  const wrapped = withQuiesce(sync, controller);

  // Tests and callers spy on the bound process Sync, as on main before quiesce wrapped it.
  const drainSpy = spyOn(wrapped, "drain");
  await wrapped.drain();
  expect(drainSpy).toHaveBeenCalledTimes(1);
  expect(drains).toBe(1);

  const job = wrapped.job<{ id: string }>({ id: "example-job" });
  const submitSpy = spyOn(job, "submit");
  await job.submit({ input: { id: "1" } } as never);
  expect(submitSpy).toHaveBeenCalledTimes(1);
  expect(submits).toBe(1);
});

describe("old generations", () => {
  /** A process Sync with one job whose `process()` creates fake workers, wrapped like the real one. */
  const syncWithJob = (controller: QuiesceController) => {
    const { created, start } = starter();
    const sync = { job: () => ({ process: (..._args: unknown[]) => start() }) } as unknown as Sync;
    return { created, job: withQuiesce(sync, controller).job<{ id: string }>({ id: "deliveries" }) };
  };

  test("a worker that a runtime creates again on resume waits for the handler its earlier handle left running", async () => {
    // Step budget 200 ms: the new generation waits up to 400 ms for the old handler.
    const controller = createQuiesceController({ timeoutMs: 100, retryMs: 1 });
    const { created, job } = syncWithJob(controller);
    const tracker = createRuntimeTaskTracker({ controller });
    let worker: Worker | undefined;
    // Owns its worker like the notification runtime: stop ends the handle, start calls process() again.
    const runtime = createRuntimeLifecycle(
      {
        start: async () => {
          tracker.open();
          worker = await job.process({}, async () => {});
        },
        stop: async () => {
          await stopRuntimeJobs(tracker, worker ? [worker] : [], { timeoutMs: 100 });
          worker = undefined;
        },
      },
      { controller },
    );
    await runtime.start();
    // The handler ignores the abort of the drain.
    const release = created[0]!.hold();
    expect(messages(await controller.quiesce())).toEqual([
      "A worker still runs 1 handler(s) 100ms after its drain began; it counts as in flight until they end",
    ]);

    const resumed = controller.resume();
    await Bun.sleep(50);
    // The runtime asked for a new handle, but no second generation runs beside the old handler.
    expect(created).toHaveLength(1);
    expect(controller.inFlight()).toBe(1);

    release();
    expect(await resumed).toEqual([]);
    expect(created).toHaveLength(2);
    expect(controller.inFlight()).toBe(0);
    await runtime.stop();
  });

  test("a new generation reports its wait and fails once old handlers outlive twice the step budget", async () => {
    // Step budget 40 ms, wait budget 80 ms.
    const controller = createQuiesceController({ timeoutMs: 20, retryMs: 1 });
    const { created, start } = starter();
    await quiesceWorker(start, { controller });
    // Ignores every abort: only a restart ends it.
    created[0]!.hold();
    await controller.quiesce();

    const retries: ResumeRetry[] = [];
    const failures = await controller.resume({ onRetry: (retry) => retries.push(retry) });
    expect(messages(retries.map((retry) => retry.error))[0]).toBe("Background work did not start again within 40ms");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(StuckWorkerError);
    expect(messages(failures)[0]).toStartWith("A worker of a primitive still runs 1 handler(s) of an earlier generation");
    expect(created).toHaveLength(1);
    // The status still names the handler that runs.
    expect(controller.inFlight()).toBe(1);
  });

  test("a stuck verdict ends with the old handlers: a later overlap on the same primitive waits again instead of failing at once", async () => {
    // Step budget 40 ms, wait budget 80 ms; nothing is quiesced, as outside maintenance.
    const controller = createQuiesceController({ timeoutMs: 20, retryMs: 1 });
    const lineage = createWorkerLineage("deliveries");
    const { created, start } = starter();
    const first = await quiesceWorker(start, { controller, lineage });
    const releaseFirst = created[0]!.hold();
    first.stop();
    await expect(quiesceWorker(start, { controller, lineage })).rejects.toBeInstanceOf(StuckWorkerError);
    releaseFirst();
    const third = await quiesceWorker(start, { controller, lineage });
    expect(created).toHaveLength(2);
    // Hours later: a handler that needs a moment more than its drain.
    const releaseThird = created[1]!.hold();
    third.stop();
    setTimeout(releaseThird, 30);
    const fourth = await quiesceWorker(start, { controller, lineage });
    expect(created).toHaveLength(3);
    expect(fourth.capacity).toBe(4);
  });

  test("a start that fails after a wait shared by two resume attempts is retried, not lost", async () => {
    // Step budget 400 ms, wait budget 800 ms; the waits poll every 100 ms.
    const controller = createQuiesceController({ timeoutMs: 200, retryMs: 1 });
    const created: FakeWorker[] = [];
    let starts = 0;
    const start = async () => {
      starts += 1;
      // The start after the old handler ended fails slowly, like a NATS timeout.
      if (starts === 2) {
        await Bun.sleep(300);
        throw new Error("consumer creation timed out");
      }
      const worker = fakeWorker();
      created.push(worker);
      return worker;
    };
    const handle = await quiesceWorker(start, { controller });
    const release = created[0]!.hold();
    await controller.quiesce();
    // Attempt 1 outlives its step budget at 400 ms and keeps waiting; attempt 2 waits too. The old handler ends at
    // 550 ms, so attempt 1's wait (polling at 600 ms) launches before attempt 2's (at about 602 ms).
    setTimeout(release, 550);
    expect(await controller.resume()).toEqual([]);
    await Bun.sleep(400);
    expect(starts).toBe(3);
    expect(handle.capacity).toBe(4);
  });

  test("a generation ended by stop() alone is drained by the next process(), so its handlers hear the abort", async () => {
    const controller = createQuiesceController({ timeoutMs: 20, retryMs: 1 });
    const lineage = createWorkerLineage("deliveries");
    const { created, start } = starter();
    const first = await quiesceWorker(start, { controller, lineage });
    const worker = created[0]!;
    // A handler that honours its abort: it ends when the drain aborts it.
    const release = worker.hold();
    const drain = worker.drain.bind(worker);
    worker.drain = async (options) => {
      release();
      await drain(options);
    };
    first.stop();
    const next = await quiesceWorker(start, { controller, lineage });
    expect(worker.drains).toEqual([20]);
    expect(created).toHaveLength(2);
    expect(next.capacity).toBe(4);
  });

  test("a supervised worker whose old handler never ends is reported after the resume, not retried forever", async () => {
    const controller = createQuiesceController({ timeoutMs: 20, retryMs: 1 });
    const { created, start } = starter();
    await runSupervised(() => quiesceWorker(start, { controller }));
    created[0]!.hold();
    await controller.quiesce();
    const late = Promise.withResolvers<unknown>();
    expect(await controller.resume({ onLateFailure: (failure) => late.resolve(failure) })).toEqual([]);
    expect(await late.promise).toBeInstanceOf(StuckWorkerError);
    expect(created).toHaveLength(1);
  });
});

describe("transition budgets", () => {
  test("a runtime stop past its budget is reported, the earlier runtimes still stop, and resume is not held up", async () => {
    // Step budget 40 ms.
    const controller = createQuiesceController({ timeoutMs: 20, retryMs: 1 });
    const events: string[] = [];
    const hung = Promise.withResolvers<void>();
    let hang = false;
    const first = createRuntimeLifecycle(
      { start: async () => void events.push("start first"), stop: async () => void events.push("stop first") },
      { controller },
    );
    const second = createRuntimeLifecycle(
      {
        start: async () => void events.push("start second"),
        stop: async () => {
          events.push("stop second");
          // A long workflow step that its stop waits for.
          if (hang) await hung.promise;
        },
      },
      { controller },
    );
    await first.start();
    await second.start();
    hang = true;
    events.length = 0;

    expect(messages(await controller.quiesce())).toEqual(["A runtime did not stop within 40ms; it counts as in flight until it has"]);
    expect(events).toEqual(["stop second", "stop first"]);
    expect(controller.inFlight()).toBe(1);

    events.length = 0;
    // Each attempt for the runtime still stopping ends after its budget; the resume ends after the retries.
    expect(messages(await controller.resume())).toEqual(["Background work did not start again within 40ms"]);
    expect(events).toEqual(["start first"]);

    // Its own lifecycle starts it once the stop ended.
    hung.resolve();
    await until(() => events.includes("start second"));
    expect(controller.inFlight()).toBe(0);
    await first.stop();
    await second.stop();
  });

  test("listeners hear the resume once the runtimes run", async () => {
    const controller = createQuiesceController();
    const events: string[] = [];
    const runtime = createRuntimeLifecycle(
      { start: async () => void events.push("start"), stop: async () => void events.push("stop") },
      { controller },
    );
    controller.onChange((quiesced) => events.push(`heard ${quiesced}`));
    await runtime.start();
    events.length = 0;
    await controller.quiesce();
    await controller.resume();
    expect(events).toEqual(["heard true", "stop", "start", "heard false"]);
    await runtime.stop();
  });

  test("a resume started inside superviseRuntimeTask does not make the workers it creates supervised", async () => {
    const controller = createQuiesceController({ retryMs: 1 });
    let failing = false;
    let worker: Promise<Worker> | undefined;
    // Started while quiet, so its first start (and its worker) comes from the resume.
    const runtime = createRuntimeLifecycle(
      {
        start: async () => {
          worker ??= quiesceWorker(
            async () => {
              if (failing) throw new Error("consumer unavailable");
              return fakeWorker();
            },
            { controller },
          );
          await worker;
        },
        stop: async () => {},
      },
      { controller },
    );
    await controller.quiesce();
    await runtime.start();
    // The maintenance watcher runs inside superviseRuntimeTask and resumes from there.
    expect(await runSupervised(() => controller.resume())).toEqual([]);
    await controller.quiesce();
    failing = true;
    // Not supervised: the worker gets five attempts and the resume reports it.
    expect(messages(await runSupervised(() => controller.resume()))).toEqual(["consumer unavailable"]);
    await runtime.stop();
  });
});
