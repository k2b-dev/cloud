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
  TopicProcessOptions,
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
 * registration order, then tells the listeners and lets the work resume in
 * parallel. A lifecycle registers when it is first started, so a runtime that
 * another one starts stops before it and starts after it, and no handler
 * meets a stopped runtime. Each runtime stop and each resume attempt has the
 * step budget (`stepBudgetMs`); one that runs longer is reported and the
 * transition goes on with the next one, so one slow runtime never holds the
 * others running or stopped.
 *
 * Work counts as in flight until it has really ended: a worker whose handlers
 * ignore the abort of a timed-out drain, and a tracker or worker that left
 * the controller with work still running, keep counting. No `process()` of
 * the same primitive starts a new generation before the old handlers ended,
 * also when its owner created a new handle meanwhile; after twice the step
 * budget the wait fails, and the process restarts, the only end for a handler
 * that ignores its abort.
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
/** How often a new worker generation checks whether the old one is idle, at most. */
const IDLE_CHECK_MS = 250;
/** After a drain's budget, Sync aborts the handlers and gives them about this long to end. */
const SYNC_ABANDON_MS = 1_000;

/**
 * The budget of one transition step (a runtime stop, a resume attempt): the
 * drain budget plus the time Sync gives aborted handlers, so a step that
 * drains within its own budget is never cut short.
 */
export const stepBudgetMs = (timeoutMs: number): number => timeoutMs + Math.min(SYNC_ABANDON_MS, timeoutMs);

/** A drain, a runtime stop, or a resume attempt ran past its budget. The work goes on and still counts as in flight. */
export class QuiesceTimeoutError extends Error {
  override name = "QuiesceTimeoutError";
}

/**
 * Old handlers of a worker still run after the new generation waited twice
 * the step budget for them. Retrying cannot help; the process restarts.
 */
export class StuckWorkerError extends Error {
  override name = "StuckWorkerError";
}

/** Whether `error` is a timeout only (also all of an `AggregateError`): the work goes on, nothing failed. */
export const isQuiesceTimeout = (error: unknown): boolean =>
  error instanceof QuiesceTimeoutError ||
  (error instanceof AggregateError && error.errors.length > 0 && error.errors.every((inner) => isQuiesceTimeout(inner)));

