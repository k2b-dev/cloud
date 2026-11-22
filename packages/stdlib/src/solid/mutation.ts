import { type Accessor, batch, createSignal } from "solid-js";

const normalizeError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/** Thrown by `cancel()` in `onBefore` to end the hook immediately. */
class MutationCancelled extends Error {
  override name = "MutationCancelled";
}

/**
 * Where a mutation stands.
 *
 * - `idle`: no call has ended yet and none is running.
 * - `pending`: `mutate()` was called and `onBefore` is still running.
 * - `loading`: the mutation function is running.
 * - `success`, `error`, `aborted`: how the last call ended.
 */
type MutationStatus = "idle" | "pending" | "loading" | "success" | "error" | "aborted";

/**
 * What happens to a call while another one is pending or loading.
 *
 * - `drop` (default): the new call is ignored. It runs nothing, changes no state, runs no hook,
 *   and its Promise resolves `dropped`. A run that was aborted no longer counts.
 * - `replace`: the new call starts anyway. When it reaches its mutation function, it becomes
 *   the source of truth and the result of the older run is discarded (its caller gets
 *   `superseded`); the older work keeps running.
 */
type MutationConcurrency = "drop" | "replace";

/**
 * How one call ended, from the caller's point of view. `mutate()`, `retry()`, and
 * `run.retry()` resolve with it.
 *
 * - `success`: this call's result was committed.
 * - `error`: this call failed in `onBefore` or in the mutation function.
 * - `aborted`: this call was aborted with `abort()` or cancelled in `onBefore`.
 * - `dropped`: this call ran nothing: another call was pending or loading
 *   (`concurrency: "drop"`), or `retry()` had nothing to repeat.
 * - `superseded`: this call ran, but a newer call replaced it (`concurrency: "replace"`) and
 *   its result was discarded. Its work may have reached the server; `onFinally` ran.
 *
 * Read the outcome instead of `error()` or `data()` after `await`: those signals belong to
 * the mutation and may describe another call.
 */
type MutationOutcome = "success" | "error" | "aborted" | "dropped" | "superseded";

/** The call that failed, passed to `onError`. */
type MutationRun = {
  /**
   * Repeats exactly this call with its variables, also after other calls have run.
   * A call that failed in `onBefore` runs `onBefore` again; a call that failed in the
   * mutation function reuses its context and skips `onBefore`, like `retry()`.
   * Follows `concurrency`.
   */
  retry: () => Promise<MutationOutcome>;
};

/**
 * Type for the return type of create mutation.
 *
 * @template T - The type of data returned by the mutation.
 * @template V - The type of variables passed to the mutation.
 * @template C - The base type of the context returned by the onBefore hook.
 */
type MutationResult<T, V, C = unknown> = {
  /** Signal returning the mutation data or null */
  data: Accessor<T | null>;
  /**
   * Signal returning the error or null. Read `status()` first: after an abort or a
   * `cancel()` it may still hold the error of an earlier call.
   */
  error: Accessor<Error | null>;
  /** Signal indicating whether the mutation function is running */
  loading: Accessor<boolean>;
  /**
   * Signal with the current stage: `pending` while `onBefore` runs, `loading` while the
   * mutation function runs, then how the last call ended. A throw in `onSuccess` keeps `success`.
   */
  status: Accessor<MutationStatus>;
  /**
   * Signal with the time (ms, from the `now` option) of the last end: success, error, or abort.
   * `null` before the first end. Strictly increasing, so it changes on every end, also for two
   * equal results in a row. It follows the wall clock (`now`); if the clock jumps back, the
   * value can lie in the future, so cap any hold time computed from it.
   */
  settledAt: Accessor<number | null>;
  /**
   * Triggers the mutation with the given variables.
   * Resolves with this call's outcome when it ended, or with `dropped` right away when another
   * call is pending or loading (see `concurrency`).
   * Mutation failures are reported through the outcome, `error`, and `onError`; the Promise
   * rejects with errors thrown by lifecycle hooks or signal consumers.
   * The `onBefore` hook is executed during this call.
   */
  mutate: (vars: V) => Promise<MutationOutcome>;
  /**
   * Aborts the call in flight, if any, and ends it at once: `status()` is `aborted` and
   * `settledAt()` moves synchronously, `onAbort` and `onFinally` run.
   * While `onBefore` is pending, its `signal` fires and its later result is ignored.
   * While the mutation function runs, its `abortSignal` fires so it can stop the work;
   * whatever it returns or throws later is discarded.
   * The mutation accepts a new call right after `abort()`, also under `drop`.
   */
  abort: () => void;
  /**
   * Retries the last started mutation using the same arguments and base context as that call.
   * **Note:** The `onBefore` hook is NOT re‑executed on retry, so any one‑time side effects will not occur again.
   * Follows `concurrency`. Resolves `dropped` when there is nothing to repeat, also when the
   * last call never reached the mutation function (cancelled, aborted while pending, or failed
   * in `onBefore`): it never repeats an older call.
   */
  retry: () => Promise<MutationOutcome>;
};

