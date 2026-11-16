import type {
  Job,
  JobConfig,
  ProcessOptions,
  Pump,
  PumpConfig,
  PumpItem,
  Queue,
  QueueConfig,
  Scheduler,
  SchedulerConfig,
  Sync,
  Topic,
  TopicConfig,
  Worker,
} from "@k2b/sync";

/**
 * Quiesce: background work of one process goes quiet without the process
 * exiting, and resumes later. Maintenance stage „Ruhe“ drives it
 * (`maintenance-quiesce.ts`); request handling is never affected.
 *
 * Everything the platform starts for background work takes part by itself,
 * so an application gets quiesce without opting in:
 *
 * - every `process()` worker of the process Sync (jobs, queues, topics,
 *   schedulers, pumps) stops pulling, drains, and is created again with the
 *   same arguments on resume (`withQuiesce`);
 * - `createRuntimeTaskTracker()` accepts no tasks while quiet and its tasks
 *   drain;
 * - a started `createRuntimeLifecycle()` is stopped and started again;
 * - `startRuntimeInterval()` skips ticks while quiet and runs once on resume.
 *
 * Own loops that fit none of these read `backgroundWork`.
 */

/** Same budget as `stopRuntimeJobs()`. */
export const QUIESCE_DRAIN_TIMEOUT_MS = 30_000;

export type QuiesceParticipant = {
  /** Stop taking new work and wait for work in flight, at most `timeoutMs`. */
  quiesce(timeoutMs: number): Promise<void>;
  /** Take new work again. A rejection means the participant could not resume. */
  resume(): Promise<void>;
  /** Units of work still running: handlers, tracked tasks, a lifecycle that is stopping. */
  inFlight(): number;
};

export type QuiesceController = ReturnType<typeof createQuiesceController>;