/** `work`, or a `QuiesceTimeoutError` with `message` after `timeoutMs`; `work` keeps running either way. */
export const withDeadline = async <T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        // runtime-timer: the deadline of one drain or transition step, not background work.
        timer = setTimeout(() => reject(new QuiesceTimeoutError(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

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

/**
 * Set inside `superviseRuntimeTask()`: a worker created there resumes like
 * the supervisor retries. Transitions run outside it, so a lifecycle that
 * resume starts never inherits it from the maintenance watcher.
 */
const supervised = new AsyncLocalStorage<true>();

/**
 * Runs `run` as supervised work: a worker it creates retries its resume
 * without a limit, as `superviseRuntimeTask()` retries the work itself.
 */
export const runSupervised = <T>(run: () => T): T => supervised.run(true, run);

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
  const stepMs = stepBudgetMs(timeoutMs);
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

  const tell = (state: boolean) => {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        // A listener never stops the transition.
      }
    }
  };

  const wake = () => {
    for (const waker of wakers) waker();
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
        // A stop past its budget goes on and counts as in flight; the next runtime stops meanwhile.
        await withDeadline(
          runtime.quiesce(timeoutMs),
          stepMs,
          `A runtime did not stop within ${stepMs}ms; it counts as in flight until it has`,
        );
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
        // An attempt past its budget is reported like a failure; the next one queues behind it.
        await withDeadline(participant.resume(), stepMs, `Background work did not start again within ${stepMs}ms`);
        return undefined;
      } catch (error) {
        // A newer transition or the participant's own stop supersedes this resume.
        if (epoch !== mine || !participants.has(participant)) return undefined;
        if (error instanceof StuckWorkerError) return error;
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

  const runResume = async (
    mine: number,
    onRetry: ((retry: ResumeRetry) => void) | undefined,
    onLateFailure: ((failure: unknown) => void) | undefined,
  ): Promise<unknown[]> => {
    const failures: unknown[] = [];
    for (const runtime of ofLayer("runtime")) {
      if (epoch !== mine) return failures;
      const failure = await resumeOne(runtime, mine, onRetry);
      if (failure !== undefined) failures.push(failure);
    }
    if (epoch !== mine) return failures;
    // Own loops start again once the runtimes they may use run.
    tell(false);
    const work = ofLayer("work");
    // A persistent participant retries on its own; it never holds up the resume, and fails only on stuck handlers.
    for (const participant of work) {
      if (!participant.persistent) continue;
      void resumeOne(participant, mine, onRetry).then((failure) => {
        if (failure === undefined) return;
        try {
          onLateFailure?.(failure);
        } catch {
          // Reporting never throws into the resume.
        }
      });
    }
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
    /** The budget of one transition step; see `stepBudgetMs`. */
    stepMs,
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
     * drain or runtime stop included); it never rejects, the process stays
     * quiet either way. Listeners hear `true` at once.
     */
    quiesce: (): Promise<unknown[]> => {
      if (quiesced) return draining;
      quiesced = true;
      const mine = ++epoch;
      // The drain runs outside any caller context, such as the supervised maintenance watcher.
      return supervised.exit(() => {
        wake();
        tell(true);
        draining = transition.then(() => runQuiesce(mine));
        transition = draining;
        return draining;
      });
    },
    /**
     * Take background work again, after a drain still running. Idempotent.
     * Each participant gets `QUIESCE_RESUME_ATTEMPTS` tries of one step budget
     * each; resolves with the ones that still failed. The caller decides (an
     * app process restarts). Listeners hear `false` once the runtimes run. A
     * persistent participant that cannot end its old handlers goes to
     * `onLateFailure`, after the resume resolved.
     */
    resume: ({
      onRetry,
      onLateFailure,
    }: {
      onRetry?(retry: ResumeRetry): void;
      onLateFailure?(failure: unknown): void;
    } = {}): Promise<unknown[]> => {
      if (!quiesced) return resuming;
      quiesced = false;
      const mine = ++epoch;
      // Outside any caller context: a worker that a resumed runtime creates is not supervised by the watcher's supervisor.
      return supervised.exit(() => {
        wake();
        resuming = transition.then(() => runResume(mine, onRetry, onLateFailure));
        transition = resuming;
        return resuming;
      });
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
      wake();
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

/** A worker generation that ended (quiesce, stop, drain, abort), kept while its drain runs or a handler still runs. */
type Retired = { worker: Worker; settled: boolean; drained: Promise<void> | undefined };

/**
 * The retired generations of one primitive (kind, owner, id, consumer) in
 * this process. Every handle of the primitive shares it, so a new `process()`
 * waits for handlers that an earlier handle left running.
 */
export type WorkerLineage = { name: string; retired: Set<Retired>; waitingSince: number | undefined };

export const createWorkerLineage = (name: string): WorkerLineage => ({ name, retired: new Set(), waitingSince: undefined });

const busy = (entry: Retired) => !entry.settled || entry.worker.active > 0;

const pruneRetired = (retired: Set<Retired>) => {
  for (const entry of retired) if (!busy(entry)) retired.delete(entry);
};

/**
 * Resolves once no retired generation of `lineage` runs a handler, or once
 * `stop()` says the start is no longer wanted. Throws `StuckWorkerError` when
 * old handlers still run twice the step budget after the waiting began; a
 * later wait of the same lineage fails at once until they end.
 */
const awaitOlderGenerations = async (lineage: WorkerLineage, controller: QuiesceController, stop: () => boolean): Promise<void> => {
  const budgetMs = 2 * controller.stepMs;
  const stepMs = Math.max(1, Math.min(IDLE_CHECK_MS, Math.floor(budgetMs / 8)));
  for (;;) {
    pruneRetired(lineage.retired);
    if (lineage.retired.size === 0) {
      lineage.waitingSince = undefined;
      return;
    }
    if (controller.quiesced) {
      // Quiet again: the next resume waits afresh.
      lineage.waitingSince = undefined;
      return;
    }
    if (stop()) {
      // This waiter is gone; a later one measures its own wait.
      lineage.waitingSince = undefined;
      return;
    }
    // A generation ended by `stop()` alone was never drained, so its handlers never got their abort: drain it now,
    // so the wait below judges handlers that ignore the abort, not ones that were never told.
    for (const entry of lineage.retired) {
      if (entry.drained !== undefined) continue;
      entry.settled = false;
      entry.drained = entry.worker
        .drain({ timeoutMs: controller.timeoutMs })
        .catch(() => undefined)
        .finally(() => {
          entry.settled = true;
        });
    }
    lineage.waitingSince ??= Date.now();
    const waitedMs = Date.now() - lineage.waitingSince;
    if (waitedMs >= budgetMs) {
      let handlers = 0;
      for (const entry of lineage.retired) handlers += entry.worker.active;
      throw new StuckWorkerError(
        `A worker of ${lineage.name} still runs ${handlers} handler(s) of an earlier generation ${waitedMs}ms after its next generation began to wait; only a restart ends a handler that ignores its abort`,
      );
    }
    await Bun.sleep(stepMs);
  }
};

/**
 * A worker that stops and drains on quiesce and is created again with
 * `start` on resume. The handle the caller holds stays the same; `stop()`,
 * `drain()` and an aborted `signal` end it for good. Created while quiesced,
 * it starts on resume. A generation whose handlers outlive their drain or the
 * handle's end keeps counting as in flight, and no generation of the same
 * `lineage` starts before they ended.
 */
export const quiesceWorker = async (
  start: () => Promise<Worker>,
  {
    controller = processQuiesce,
    signal,
    lineage = createWorkerLineage("a primitive"),
  }: { controller?: QuiesceController; signal?: AbortSignal; lineage?: WorkerLineage } = {},
): Promise<Worker> => {
  let current: Worker | undefined;
  /** The generations of this handle that ended; each is also in `lineage`. */
  const own = new Set<Retired>();
  let starting: Promise<void> | undefined;
  let closed = false;

  const ended = () => closed || signal?.aborted === true;

  /** The generation `end()` retired; `drain()` drains it, also after `stop()`. */
  let last: Retired | undefined;

  const running = (): number => {
    pruneRetired(own);
    let total = current?.active ?? 0;
    for (const entry of own) total += entry.worker.active;
    return total;
  };

  const retireEntry = (worker: Worker): Retired => {
    const entry: Retired = { worker, settled: true, drained: undefined };
    own.add(entry);
    lineage.retired.add(entry);
    return entry;
  };

  const drainEntry = (entry: Retired, drain: () => Promise<void>): Promise<void> => {
    entry.settled = false;
    const drained = drain().finally(() => {
      entry.settled = true;
    });
    entry.drained = drained.catch(() => undefined);
    return drained;
  };

  /** Stops `worker` and drains it; rejects when handlers still run after the drain. */
  const retire = async (worker: Worker, timeoutMs: number): Promise<void> => {
    worker.stop();
    await drainEntry(retireEntry(worker), () => worker.drain({ timeoutMs }));
    const left = worker.active;
    if (left > 0)
      throw new QuiesceTimeoutError(
        `A worker still runs ${left} handler(s) ${timeoutMs}ms after its drain began; it counts as in flight until they end`,
      );
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

  /** Never two generations at once: waits for the old handlers of the lineage first. Starts in the same tick when there are none. */
  const startNext = async (): Promise<void> => {
    pruneRetired(lineage.retired);
    if (lineage.retired.size === 0) {
      // The old handlers ended: an earlier stuck verdict no longer applies to this lineage.
      lineage.waitingSince = undefined;
    } else {
      await awaitOlderGenerations(lineage, controller, ended);
      // An earlier resume attempt that waited too launched meanwhile: this attempt shares its start and its failure.
      if (starting) return starting;
      if (ended() || controller.quiesced || current) return;
    }
    await launch();
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
      if (ended() || controller.quiesced || current || starting) return;
      await startNext();
    },
    inFlight: running,
  };

  // Registered before the first start, so a quiesce during that start still reaches the worker.
  const unregister = controller.register(participant);
  const end = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", end);
    // The ended generation joins the lineage: its handlers stay counted, and no next `process()` overlaps them.
    const worker = current;
    current = undefined;
    if (worker) {
      worker.stop();
      last = retireEntry(worker);
    }
    unregister();
  };
  signal?.addEventListener("abort", end, { once: true });
  if (signal?.aborted) end();

  if (!controller.quiesced && !ended()) {
    try {
      await startNext();
    } catch (error) {
      end();
      throw error;
    }
  }

  const drainAll = async (drain: (worker: Worker) => Promise<void>) => {
    end();
    await starting?.catch(() => undefined);
    const entry = last;
    const mine = entry && entry.drained === undefined ? drainEntry(entry, () => drain(entry.worker)) : undefined;
    await Promise.all([mine, ...[...own].map((retired) => retired.drained)]);
  };

  return {
    get active() {
      return running();
    },
    get capacity() {
      return current?.capacity ?? 0;
    },
    stop: end,
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
 * declarations, submissions, reads and every other member stay Sync's own. All handles of one primitive (and topic
 * consumer) share one lineage, so a handle that a runtime creates again after its stop waits for the old handlers.
 */
export const withQuiesce = (sync: Sync, controller: QuiesceController = processQuiesce): Sync => {
  /** One per primitive and consumer this Sync processed; a handful per application, kept for the life of the Sync. */
  const lineages = new Map<string, WorkerLineage>();
  const follow = (name: string, start: () => Promise<Worker>, options: ProcessOptions | undefined) => {
    let lineage = lineages.get(name);
    if (!lineage) {
      lineage = createWorkerLineage(name);
      lineages.set(name, lineage);
    }
    return quiesceWorker(start, { controller, signal: options?.signal, lineage });
  };
  const named = (kind: string, config: { id: string; owner?: string }) => `${kind} ${config.owner ? `${config.owner}/` : ""}${config.id}`;
  const consumer = (options: TopicProcessOptions) =>
    ` consumer ${options.consumer}${options.tenantId ? ` tenant ${options.tenantId}` : ""}`;
  return overriding<Sync>(sync, {
    job: <Input>(config: JobConfig): Job<Input> => {
      const job = sync.job<Input>(config);
      return overriding(job, { process: (options, handler) => follow(named("job", config), () => job.process(options, handler), options) });
    },
    queue: <T>(config: QueueConfig): Queue<T> => {
      const queue = sync.queue<T>(config);
      return overriding(queue, {
        process: (options, handler) => follow(named("queue", config), () => queue.process(options, handler), options),
      });
    },
    topic: <T>(config: TopicConfig): Topic<T> => {
      const topic = sync.topic<T>(config);
      return overriding(topic, {
        process: (options, handler) =>
          follow(`${named("topic", config)}${consumer(options)}`, () => topic.process(options, handler), options),
      });
    },
    scheduler: (config: SchedulerConfig): Scheduler => {
      const scheduler = sync.scheduler(config);
      return overriding(scheduler, { process: (options) => follow(named("scheduler", config), () => scheduler.process(options), options) });
    },
    pump: <Input, Cursor, Item extends PumpItem>(config: PumpConfig<Input, Cursor, Item>): Pump<Input, Cursor> => {
      const pump = sync.pump<Input, Cursor, Item>(config);
      return overriding(pump, { process: (options) => follow(named("pump", config), () => pump.process(options), options) });
    },
  });
};