/**
 * Options for the mutation.
 *
 * @template T - The type of data returned by the mutation function.
 * @template V - The type of variables passed to the mutation function.
 * @template C - The base type of the context returned by the onBefore hook.
 */
type MutationOptions<T, V, C = unknown> = {
  /**
   * The initial value of the mutation.
   * If not provided, the mutation will start with an undefined value.
   * If provided, the initial value will be returned as the data.
   */
  initialData?: T;

  /**
   * What happens to a call while another one is pending or loading. Default `drop`:
   * the new call is ignored. Use `replace` when the newest call must win, for example
   * for autosave or search as you type.
   */
  concurrency?: MutationConcurrency;

  /** Clock for `settledAt`, in milliseconds. Default `Date.now`. */
  now?: () => number;

  /**
   * The mutation function.
   * It receives the mutation variables and a combined context.
   * **Note:** The context will always include an `abortSignal` property.
   * Must return a Promise of type T.
   */
  mutation: (vars: V, ctx: C & { abortSignal: AbortSignal }) => Promise<T>;

  /**
   * Optional hook executed before the mutation starts.
   * It receives the mutation variables and should return a base context (ctx)
   * that will later be extended with the abort signal.
   * It can also return a Promise.
   *
   * Call `cancel()` to call the mutation off, for example when a confirmation is declined.
   * It ends the hook immediately; the call ends as `aborted` without `onError` or `onAbort`,
   * `onFinally` runs without a context, `mutate()` resolves `aborted`, and `retry()` does not
   * repeat it. Write `return cancel()` so TypeScript narrows after it. Ask first, then make
   * optimistic changes, so a cancel has nothing to undo. Calling `cancel()` after the hook
   * ended only throws at that place.
   *
   * `signal` fires when `abort()` ends the call while the hook still runs. Check
   * `signal.aborted` after every `await` and stop before any optimistic change.
   */
  onBefore?: (vars: V, control: { cancel: () => never; signal: AbortSignal }) => C | Promise<C>;

  /**
   * Optional callback executed when the mutation is successful, after `data`,
   * `loading`, and `status` are updated. It receives the mutation result and the combined context.
   * An error thrown here rejects `mutate()` instead of reaching `error` or `onError`;
   * `status` stays `success`.
   */
  onSuccess?: (data: T, ctx?: C & { abortSignal: AbortSignal }) => void;

  /**
   * Optional callback executed if an error occurs during the mutation or in onBefore,
   * after `error`, `loading`, and `status` are updated.
   * It receives the error, the combined context (undefined when onBefore failed),
   * and the failed call, whose `retry()` repeats exactly that call.
   */
  onError?: (error: Error, ctx: (C & { abortSignal: AbortSignal }) | undefined, run: MutationRun) => void;

  /**
   * Optional callback executed if the mutation is aborted, after `loading` and `status`
   * are updated. It receives the combined context.
   * Runs at once when `abort()` is called, or when the mutation function threw an `AbortError`.
   * The context is `undefined` when `abort()` came while `onBefore` was still pending.
   */
  onAbort?: (ctx?: C & { abortSignal: AbortSignal }) => void;

  /**
   * Optional callback executed after the mutation completes,
   * regardless of success, error, or abort.
   * The current run commits its end before this callback. A superseded run leaves the
   * newer run's state unchanged.
   * It receives the combined context. It runs for a superseded call too, but not for a dropped
   * one, so release local busy flags from the outcome of `mutate()`, not only here.
   */
  onFinally?: (ctx?: C & { abortSignal: AbortSignal }) => void;
};

/** Marks the end of an explicitly aborted run. */
const ABORTED: unique symbol = Symbol("aborted");

