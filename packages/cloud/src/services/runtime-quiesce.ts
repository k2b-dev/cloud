import { AsyncLocalStorage } from "node:async_hooks";
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
 * (`maintenance-quiesce.ts`). Requests keep being answered; a request that
 * waits for a worker (an AI turn, a preview, shared-text persistence) waits
 * until resume.
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
 * Order. Quiesce first drains all work (workers, trackers, outboxes) in
 * parallel, then stops the runtime lifecycles one at a time, the last
 * registered first. Resume starts the lifecycles one at a time in
 * registration order, then lets the work resume in parallel. A lifecycle
 * registers when it is first started, so a runtime that another one starts
 * stops before it and starts after it, and no handler meets a stopped runtime.
 *
 * Work counts as in flight until it has really ended: a worker whose handlers
 * ignore the abort of a timed-out drain, and a tracker or worker that left
 * the controller with work still running, keep counting, and a worker starts
 * no new generation before the old one is idle.
 *
 * Own loops that fit none of these read `backgroundWork`.
 */

/** Same budget as `stopRuntimeJobs()`. */
export const QUIESCE_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Resume tries a participant that fails to start this often before it
 * reports the failure (and `app.start()` restarts the process). Waits double
 * from `QUIESCE_RESUME_RETRY_MS`: 4 + 8 + 16 + 32 s, about a minute in all,
 * enough for a NATS or Postgres failover. Jittered by ±20 %.
 */
export const QUIESCE_RESUME_ATTEMPTS = 5;
export const QUIESCE_RESUME_RETRY_MS = 4_000;
/** A persistent participant retries without a limit, at most this far apart. */
const PERSISTENT_RETRY_MAX_MS = 32_000;
const RETRY_JITTER = 0.2;
/** How often a resuming worker checks whether its old generation is idle. */
const IDLE_CHECK_MS = 250;

export type QuiesceParticipant = {
  /**
   * `work` (Sync workers, trackers, outboxes) drains in parallel before any
   * `runtime` (a runtime lifecycle) stops, and resumes after every runtime started.
   */
  layer: "work" | "runtime";
  /** Stop taking new work and wait for work in flight, at most `timeoutMs`. */
  quiesce(timeoutMs: number): Promise<void>;
  /** Take new work again. A rejection means the participant could not resume yet; resume retries it. */
  resume(): Promise<void>;
  /** Units of work still running: handlers, tracked tasks, a lifecycle that is stopping. */
  inFlight(): number;
  /** Resume retries it without a limit instead of reporting a failure (a worker inside `superviseRuntimeTask()`). */
  persistent?: boolean;
};

export type ResumeRetry = { error: unknown; attempt: number; retryInMs: number };

export type QuiesceController = ReturnType<typeof createQuiesceController>;

const retryDelay = (baseMs: number, attempt: number, maxMs: number) =>
  Math.round(Math.min(maxMs, baseMs * 2 ** Math.min(attempt - 1, 20)) * (1 + (Math.random() * 2 - 1) * RETRY_JITTER));

