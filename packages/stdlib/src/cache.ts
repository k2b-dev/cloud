/**
 * Generic in-memory cache with automatic TTL expiration.
 *
 * Stores values in a `Map` keyed by string. Each entry expires after a
 * configurable TTL and is automatically purged by a cleanup timer. Ideal
 * for caching API responses, computed results, or any data that is expensive
 * to produce but acceptable to serve slightly stale.
 *
 * Key features:
 * - **Automatic expiration** — entries are removed after their TTL elapses.
 * - **Lazy loading** — provide an `onMiss` callback to populate the cache
 *   transparently on first access.
 * - **Updater functions** — `set` accepts either a direct value or a function
 *   that receives the current value, enabling atomic read-modify-write.
 * - **Cleanup hook** — `beforePurge` is called before an entry is evicted,
 *   useful for persisting dirty data or releasing resources.
 * - **Works everywhere** — no browser or server dependencies.
 *
 * @example
 * import { createCache } from "@k2b/stdlib";
 *
 * // Simple cache with 5-minute TTL
 * const cache = createCache<User>({ ttl: 5 * 60_000 });
 * await cache.set("user:1", { name: "Alice" });
 * const user = await cache.get("user:1"); // User | null
 *
 * @example
 * // Auto-fetching cache with cleanup
 * const cache = createCache<Response>({
 *   ttl: 30 * 60_000,
 *   onMiss: (key) => fetch(`/api/${key}`).then((r) => r.json()),
 *   beforePurge: (key, value) => console.log(`evicted: ${key}`),
 * });
 *
 * const data = await cache.get("users"); // fetches on first call, cached after
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export type CacheOptions<T> = {
  /** Time to live in milliseconds (default: 30 minutes). */
  ttl?: number;
  /**
   * Called when `get` encounters a missing or expired key.
   * If it returns a non-null value, the value is stored in the cache and returned.
   * Returning `null` or `undefined` leaves the cache empty for that key.
   */
  onMiss?: (key: string) => T | null | Promise<T | null>;
  /**
   * Called just before an expired entry is removed from the cache.
   * Useful for persisting dirty data, closing handles, or logging evictions.
   * Errors in this callback are logged to `console.error` and swallowed.
   */
  beforePurge?: (key: string, value: T) => void | Promise<void>;
};

export type Cache<T> = {
  /**
   * Retrieve a value from the cache.
   *
   * Returns the cached value if present and not expired. If the key is missing
   * or expired and an `onMiss` callback is configured, calls it to populate
   * the cache transparently. Returns `null` if the key is not found and no
   * `onMiss` is configured (or it returned `null`).
   *
   * If two concurrent `get` calls trigger `onMiss` for the same key, both will
   * execute and the last to complete wins. This is acceptable for cache use cases
   * but callers requiring strict single-flight behavior should add their own deduplication.
   */
  get: (key: string) => Promise<T | null>;
  /**
   * Store a value in the cache, resetting its TTL.
   *
   * Accepts either a direct value or an updater function that receives the
   * current cached value (or `null` if absent/expired) and returns the new value.
   * Returns the stored value.
   *
   * @example
   * await cache.set("count", 1);
   * await cache.set("count", (prev) => (prev ?? 0) + 1);
   */
  set: (key: string, valueOrUpdater: T | ((current: T | null) => T | Promise<T>)) => Promise<T>;
  /**
   * Remove a specific key from the cache.
   * No-op if the key does not exist. Does **not** trigger `beforePurge`.
   */
  delete: (key: string) => void;
  /**
   * Check whether a key exists and is not expired.
   */
  has: (key: string) => boolean;
  /**
   * Remove all entries and cancel all expiration timers.
   * Does **not** trigger `beforePurge`.
   */
  clear: () => void;
  /**
   * Return the number of entries currently in the cache.
   *
   * Iterates all entries to exclude expired ones (O(n)). For large caches
   * where `size()` is called frequently, consider tracking count separately.
   */
  size: () => number;
};

// ─── Implementation ─────────────────────────────────────────────────────────────