/**
 * Creates a mutation controller for managing async operations with lifecycle hooks.
 *
 * Provides reactive signals for data, error, loading, status, and settledAt, plus `mutate`,
 * `abort`, and `retry` controls. The `retry()` method re-uses the base context from the previous
 * execution and does NOT call `onBefore` again -- use this for one-time side effects
 * that should not be repeated on retries.
 *
 * By default a call made while another one is pending or loading is dropped
 * (`concurrency: "drop"`). Use `concurrency: "replace"` when the newest call must win.
 *
 * Does not require a SolidJS reactive owner because it registers no owner-bound cleanup.
 *
 * Side effects:
 * - Creates SolidJS signals for `data`, `error`, `loading`, `status`, and `settledAt`.
 * - Allocates an `AbortController` per mutation invocation.
 *
 * @template T - The type of data returned by the mutation.
 * @template V - The type of variables passed to the mutation function.
 * @template C - The base type of the context returned by the onBefore hook.
 *
 * @param options - The options for the mutation.
 * @returns An object containing the mutation signals and functions.
 *
 * @example
 * ```tsx
 * const { data, error, loading, status, mutate, abort, retry } = mutation.create({
 *   mutation: async (vars, { abortSignal }) => {
 *     const res = await fetch(`/api/items`, { signal: abortSignal, method: "POST", body: JSON.stringify(vars) });
 *     return res.json();
 *   },
 *   onSuccess: (data) => console.log("Created:", data),
 *   onError: (err, _ctx, run) => console.error("Failed:", err, "retry with run.retry()"),
 * });
 *
 * // Trigger the mutation
 * mutate({ name: "New Item" });
 *
 * // Abort in-flight request
 * abort();
 *
 * // Retry the last mutation with the same variables
 * retry();
 * ```
 */
