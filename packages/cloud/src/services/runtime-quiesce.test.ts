import { describe, expect, spyOn, test } from "bun:test";
import type { Sync, Worker } from "@k2b/sync";
import { createRuntimeLifecycle, createRuntimeTaskTracker, stopRuntimeJobs, superviseRuntimeTask } from "./runtime-lifecycle";
import { createQuiesceController, type QuiesceController, quiesceWorker, type ResumeRetry, withQuiesce } from "./runtime-quiesce";

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
    const controller = createQuiesceController({ timeoutMs: 5 });
    const { created, start } = starter();
    await quiesceWorker(start, { controller });
    const release = created[0]!.hold();

    const errors = await controller.quiesce();
    expect(messages(errors)).toEqual(["A worker still runs 1 handler(s) 5ms after its drain began; it counts as in flight until they end"]);
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

  test("release clears quiet without starting anything again", async () => {
    const controller = createQuiesceController();
    const { created, start } = starter();
    await quiesceWorker(start, { controller });
    await controller.quiesce();
    controller.release();
    expect(controller.quiesced).toBe(false);
    expect(created).toHaveLength(1);
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
    const controller = createQuiesceController({ timeoutMs: 5 });
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
      "Runtime tasks did not drain within 5ms",
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