export const createQuiesceController = ({ timeoutMs = QUIESCE_DRAIN_TIMEOUT_MS }: { timeoutMs?: number } = {}) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Quiesce drain timeout must be positive and finite");
  const participants = new Set<QuiesceParticipant>();
  const listeners = new Set<(quiesced: boolean) => void>();
  let quiesced = false;
  let draining: Promise<unknown[]> = Promise.resolve([]);

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(quiesced);
      } catch {
        // A listener never stops the transition.
      }
    }
  };

  const failures = (results: PromiseSettledResult<unknown>[]): unknown[] =>
    results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));

  return {
    get quiesced(): boolean {
      return quiesced;
    },
    /** Participants consult `quiesced` when they start; this only adds them to later transitions. */
    register: (participant: QuiesceParticipant): (() => void) => {
      participants.add(participant);
      return () => participants.delete(participant);
    },
    /**
     * Stop new background work and drain what runs. Idempotent: a second call
     * returns the running drain. Resolves with the drain errors (a timed-out
     * drain included); it never rejects, the process stays quiet either way.
     */
    quiesce: (): Promise<unknown[]> => {
      if (quiesced) return draining;
      quiesced = true;
      notify();
      draining = Promise.allSettled([...participants].map((participant) => participant.quiesce(timeoutMs))).then(failures);
      return draining;
    },
    /**
     * Take background work again. Idempotent. Resolves with the participants
     * that failed to resume; the caller decides (an app process restarts).
     */
    resume: async (): Promise<unknown[]> => {
      if (!quiesced) return [];
      quiesced = false;
      notify();
      return failures(await Promise.allSettled([...participants].map((participant) => participant.resume())));
    },
    /** Work still running in this process; 0 while quiesced means quiet. */
    inFlight: (): number => {
      let total = 0;
      for (const participant of participants) total += participant.inFlight();
      return total;
    },
    onChange: (listener: (quiesced: boolean) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/** The controller of this process. Only the maintenance watcher of `app.start()` switches it. */
export const processQuiesce = createQuiesceController();

/**
 * The platform signal for background loops that the platform does not run
 * (a long-lived connection, an own polling loop). Prefer the tracker,
 * `startRuntimeInterval()`, or a runtime lifecycle; they follow it by themselves.
 */
export const backgroundWork = {
  /** True while the Cloud is in maintenance stage „Ruhe“: start no new background work. */
  paused: (): boolean => processQuiesce.quiesced,
  /** Called with `true` when background work must stop and `false` when it may resume. */
  onChange: (listener: (paused: boolean) => void): (() => void) => processQuiesce.onChange(listener),
};

/**
 * A worker that stops and drains on quiesce and is created again with
 * `start` on resume. The handle the caller holds stays the same; `stop()` and
 * `drain()` end it for good. Created while quiesced, it starts on resume.
 */
export const quiesceWorker = async (
  start: () => Promise<Worker>,
  { controller = processQuiesce, signal }: { controller?: QuiesceController; signal?: AbortSignal } = {},
): Promise<Worker> => {
  let current: Worker | undefined;
  let retiring: Worker | undefined;
  let retired: Promise<void> = Promise.resolve();
  let starting: Promise<void> | undefined;
  let closed = false;

  const ended = () => closed || signal?.aborted === true;

  const retire = (worker: Worker, timeoutMs: number): Promise<void> => {
    retiring = worker;
    worker.stop();
    const drained = worker.drain({ timeoutMs }).finally(() => {
      if (retiring === worker) retiring = undefined;
    });
    retired = drained.catch(() => undefined);
    return drained;
  };

  /** Start a worker; one that arrives after a quiesce or an end is drained at once instead of kept. */
  const launch = (): Promise<void> => {
    starting = (async () => {
      const worker = await start();
      if (ended() || controller.quiesced) await retire(worker, QUIESCE_DRAIN_TIMEOUT_MS);
      else current = worker;
    })().finally(() => {
      starting = undefined;
    });
    return starting;
  };

  const participant: QuiesceParticipant = {
    quiesce: async (timeoutMs) => {
      await starting?.catch(() => undefined);
      const worker = current;
      current = undefined;
      if (worker) await retire(worker, timeoutMs);
    },
    resume: async () => {
      // The previous drain is bounded by its timeout; never run two generations at once.
      await retired;
      if (ended() || controller.quiesced || current || starting) return;
      await launch();
    },
    inFlight: () => (current?.active ?? 0) + (retiring?.active ?? 0),
  };

  // Registered before the first start, so a quiesce during that start still reaches the worker.
  const unregister = controller.register(participant);
  if (!controller.quiesced) {
    try {
      await launch();
    } catch (error) {
      unregister();
      throw error;
    }
  }

  const end = () => {
    closed = true;
    unregister();
  };

  return {
    get active() {
      return participant.inFlight();
    },
    get capacity() {
      return current?.capacity ?? 0;
    },
    stop: () => {
      end();
      current?.stop();
    },
    drain: async (options) => {
      end();
      await starting?.catch(() => undefined);
      await Promise.all([current?.drain(options), retired]);
    },
    [Symbol.asyncDispose]: async () => {
      end();
      await starting?.catch(() => undefined);
      await Promise.all([current?.drain(), retired]);
    },
  };
};

/**
 * The same object with some members replaced. Every other member forwards to the original, so getters, `this` and
 * private state keep working in later Sync versions. The result is a plain object, not a Proxy: its functions are own
 * writable members, so callers and tests can replace or spy on them (`spyOn` cannot see through a Proxy).
 */
const overriding = <T extends object>(target: T, members: Partial<T>): T => {
  // The members of the original are forwarded by name below; `object` keeps them untyped there.
  const original: object = target;
  const result = { ...members } as T;
  for (let source: object | null = original; source && source !== Object.prototype; source = Object.getPrototypeOf(source)) {
    for (const key of Reflect.ownKeys(source)) {
      if (key === "constructor" || Object.hasOwn(result, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (typeof descriptor?.value === "function") {
        // Read at call time, so a member replaced on the original later is the one that runs.
        const forward = (...args: unknown[]): unknown => Reflect.apply(Reflect.get(original, key, original), original, args);
        Object.defineProperty(result, key, { value: forward, writable: true, enumerable: true, configurable: true });
      } else {
        Object.defineProperty(result, key, { get: () => Reflect.get(original, key, original), enumerable: true, configurable: true });
      }
    }
  }
  return result;
};

/**
 * The process Sync whose workers follow `controller`. Only `process()` of every primitive that has one is wrapped;
 * declarations, submissions, reads and every other member stay Sync's own.
 */
export const withQuiesce = (sync: Sync, controller: QuiesceController = processQuiesce): Sync => {
  const follow = (start: () => Promise<Worker>, options: ProcessOptions | undefined) =>
    quiesceWorker(start, { controller, signal: options?.signal });
  return overriding<Sync>(sync, {
    job: <Input>(config: JobConfig): Job<Input> => {
      const job = sync.job<Input>(config);
      return overriding(job, { process: (options, handler) => follow(() => job.process(options, handler), options) });
    },
    queue: <T>(config: QueueConfig): Queue<T> => {
      const queue = sync.queue<T>(config);
      return overriding(queue, { process: (options, handler) => follow(() => queue.process(options, handler), options) });
    },
    topic: <T>(config: TopicConfig): Topic<T> => {
      const topic = sync.topic<T>(config);
      return overriding(topic, { process: (options, handler) => follow(() => topic.process(options, handler), options) });
    },
    scheduler: (config: SchedulerConfig): Scheduler => {
      const scheduler = sync.scheduler(config);
      return overriding(scheduler, { process: (options) => follow(() => scheduler.process(options), options) });
    },
    pump: <Input, Cursor, Item extends PumpItem>(config: PumpConfig<Input, Cursor, Item>): Pump<Input, Cursor> => {
      const pump = sync.pump<Input, Cursor, Item>(config);
      return overriding(pump, { process: (options) => follow(() => pump.process(options), options) });
    },
  });
};