const create = <T, V, C = unknown>(options: MutationOptions<T, V, C>): MutationResult<T, V, C> => {
  const concurrency = options.concurrency ?? "drop";
  const now = options.now ?? Date.now;

  // Create signals for data, error, and loading state.
  const [data, setData] = createSignal<T | null>(options.initialData ?? null);
  const [error, setError] = createSignal<Error | null>(null);
  const [loading, setLoading] = createSignal<boolean>(false);
  // Calls whose onBefore is still running, and how the last call ended.
  const [pending, setPending] = createSignal(0);
  const [ended, setEnded] = createSignal<MutationStatus>("idle");
  const [settledAt, setSettledAt] = createSignal<number | null>(null);

  const status: Accessor<MutationStatus> = () => (loading() ? "loading" : pending() > 0 ? "pending" : ended());

  // Plain mirrors, so mutate() never subscribes a caller to the signals.
  // `pendingCalls` counts calls whose onBefore is running and that were not aborted.
  let pendingCalls = 0;
  let lastSettledAt: number | null = null;
  // Ends each pending call at once when abort() is called.
  const pendingAborts = new Set<() => void>();

  // Store the current AbortController so we can cancel the mutation.
  // It is set exactly while the current run's mutation function is running.
  let currentAbortController: AbortController | null = null;
  // Ends the current run at once when abort() is called.
  let abortRun: (() => void) | null = null;

  // Store the last runnable invocation so retry also works when vars are undefined.
  let lastInvocation: { vars: V; baseCtx: C | undefined } | undefined;

  // Anything still running, including a run that was aborted but has not returned yet.
  const inFlight = () => pendingCalls > 0 || currentAbortController !== null;
  // What a new call waits for under "drop": an aborted run no longer blocks.
  const busy = () => pendingCalls > 0 || (currentAbortController !== null && !currentAbortController.signal.aborted);
  const dropped = () => concurrency === "drop" && busy();

  /**
   * Helper to update the data signal safely.
   *
   * SolidJS interprets functions passed to setters as updater functions.
   * Wrapping a function in an arrow function ensures it is stored as a literal value.
   *
   * @param value - The new data value.
   */
  const safeSetData = (value: T) => {
    if (typeof value === "function") {
      setData(() => value);
    } else {
      setData(value as Exclude<T, Function>);
    }
  };

  /** Commits the end of a call together with `update` in one batch. */
  const settle = (outcome: "success" | "error" | "aborted", update: () => void) => {
    const at = lastSettledAt === null ? now() : Math.max(now(), lastSettledAt + 1);
    lastSettledAt = at;
    batch(() => {
      update();
      setEnded(outcome);
      setSettledAt(at);
    });
  };

  /**
   * Ends a call that never reached its mutation function. It is the end of the mutation only
   * when nothing else is in flight; otherwise the running work owns `status()` and `settledAt()`.
   */
  const settleBeforeRun = (outcome: "error" | "aborted", update?: () => void) => {
    const commit = () => {
      setPending(pendingCalls);
      update?.();
    };
    if (inFlight()) batch(commit);
    else settle(outcome, commit);
  };

  /**
   * Private helper that runs the mutation.
   *
   * @param vars - The mutation variables.
   * @param baseCtx - An optional base context. If provided, the onBefore hook is NOT re‑executed.
   */
  const runMutation = async (vars: V, baseCtx?: C): Promise<MutationOutcome> => {
    lastInvocation = { vars, baseCtx };

    // Create a new AbortController for this mutation.
    // Keep local reference so concurrent runs don't interfere.
    const abortController = new AbortController();
    currentAbortController = abortController;
    const isCurrent = () => currentAbortController === abortController;
    // abort() ends this run at once; whatever the function returns later is discarded.
    let wakeAborted!: () => void;
    const abortedRun = new Promise<typeof ABORTED>((resolve) => {
      wakeAborted = () => resolve(ABORTED);
    });

    // Combine the provided base context (if any) with the new abort signal.
    const combinedCtx = {
      ...(baseCtx && typeof baseCtx === "object" ? baseCtx : {}),
      abortSignal: abortController.signal,
    } as C & { abortSignal: AbortSignal };

    // Ends this run before any hook runs, so hooks may start the next call.
    const finish = (outcome: "success" | "error" | "aborted", update?: () => void) => {
      currentAbortController = null;
      settle(outcome, () => {
        update?.();
        setLoading(false);
      });
    };

    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      options.onFinally?.(combinedCtx);
    };

    // Abort-path errors belong to mutate(), including errors from signal consumers.
    let hookFailed: { error: unknown } | undefined;
    abortRun = () => {
      if (abortController.signal.aborted || finalized) return;
      try {
        try {
          // A pending abort hook may already have replaced this snapshotted run.
          // Release it before dispatching listeners, without touching a newer run.
          if (isCurrent()) {
            abortRun = null;
            finish("aborted");
          }
        } finally {
          abortController.abort();
          try {
            options.onAbort?.(combinedCtx);
          } finally {
            finalize();
          }
        }
      } catch (error: unknown) {
        hookFailed = { error };
      } finally {
        wakeAborted();
      }
    };

    try {
      batch(() => {
        setPending(pendingCalls);
        setLoading(true);
        setError(null);
      });
      if (abortController.signal.aborted) {
        if (hookFailed) throw hookFailed.error;
        return "aborted";
      }
      let result: T;
      try {
        const work = options.mutation(vars, combinedCtx);
        // A late rejection of an aborted run has no receiver.
        work.catch(() => {});
        const outcome = await Promise.race([work, abortedRun]);
        // abort() already ended this run: state, onAbort and its outcome are settled.
        if (outcome === ABORTED || abortController.signal.aborted) {
          if (hookFailed) throw hookFailed.error;
          return "aborted";
        }
        result = outcome;
      } catch (err: unknown) {
        // onAbort threw while abort() ended this run: that error is this call's rejection.
        if (hookFailed) throw hookFailed.error;
        // A newer call replaced this run; its outcome is the source of truth.
        if (!isCurrent()) return abortController.signal.aborted ? "aborted" : "superseded";
        // AbortError surfacing as an exception (typical fetch behaviour) is
        // routed to onAbort, not onError, since the user explicitly cancelled.
        const isAbortError = abortController.signal.aborted || (err instanceof Error && err.name === "AbortError");
        if (isAbortError) {
          abortRun = null;
          finish("aborted");
          options.onAbort?.(combinedCtx);
          return "aborted";
        }
        const error = normalizeError(err);
        abortRun = null;
        finish("error", () => setError(error));
        options.onError?.(error, combinedCtx, {
          retry: () => (dropped() ? Promise.resolve("dropped") : runMutation(vars, baseCtx)),
        });
        return "error";
      }

      // If a newer mutation has been kicked off, drop this stale result on
      // the floor — the newer mutation's outcome is the source of truth.
      if (!isCurrent()) return abortController.signal.aborted ? "aborted" : "superseded";

      // The function ignored an abort signal from elsewhere and still returned.
      if (abortController.signal.aborted) {
        abortRun = null;
        finish("aborted");
        options.onAbort?.(combinedCtx);
        return "aborted";
      }
      abortRun = null;
      // Clears an error that a newer call's onBefore wrote while this run was loading.
      finish("success", () => {
        setError(null);
        safeSetData(result);
      });
      options.onSuccess?.(result, combinedCtx);
      return "success";
    } finally {
      // Only reached while still current when a consumer threw before the run ended.
      if (isCurrent()) {
        abortRun = null;
        currentAbortController = null;
        batch(() => {
          setPending(pendingCalls);
          setLoading(false);
        });
      }
      finalize();
    }
  };

  /**
   * Triggers the mutation using the provided variables.
   * This method executes the `onBefore` hook (if provided) to obtain the base context.
   *
   * @param vars - The variables to pass to the mutation function.
   */
  const mutate = async (vars: V): Promise<MutationOutcome> => {
    if (dropped()) return "dropped";
    // An accepted call invalidates the previous retry slot before onBefore can fail or hang.
    lastInvocation = undefined;
    const onBefore = options.onBefore;
    if (!onBefore) return runMutation(vars, undefined);

    let cancelled = false;
    const cancel = (): never => {
      cancelled = true;
      throw new MutationCancelled("Mutation cancelled in onBefore");
    };
    // Fires when abort() ends this call while onBefore runs, so a hook that awaits a question can stop
    // before it changes anything optimistically.
    const beforeController = new AbortController();

    // This call counts as pending until onBefore ends or abort() ends it, whichever is first.
    let counted = true;
    const release = () => {
      if (!counted) return false;
      counted = false;
      pendingCalls--;
      pendingAborts.delete(abortPending);
      return true;
    };
    let wakeAborted!: () => void;
    const aborted = new Promise<"aborted">((resolve) => {
      wakeAborted = () => resolve("aborted");
    });
    // abort() ends this call at once: status and settledAt change synchronously, onAbort and onFinally run now.
    // A throw in either rejects this call's mutate(), not the abort() that ended it.
    let hookFailed: { error: unknown } | undefined;
    const abortPending = () => {
      if (!release()) return;
      try {
        try {
          settleBeforeRun("aborted");
        } finally {
          beforeController.abort();
          try {
            options.onAbort?.(undefined);
          } finally {
            options.onFinally?.(undefined);
          }
        }
      } catch (error: unknown) {
        hookFailed = { error };
      } finally {
        wakeAborted();
      }
    };
    pendingCalls++;
    pendingAborts.add(abortPending);

    try {
      setPending(pendingCalls);
      if (!counted) {
        if (hookFailed) throw hookFailed.error;
        return "aborted";
      }
      const before = await Promise.race([
        (async () => onBefore(vars, { cancel, signal: beforeController.signal }))().then(
          (ctx) => ({ ok: true as const, ctx }),
          (err: unknown) => ({ ok: false as const, error: normalizeError(err) }),
        ),
        aborted,
      ]);

      // release() is false when abort() already ended this call (and settled it), also right after
      // onBefore finished but before this line ran; whatever onBefore returned is ignored then.
      if (before === "aborted" || !release()) {
        if (hookFailed) throw hookFailed.error;
        return "aborted";
      }

      if (cancelled) {
        try {
          settleBeforeRun("aborted");
          return "aborted";
        } finally {
          options.onFinally?.(undefined);
        }
      }
      if (!before.ok) {
        const error = before.error;
        try {
          settleBeforeRun("error", () => setError(error));
          // Context is undefined because onBefore failed before producing a context.
          options.onError?.(error, undefined, { retry: () => mutate(vars) });
          return "error";
        } finally {
          options.onFinally?.(undefined);
        }
      }
      return await runMutation(vars, before.ctx);
    } finally {
      // Only still counted when a consumer threw while this call became pending.
      if (release()) setPending(pendingCalls);
    }
  };

  /**
   * Aborts the call in flight: pending calls end at once, a running mutation function
   * gets its abort signal.
   */
  const abort = () => {
    // Snapshot before hooks run: abort() must not cancel a new run started by an abort hook.
    const running = abortRun;
    const pending = [...pendingAborts];
    for (const abortPending of pending) abortPending();
    running?.();
  };

  /**
   * Retries the last mutation using the same arguments and base context as the previous call.
   * **Note:** The onBefore hook is NOT re‑executed on retry, so any one‑time side effects will not occur again.
   */
  const retry = async (): Promise<MutationOutcome> => {
    if (!lastInvocation || dropped()) return "dropped";
    return runMutation(lastInvocation.vars, lastInvocation.baseCtx);
  };

  return { data, error, loading, status, settledAt, mutate, abort, retry };
};

export const mutation = {
  create,
} as const;

export type { MutationConcurrency, MutationOptions, MutationOutcome, MutationResult, MutationRun, MutationStatus };
