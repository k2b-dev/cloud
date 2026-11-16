import { describe, expect, test } from "bun:test";
import type { Sync, Worker } from "@k2b/sync";
import { createQuiesceController, quiesceWorker, withQuiesce } from "./runtime-quiesce";

type FakeWorker = Worker & { stopped: boolean; drained: number; setActive(count: number): void; failDrain?: Error };

const fakeWorker = (): FakeWorker => {
  let active = 0;
  const worker: FakeWorker = {
    stopped: false,
    drained: 0,
    get active() {
      return active;
    },
    capacity: 4,
    setActive: (count) => {
      active = count;
    },
    stop: () => {
      worker.stopped = true;
    },
    drain: async () => {
      worker.stopped = true;
      worker.drained += 1;
      active = 0;
      if (worker.failDrain) throw worker.failDrain;
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

describe("quiesce controller", () => {
  test("stop, drain and resume create the worker again behind the same handle", async () => {
    const controller = createQuiesceController();
    const { created, start } = starter();
    const handle = await quiesceWorker(start, { controller });
    expect(created).toHaveLength(1);
    expect(handle.capacity).toBe(4);

    expect(await controller.quiesce()).toEqual([]);
    expect(created[0]?.stopped).toBe(true);
    expect(created[0]?.drained).toBe(1);
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
    await controller.resume();
    await controller.resume();
    expect(created).toHaveLength(2);
    expect(created[1]?.stopped).toBe(false);
  });

  test("reports the work still in flight while it drains", async () => {
    const controller = createQuiesceController();
    const drained = Promise.withResolvers<void>();
    const worker = fakeWorker();
    worker.drain = () => drained.promise;
    const release = () => {
      worker.setActive(0);
      drained.resolve();
    };
    const handle = await quiesceWorker(async () => worker, { controller });
    worker.setActive(2);
    const draining = controller.quiesce();
    expect(controller.inFlight()).toBe(2);
    expect(handle.active).toBe(2);
    release();
    await draining;
    expect(controller.inFlight()).toBe(0);
  });

  test("a failed drain is reported and the worker still resumes", async () => {
    const controller = createQuiesceController();
    const { created, start } = starter();
    await quiesceWorker(async () => {
      const worker = await start();
      if (created.length === 1) worker.failDrain = new Error("drain timed out");
      return worker;
    }, { controller });
    const errors = await controller.quiesce();
    expect(errors.map((error) => (error as Error).message)).toEqual(["drain timed out"]);
    expect(await controller.resume()).toEqual([]);
    expect(created).toHaveLength(2);
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

  test("a stopped handle or an aborted signal does not come back", async () => {
    const controller = createQuiesceController();
    const stopped = starter();
    const handle = await quiesceWorker(stopped.start, { controller });
    const aborted = starter();
    const abort = new AbortController();
    await quiesceWorker(aborted.start, { controller, signal: abort.signal });
    await controller.quiesce();
    handle.stop();
    abort.abort();
    await controller.resume();
    expect(stopped.created).toHaveLength(1);
    expect(aborted.created).toHaveLength(1);
  });

  test("a resume that cannot start a worker is returned to the caller", async () => {
    const controller = createQuiesceController();
    let calls = 0;
    await quiesceWorker(async () => {
      calls += 1;
      if (calls > 1) throw new Error("consumer unavailable");
      return fakeWorker();
    }, { controller });
    await controller.quiesce();
    const failures = await controller.resume();
    expect(failures.map((error) => (error as Error).message)).toEqual(["consumer unavailable"]);
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
});

test("withQuiesce wraps process() of every working primitive and nothing else", async () => {
  const controller = createQuiesceController();
  const { created, start } = starter();
  const submit = async () => ({ messageId: "m-1" });
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
  expect(await job.submit({ input: { id: "1" } } as never)).toEqual({ messageId: "m-1" });
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
