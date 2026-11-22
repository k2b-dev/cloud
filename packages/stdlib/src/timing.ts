// ==========================
// Async Timing Utilities
// ==========================

/**
 * Ensure an async function takes at least `minMs` milliseconds to complete.
 *
 * Useful for preventing UI flicker on fast network requests -- the caller
 * can guarantee a loading spinner is visible for a minimum duration.
 *
 * If `fn` throws, the error propagates to the caller unchanged; the minimum
 * delay still applies before the rejection is surfaced.
 *
 * **Side effect:** uses `setTimeout` internally for the padding delay.
 *
 * @param fn    - The async function to execute.
 * @param minMs - Minimum execution time in milliseconds (default: 300).
 * @returns The result of `fn`.
 *
 * @example
 * const data = await timing.withMinLoadTime(() => fetchData(), 500);
 */
export const withMinLoadTime = async <T>(
  fn: () => Promise<T>,
  minMs: number = 300,
): Promise<T> => {
  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;

  if (elapsed < minMs) {
    await new Promise((resolve) => setTimeout(resolve, minMs - elapsed));
  }

  return result;
};

/**
 * Create a write-coalescing buffer that batches writes per key.
 *
 * When the returned function is called, the data is stored in an internal
 * `Map` under the given key. A `setTimeout` is started on the first write
 * for that key; subsequent writes within the interval replace the cached
 * value but do **not** reset the timer. After `intervalMs` elapses the
 * flush function `fn` is called with the **latest** cached value.
 *
 * **Error behaviour:** if `fn` rejects, the error is logged to
 * `console.error` and the cached data is **preserved** (not deleted) so it
 * can be retried on the next write.
 *
 * **Side effects:** maintains internal `Map` state for cached data and
 * active timers; uses `setTimeout` for deferred flushing.
 *
 * @param fn         - The flush function called with `(key, latestData)`.
 * @param intervalMs - Delay before flushing in milliseconds (default: 5000).
 * @returns A function `(key, data) => void` to buffer writes by key.
 *
 * @example
 * const save = timing.buffer(
 *   async (key, data) => await api.save(key, data),
 *   2000
 * );
 * save("doc-1", { title: "Draft" }); // buffered
 * save("doc-1", { title: "Final" }); // replaces previous, flushes after 2s
 */
export const buffer = <T>(
  fn: (key: string, data: T) => Promise<void>,
  intervalMs: number = 5000,
): ((key: string, data: T) => void) => {
  const cache = new Map<string, T>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Per-key write counter. The flush snapshots the counter at fire time and
  // only clears `cache` if no newer write came in during the async fn.
  const seq = new Map<string, number>();

  return (key: string, data: T) => {
    cache.set(key, data);
    seq.set(key, (seq.get(key) ?? 0) + 1);
    if (timers.has(key)) return;

    timers.set(
      key,
      setTimeout(() => {
        // Always free the timer slot first so the NEXT write can schedule
        // its own timer (this prevents the `buffer("k", undefined)` deadlock
        // and is also part of the in-flight-write race fix).
        timers.delete(key);
        if (!cache.has(key)) return;
        const latest = cache.get(key) as T;
        const seqAtFire = seq.get(key)!;

        void (async () => {
          try {
            await fn(key, latest);
          } catch (e) {
            console.error(`buffer flush failed for key "${key}":`, e);
          } finally {
            // Only clear cache if no new write arrived during the flush. If
            // a newer write is queued, that write already scheduled a fresh
            // timer (since `timers` was cleared at flush start), so leaving
            // the cache populated lets that timer pick up the newer value.
            if (seq.get(key) === seqAtFire) {
              cache.delete(key);
              seq.delete(key);
            }
          }
        })();
      }, intervalMs),
    );
  };
};

/**
 * Add cryptographically-sourced random jitter to a numeric value.
 *
 * Produces a uniformly distributed offset in the range `[-range, +range]`
 * and adds it to `value`. Useful for retry backoff, animation stagger, and
 * distributed timer spread.
 *
 * **Side effect:** calls `crypto.getRandomValues` to obtain randomness.
 *
 * @param value - The base value to add jitter to.
 * @param range - The maximum absolute offset (e.g. 5 gives -5 to +5).
 * @returns `value` with a random offset applied.
 *
 * @example
 * timing.jitter(100, 10); // Returns a number between 90 and 110
 * timing.jitter(1000, 200); // Retry delay with jitter
 */
