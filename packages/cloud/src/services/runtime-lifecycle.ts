import type { Worker } from "@k2b/sync";
import { processQuiesce, type QuiesceController, type QuiesceParticipant } from "./runtime-quiesce";

export type RuntimeTaskTracker = ReturnType<typeof createRuntimeTaskTracker>;

export type RuntimeTaskFailure = {
  error: unknown;
  failureCount: number;
  retryInMs: number;
};

type RuntimeTaskSupervisorOptions = {
  signal: AbortSignal;
  run(signal: AbortSignal): Promise<void>;
  onError?(failure: RuntimeTaskFailure): void;
  minRetryMs?: number;
  maxRetryMs?: number;
  resetAfterMs?: number;
  jitter?: number;
  name?: string;
};

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });

/** Restart a long-lived task after unexpected failure or completion. */
export const superviseRuntimeTask = async (options: RuntimeTaskSupervisorOptions): Promise<void> => {
  const minRetryMs = options.minRetryMs ?? 250;
  const maxRetryMs = options.maxRetryMs ?? 5_000;
  const resetAfterMs = options.resetAfterMs ?? 30_000;
  const jitter = options.jitter ?? 0.2;
  if (![minRetryMs, maxRetryMs, resetAfterMs].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError("Runtime task retry timings must be positive finite numbers");
  }
  if (minRetryMs > maxRetryMs) throw new RangeError("Runtime task minimum retry delay cannot exceed its maximum");
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new RangeError("Runtime task retry jitter must be between 0 and 1");

  let failureCount = 0;
  while (!options.signal.aborted) {
    const startedAt = Date.now();
    let error: unknown;
    try {
      await options.run(options.signal);
      if (options.signal.aborted) return;
      error = new Error(`${options.name ?? "Runtime task"} stopped unexpectedly`);
    } catch (caught) {
      if (options.signal.aborted) return;
      error = caught;
    }

    failureCount = Date.now() - startedAt >= resetAfterMs ? 1 : failureCount + 1;
    const exponentialRetryMs = minRetryMs * 2 ** Math.min(failureCount - 1, 30);
    const retryInMs = Math.min(maxRetryMs, Math.max(minRetryMs, Math.round(exponentialRetryMs * (1 + (Math.random() * 2 - 1) * jitter))));
    try {
      options.onError?.({ error, failureCount, retryInMs });
    } catch {
      // Reporting failures must not stop recovery.
    }
    await waitForRetry(retryInMs, options.signal);
  }
};

/**
 * Track process work outside Sync handlers, such as recovery scans and publishers.
 * While the process is quiesced (maintenance stage „Ruhe“) `run()` accepts
 * nothing and returns `null`, as when closed, and accepted tasks drain.
 */
export const createRuntimeTaskTracker = ({ controller = processQuiesce }: { controller?: QuiesceController } = {}) => {
  const tasks = new Set<Promise<unknown>>();
  let accepting = false;
  let unregister: (() => void) | undefined;

  const drain = async (): Promise<void> => {
    while (tasks.size > 0) await Promise.allSettled([...tasks]);
  };

  const participant: QuiesceParticipant = {
    quiesce: (timeoutMs) => withDeadline(drain(), timeoutMs, `Runtime tasks did not drain within ${timeoutMs}ms`),
    resume: async () => {},
    inFlight: () => tasks.size,
  };

  return {
    open: (): void => {
      accepting = true;
      unregister ??= controller.register(participant);
    },
    close: (): void => {
      accepting = false;
      unregister?.();
      unregister = undefined;
    },
    run: <T>(operation: () => Promise<T>): Promise<T> | null => {
      if (!accepting || controller.quiesced) return null;
      const task = Promise.resolve().then(operation);
      tasks.add(task);
      const remove = () => tasks.delete(task);
      task.then(remove, remove);
      return task;
    },
    drain,
  };
};

const withDeadline = async (work: Promise<void>, timeoutMs: number, message: string): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const isAbort = (error: unknown, signal: AbortSignal): boolean =>
  error === signal.reason || (error instanceof Error && error.name === "AbortError");

/**
 * Run `run` now and every `intervalMs`, one run at a time. While the process
 * is quiesced, ticks are skipped and the run in flight drains; on resume the
 * missed ticks run once, like a scheduler with misfire "latest". `stop()`
 * ends the timer, aborts `signal`, and waits for the run in flight. A failed
 * run goes to `onError`, unless it failed with the abort of `stop()`.
 */
