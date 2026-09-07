import type { Worker } from "@k2b/sync";

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

/** Track process work outside Sync handlers, such as recovery scans and publishers. */
export const createRuntimeTaskTracker = () => {
  const tasks = new Set<Promise<unknown>>();
  let accepting = false;

  return {
    open: (): void => {
      accepting = true;
    },
    close: (): void => {
      accepting = false;
    },
    run: <T>(operation: () => Promise<T>): Promise<T> | null => {
      if (!accepting) return null;
      const task = Promise.resolve().then(operation);
      tasks.add(task);
      const remove = () => tasks.delete(task);
      task.then(remove, remove);
      return task;
    },
    drain: async (): Promise<void> => {
      while (tasks.size > 0) await Promise.allSettled([...tasks]);
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

export const createRuntimeLifecycle = (hooks: RuntimeLifecycleHooks) => {
  let state: "stopped" | "started" | "cleanup-required" = "stopped";
  let transition = Promise.resolve();

  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const result = transition.then(operation, operation);
    transition = result.catch(() => undefined);
    return result;
  };

  return {
    start: (): Promise<void> =>
      serialize(async () => {
        if (state === "started") return;
        if (state === "cleanup-required") {
          await hooks.stop();
          state = "stopped";
        }

        state = "cleanup-required";
        try {
          await hooks.start();
          state = "started";
        } catch (startError) {
          try {
            await hooks.stop();
            state = "stopped";
          } catch (stopError) {
            throw new AggregateError([startError, stopError], "Runtime startup and cleanup failed");
          }
          throw startError;
        }
      }),
    stop: (): Promise<void> =>
      serialize(async () => {
        if (state === "stopped") return;
        state = "cleanup-required";
        await hooks.stop();
        state = "stopped";
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