export const jitter = (value: number, range: number): number => {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const random = array[0]! / (0xFFFFFFFF + 1);
  const randomOffset = (random - 0.5) * 2 * range;
  return value + randomOffset;
};

// ==========================
// Sleep
// ==========================

/**
 * Pause execution for a given number of milliseconds.
 *
 * Returns a promise that resolves after the delay. Commonly used to add
 * artificial delays for rate-limiting, animation sequencing, or retry backoff.
 *
 * **Side effect:** registers a `setTimeout`.
 *
 * @example
 * await timing.sleep(500);                         // wait 500 ms
 * await timing.sleep(1000 + timing.jitter(0, 200)); // wait ~1 s with jitter
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ==========================
// Random
// ==========================

/**
 * Generate a random number in a range with optional step rounding.
 *
 * Returns a uniformly distributed value in `[min, max)`. When `step` is
 * provided, the result is rounded to the nearest multiple of `step`.
 * Uses `Math.random` — not suitable for cryptographic purposes.
 *
 * @example
 * timing.random();              // 0 – 1   (like Math.random)
 * timing.random(1, 10);         // 1 – 10  (float)
 * timing.random(1, 10, 1);      // 1 – 10  (integer)
 * timing.random(0, 100, 5);     // 0, 5, 10, … 100
 */
export const random = (min: number = 0, max: number = 1, step?: number): number => {
  const value = Math.random() * (max - min) + min;
  if (step) return Math.round(value / step) * step;
  return value;
};

/**
 * Randomly shuffle an array using the Fisher-Yates algorithm.
 *
 * Returns a **new** array — the original is not modified.
 * Uses `Math.random` — not suitable for cryptographic purposes.
 * For a cryptographically secure shuffle, see `crypto.secureShuffle`.
 *
 * @example
 * timing.shuffle([1, 2, 3, 4, 5]); // e.g. [3, 1, 5, 2, 4]
 */
export const shuffle = <T>(array: readonly T[]): T[] => {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
};

/**
 * Create a debounced function that delays invocation until `delayMs` after the last call.
 *
 * Repeated calls within the delay window reset the timer. Only the last call's
 * arguments are used when the function finally fires.
 *
 * @param fn - Function to debounce.
 * @param delayMs - Delay in milliseconds.
 * @returns Object with `call` (debounced function), `cancel`, `flush`, and `isPending`.
 */
export const debounce = <T extends (...args: any[]) => any>(
  fn: T,
  delayMs: number,
): { call: (...args: Parameters<T>) => void; cancel: () => void; flush: () => void; isPending: () => boolean } => {
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  const cancel = () => {
    if (timerId !== null) { clearTimeout(timerId); timerId = null; }
    lastArgs = null;
  };

  const flush = () => {
    if (timerId !== null && lastArgs !== null) {
      clearTimeout(timerId);
      timerId = null;
      fn(...lastArgs);
      lastArgs = null;
    }
  };

  const call = (...args: Parameters<T>) => {
    lastArgs = args;
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(() => {
      timerId = null;
      if (lastArgs !== null) { fn(...lastArgs); lastArgs = null; }
    }, delayMs);
  };

  return { call, cancel, flush, isPending: () => timerId !== null };
};

/**
 * Create a throttled function that invokes at most once per `intervalMs`.
 *
 * The first call fires immediately. Subsequent calls within the interval
 * are dropped. After the interval passes, the next call fires immediately again.
 *
 * @param fn - Function to throttle.
 * @param intervalMs - Minimum interval between invocations in milliseconds.
 * @returns Object with `call` (throttled function) and `cancel`.
 */
export const throttle = <T extends (...args: any[]) => any>(
  fn: T,
  intervalMs: number,
): { call: (...args: Parameters<T>) => void; cancel: () => void } => {
  let lastCall = 0;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timerId !== null) { clearTimeout(timerId); timerId = null; }
  };

  const call = (...args: Parameters<T>) => {
    const now = Date.now();
    const elapsed = now - lastCall;
    if (elapsed >= intervalMs) {
      lastCall = now;
      fn(...args);
    } else if (timerId === null) {
      timerId = setTimeout(() => {
        lastCall = Date.now();
        timerId = null;
        fn(...args);
      }, intervalMs - elapsed);
    }
  };

  return { call, cancel };
};

export const timing = {
  withMinLoadTime,
  buffer,
  jitter,
  sleep,
  random,
  shuffle,
  debounce,
  throttle,
} as const;