export const startRuntimeInterval = ({
  run,
  intervalMs,
  onError,
  runNow = true,
  controller = processQuiesce,
}: {
  run(signal: AbortSignal): Promise<void>;
  intervalMs: number;
  onError(error: unknown): void;
  /** Run once at start; default true. */
  runNow?: boolean;
  controller?: QuiesceController;
}): { stop(): Promise<void> } => {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("Runtime interval must be positive and finite");
  const tasks = createRuntimeTaskTracker({ controller });
  const abort = new AbortController();
  let active: Promise<void> | null = null;
  let missed = false;
  tasks.open();

  const tick = () => {
    if (abort.signal.aborted || active) return;
    if (controller.quiesced) {
      missed = true;
      return;
    }
    active = tasks.run(async () => {
      try {
        await run(abort.signal);
      } catch (error) {
        // Only the abort that stop() caused is expected; any other failure is reported, also during stop.
        if (!abort.signal.aborted || !isAbort(error, abort.signal)) onError(error);
      }
    });
    void active?.finally(() => {
      active = null;
    });
  };

  // runtime-timer: the platform interval itself; skips ticks while quiesced.
  const timer = setInterval(tick, intervalMs);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  const offChange = controller.onChange((quiesced) => {
    if (quiesced || !missed) return;
    missed = false;
    tick();
  });
  if (runNow) tick();
  else missed = controller.quiesced;

  return {
    stop: async () => {
      clearInterval(timer);
      offChange();
      tasks.close();
      abort.abort();
      await tasks.drain();
    },
  };
};

/**
 * Stop accepting runtime tasks, stop the @k2b/sync workers from pulling new
 * work, then drain accepted process tasks and workers together. Sync owns
 * handler tracking and cancellation; do not wrap worker handlers in tracker.run.
 * Only work outside those handlers uses the tracker and its separate deadline.
 */
export const stopRuntimeJobs = async (
  tracker: Pick<RuntimeTaskTracker, "close" | "drain">,
  workers: ReadonlyArray<Pick<Worker, "stop" | "drain">>,
  options: { timeoutMs?: number } = {},
): Promise<void> => {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Runtime drain timeout must be positive and finite");
  tracker.close();
  const errors: unknown[] = [];
  for (const worker of workers) worker.stop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tracked = Promise.race([
    tracker.drain(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Runtime tasks did not drain within ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
  try {
    for (const result of await Promise.allSettled([tracked, ...workers.map((worker) => worker.drain({ timeoutMs }))])) {
      if (result.status === "rejected") errors.push(result.reason);
    }
  } finally {
    clearTimeout(timer);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Multiple runtime jobs failed to stop");
};

type RuntimeLifecycleHooks = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Start and stop one runtime, serialized. While the process is quiesced
 * (maintenance stage „Ruhe“) a started runtime is stopped and started again
 * on resume; `start()` while quiesced only marks it to start on resume.
 */
export const createRuntimeLifecycle = (
  hooks: RuntimeLifecycleHooks,
  { controller = processQuiesce }: { controller?: QuiesceController } = {},
) => {
  let state: "stopped" | "started" | "cleanup-required" = "stopped";
  // Wanted running, but held stopped by quiesce.
  let held = false;
  let stopping = 0;
  let transition = Promise.resolve();
  let unregister: (() => void) | undefined;

  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const result = transition.then(operation, operation);
    transition = result.catch(() => undefined);
    return result;
  };

  const runStop = async () => {
    state = "cleanup-required";
    stopping += 1;
    try {
      await hooks.stop();
      state = "stopped";
    } finally {
      stopping -= 1;
    }
  };

  const runStart = async () => {
    if (state === "started") return;
    if (state === "cleanup-required") await runStop();

    state = "cleanup-required";
    try {
      await hooks.start();
      state = "started";
    } catch (startError) {
      try {
        await runStop();
      } catch (stopError) {
        throw new AggregateError([startError, stopError], "Runtime startup and cleanup failed");
      }
      throw startError;
    }
  };

  const participant: QuiesceParticipant = {
    quiesce: () =>
      serialize(async () => {
        if (state !== "started") return;
        held = true;
        await runStop();
      }),
    resume: () =>
      serialize(async () => {
        if (!held || controller.quiesced) return;
        held = false;
        await runStart();
      }),
    inFlight: () => stopping,
  };

  return {
    start: (): Promise<void> =>
      serialize(async () => {
        unregister ??= controller.register(participant);
        if (controller.quiesced) {
          held = true;
          return;
        }
        await runStart();
      }),
    stop: (): Promise<void> =>
      serialize(async () => {
        held = false;
        unregister?.();
        unregister = undefined;
        if (state === "stopped") return;
        await runStop();
      }),
  };
};

export const stopRuntimeResources = async (resources: ReadonlyArray<() => void | Promise<void>>): Promise<void> => {
  const errors: unknown[] = [];
  for (const stop of resources) {
    try {
      await stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Multiple runtime resources failed to stop");
};