/**
 * Create an in-memory cache with automatic TTL expiration.
 *
 * Returns a `Cache<T>` object with `get`, `set`, `delete`, `has`, `clear`,
 * and `size` methods. Entries expire after `ttl` milliseconds (default: 30 min).
 *
 * **Side effects:** uses `setTimeout` per entry for automatic eviction.
 *
 * @example
 * const tokenCache = createCache<string>({ ttl: 60_000 }); // 1 minute
 * await tokenCache.set("access", "eyJ...");
 * const token = await tokenCache.get("access");
 */
export const createCache = <T>(options?: CacheOptions<T>): Cache<T> => {
  const ttl = options?.ttl ?? 30 * 60_000;
  const onMiss = options?.onMiss;
  const beforePurge = options?.beforePurge;

  const store = new Map<string, { value: T; expires: number }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const purge = (key: string): void => {
    const entry = store.get(key);
    store.delete(key);
    const timer = timers.get(key);
    if (timer) {
      clearTimeout(timer);
      timers.delete(key);
    }
    if (entry && beforePurge) {
      Promise.resolve(beforePurge(key, entry.value)).catch(console.error);
    }
  };

  // setTimeout in Node/Bun clamps delays > ~24.8 days (2^31 ms) to 1ms.
  // Cap our TTL-based timers at this maximum and re-schedule when the entry
  // is actually due to expire (typically far in the future, so single-step
  // re-scheduling is fine).
  const MAX_TIMEOUT_MS = 0x7fffffff;
  const scheduleExpiry = (key: string): void => {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    const entry = store.get(key);
    if (!entry) return;
    const remaining = Math.max(0, entry.expires - Date.now());
    const delay = Math.min(remaining, MAX_TIMEOUT_MS);
    const handle = setTimeout(() => {
      timers.delete(key);
      const e = store.get(key);
      if (!e) return;
      if (e.expires > Date.now()) {
        // Hit the 24.8-day cap before the real expiry; re-schedule.
        scheduleExpiry(key);
        return;
      }
      purge(key);
    }, delay);
    // Don't keep a Node/Bun process alive just because a cache entry exists.
    if (typeof (handle as any).unref === "function") {
      (handle as any).unref();
    }
    timers.set(key, handle);
  };

  const get = async (key: string): Promise<T | null> => {
    const entry = store.get(key);

    if (entry && entry.expires > Date.now()) {
      return entry.value;
    }

    // Remove expired entry — run beforePurge so resource-backed values get
    // their cleanup hook even when the timer didn't fire (e.g. event loop
    // was blocked past the TTL).
    if (entry) {
      purge(key);
    }

    // Lazy loading via onMiss
    if (onMiss) {
      const value = await onMiss(key);
      if (value !== null && value !== undefined) {
        return set(key, value);
      }
    }

    return null;
  };

  const set = async (
    key: string,
    valueOrUpdater: T | ((current: T | null) => T | Promise<T>),
  ): Promise<T> => {
    let value: T;

    if (typeof valueOrUpdater === "function") {
      const updater = valueOrUpdater as (current: T | null) => T | Promise<T>;
      const entry = store.get(key);
      const current = entry && entry.expires > Date.now() ? entry.value : null;
      value = await updater(current);
    } else {
      value = valueOrUpdater;
    }

    store.set(key, { value, expires: Date.now() + ttl });
    scheduleExpiry(key);
    return value;
  };

  const del = (key: string): void => {
    store.delete(key);
    const timer = timers.get(key);
    if (timer) {
      clearTimeout(timer);
      timers.delete(key);
    }
  };

  const has = (key: string): boolean => {
    const entry = store.get(key);
    return entry !== undefined && entry.expires > Date.now();
  };

  const clear = (): void => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    store.clear();
  };

  const size = (): number => {
    // Only count non-expired entries
    let count = 0;
    const now = Date.now();
    for (const entry of store.values()) {
      if (entry.expires > now) count++;
    }
    return count;
  };

  return { get, set, delete: del, has, clear, size };
};

// ─── Namespace Export ────────────────────────────────────────────────────────────

/** In-memory cache factory with TTL expiration, lazy loading, and cleanup hooks. */
export const cache = {
  create: createCache,
} as const;