export const createQuiesceController = ({
  timeoutMs = QUIESCE_DRAIN_TIMEOUT_MS,
  retryMs = QUIESCE_RESUME_RETRY_MS,
}: {
  timeoutMs?: number;
  /** First wait between resume attempts; tests shorten it. */
  retryMs?: number;
} = {}) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Quiesce drain timeout must be positive and finite");
  if (!Number.isFinite(retryMs) || retryMs <= 0) throw new RangeError("Quiesce resume retry delay must be positive and finite");
  const participants = new Set<QuiesceParticipant>();
  /** Unregistered with work still running: counted until it ends, never transitioned again. */
  const leaving = new Set<QuiesceParticipant>();
  const listeners = new Set<(quiesced: boolean) => void>();
  const wakers = new Set<() => void>();
  let quiesced = false;
  /** Changes with every transition; a step of an older transition stops when it sees a newer one. */
  let epoch = 0;
  let transition: Promise<unknown> = Promise.resolve();
  let draining: Promise<unknown[]> = Promise.resolve([]);
  let resuming: Promise<unknown[]> = Promise.resolve([]);

  const notify = () => {
    for (const wake of wakers) wake();
    for (const listener of listeners) {
      try {
        listener(quiesced);
      } catch {
        // A listener never stops the transition.
      }
    }
  };

  const prune = () => {
    for (const participant of leaving) if (participant.inFlight() <= 0) leaving.delete(participant);
  };

  /** Waits `ms`, or less when the next transition starts. */
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wakers.delete(done);
        resolve();
      };
      // runtime-timer: the retry wait of resume itself; a transition ends it early.
      const timer = setTimeout(done, ms);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      wakers.add(done);
    });

  const ofLayer = (layer: QuiesceParticipant["layer"]) => [...participants].filter((participant) => participant.layer === layer);

  const runQuiesce = async (mine: number): Promise<unknown[]> => {
    const errors: unknown[] = [];
    const work = await Promise.allSettled(ofLayer("work").map((participant) => participant.quiesce(timeoutMs)));
    for (const result of work) if (result.status === "rejected") errors.push(result.reason);
    for (const runtime of ofLayer("runtime").reverse()) {
      // A resume that arrived meanwhile keeps the runtimes that still run.
      if (epoch !== mine) break;
      try {
        await runtime.quiesce(timeoutMs);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };

  /** Resumes one participant, retrying with backoff. Resolves with its failure, or undefined. */
  const resumeOne = async (
    participant: QuiesceParticipant,
    mine: number,
    onRetry: ((retry: ResumeRetry) => void) | undefined,
  ): Promise<unknown> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await participant.resume();
        return undefined;
      } catch (error) {
        // A newer transition or the participant's own stop supersedes this resume.
        if (epoch !== mine || !participants.has(participant)) return undefined;
        if (!participant.persistent && attempt >= QUIESCE_RESUME_ATTEMPTS) return error;
        const retryInMs = retryDelay(retryMs, attempt, participant.persistent ? PERSISTENT_RETRY_MAX_MS : Number.POSITIVE_INFINITY);
        try {
          onRetry?.({ error, attempt, retryInMs });
        } catch {
          // Reporting never stops the retry.
        }
        await pause(retryInMs);
        if (epoch !== mine || !participants.has(participant)) return undefined;
      }
    }
  };

  const runResume = async (mine: number, onRetry: ((retry: ResumeRetry) => void) | undefined): Promise<unknown[]> => {
    const failures: unknown[] = [];
    for (const runtime of ofLayer("runtime")) {
      if (epoch !== mine) return failures;
      const failure = await resumeOne(runtime, mine, onRetry);
      if (failure !== undefined) failures.push(failure);
    }
    if (epoch !== mine) return failures;
    const work = ofLayer("work");
    // A persistent participant retries on its own; it never holds up or fails the resume.
    for (const participant of work) if (participant.persistent) void resumeOne(participant, mine, onRetry);
    const results = await Promise.all(
      work.filter((participant) => !participant.persistent).map((participant) => resumeOne(participant, mine, onRetry)),
    );
    for (const failure of results) if (failure !== undefined) failures.push(failure);
    return failures;
  };

  return {
    get quiesced(): boolean {
      return quiesced;
    },
    /** The drain budget of every participant. */
    timeoutMs,
    /**
     * Participants consult `quiesced` when they start; this only adds them to
     * later transitions. Unregistering with work still running keeps that
     * work counted in `inFlight()` until it ends.
     */
    register: (participant: QuiesceParticipant): (() => void) => {
      leaving.delete(participant);
      participants.add(participant);
      prune();
      return () => {
        if (participants.delete(participant) && participant.inFlight() > 0) leaving.add(participant);
        prune();
      };
    },
    /**
     * Stop new background work and drain what runs. Idempotent: a second call
     * returns the running drain. Resolves with the drain errors (a timed-out
     * drain included); it never rejects, the process stays quiet either way.
     */
    quiesce: (): Promise<unknown[]> => {
      if (quiesced) return draining;
      quiesced = true;
      const mine = ++epoch;
      notify();
      draining = transition.then(() => runQuiesce(mine));
      transition = draining;
      return draining;
    },
    /**
     * Take background work again, after a drain still running. Idempotent.
     * Each participant gets `QUIESCE_RESUME_ATTEMPTS` tries; resolves with
     * the ones that still failed. The caller decides (an app process restarts).
     */
    resume: ({ onRetry }: { onRetry?(retry: ResumeRetry): void } = {}): Promise<unknown[]> => {
      if (!quiesced) return resuming;
      quiesced = false;
      const mine = ++epoch;
      notify();
      resuming = transition.then(() => runResume(mine, onRetry));
      transition = resuming;
      return resuming;
    },
    /**
     * Clear quiet without resuming anyone: the maintenance watcher of this
     * process stopped (shutdown, an in-process restart, a test), and nothing
     * may stay quiet behind a watcher that no longer follows the record.
     * Participants that went quiet stay stopped until their owners stop them,
     * and listeners are not called, so a process that shuts down starts no
     * background work; work started later sees `quiesced` false.
     */
    release: (): void => {
      if (!quiesced) return;
      quiesced = false;
      epoch += 1;
      for (const wake of wakers) wake();
    },
    /** Work still running in this process; 0 while quiesced means quiet. */
    inFlight: (): number => {
      prune();
      let total = 0;
      for (const participant of participants) total += participant.inFlight();
      for (const participant of leaving) total += participant.inFlight();
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

const supervised = new AsyncLocalStorage<true>();

/**
 * Runs `run` as supervised work: a worker it creates retries its resume
 * without a limit, as `superviseRuntimeTask()` retries the work itself.
 */
export const runSupervised = <T>(run: () => T): T => supervised.run(true, run);

/** A worker retired by quiesce or by its end, kept until its drain settled and its last handler ended. */
type Retired = { worker: Worker; settled: boolean; drained: Promise<void> };

/**
 * A worker that stops and drains on quiesce and is created again with
 * `start` on resume. The handle the caller holds stays the same; `stop()`,
 * `drain()` and an aborted `signal` end it for good. Created while quiesced,
 * it starts on resume. A generation whose handlers outlive their drain keeps
 * counting as in flight, and resume starts the next one only once it is idle.
 */
export const quiesceWorker = async (
  start: () => Promise<Worker>,
  { controller = processQuiesce, signal }: { controller?: QuiesceController; signal?: AbortSignal } = {},
): Promise<Worker> => {
  let current: Worker | undefined;
  const retired = new Set<Retired>();
  let starting: Promise<void> | undefined;
  let closed = false;

  const ended = () => closed || signal?.aborted === true;

  const running = (): number => {
    let total = current?.active ?? 0;
    for (const entry of retired) {
      if (entry.settled && entry.worker.active <= 0) retired.delete(entry);
      else total += entry.worker.active;
    }
    return total;
  };

  const idle = (): boolean => {
    running();
    return retired.size === 0;
  };

  /** Stops `worker` and drains it; rejects when handlers still run after the drain. */
  const retire = async (worker: Worker, timeoutMs: number): Promise<void> => {
    worker.stop();
    const entry: Retired = { worker, settled: false, drained: Promise.resolve() };
    const drain = worker.drain({ timeoutMs }).finally(() => {
      entry.settled = true;
    });
    entry.drained = drain.catch(() => undefined);
    retired.add(entry);
    await drain;
    const left = worker.active;
    if (left > 0)
      throw new Error(`A worker still runs ${left} handler(s) ${timeoutMs}ms after its drain began; it counts as in flight until they end`);
  };

  /** Start a worker. One that arrives after a quiesce is retired by that quiesce; one after an end is retired here. */
  const launch = (): Promise<void> => {
    starting = (async () => {
      const worker = await start();
      if (ended()) await retire(worker, controller.timeoutMs).catch(() => undefined);
      else current = worker;
    })().finally(() => {
      starting = undefined;
    });
    return starting;
  };

  const participant: QuiesceParticipant = {
    layer: "work",
    persistent: supervised.getStore() === true,
    quiesce: async (timeoutMs) => {
      await starting?.catch(() => undefined);
      const worker = current;
      current = undefined;
      if (worker) await retire(worker, timeoutMs);
    },
    resume: async () => {
      await starting?.catch(() => undefined);
      // Never two generations at once: wait until the old handlers ended, or until quiet again.
      while (!idle() && !ended() && !controller.quiesced) await Bun.sleep(IDLE_CHECK_MS);
      if (ended() || controller.quiesced || current || starting) return;
      await launch();
    },
    inFlight: running,
  };

  // Registered before the first start, so a quiesce during that start still reaches the worker.
  const unregister = controller.register(participant);
  const end = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", end);
    // Handlers still running stay counted until they end.
    unregister();
  };
  signal?.addEventListener("abort", end, { once: true });
  if (signal?.aborted) end();

  if (!controller.quiesced && !ended()) {
    try {
      await launch();
    } catch (error) {
      end();
      throw error;
    }
  }

  const drainAll = async (drain: (worker: Worker) => Promise<void>) => {
    end();
    await starting?.catch(() => undefined);
    await Promise.all([current ? drain(current) : undefined, ...[...retired].map((entry) => entry.drained)]);
  };

  return {
    get active() {
      return running();
    },
    get capacity() {
      return current?.capacity ?? 0;
    },
    stop: () => {
      end();
      current?.stop();
    },
    drain: (options) => drainAll((worker) => worker.drain(options)),
    [Symbol.asyncDispose]: () => drainAll((worker) => worker.drain()),
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
