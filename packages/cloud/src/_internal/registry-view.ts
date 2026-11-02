import type { Ephemeral, EphemeralEntry } from "@k2b/sync";

/** One live revision per key; no request-triggered I/O while the watch is healthy. */
export const createRegistryView = <T, V>({
  registry,
  prefix,
  ttlMs,
  signal,
  read,
  now = () => performance.timeOrigin + performance.now(),
}: {
  registry: Pick<Ephemeral<T>, "snapshot" | "watch">;
  prefix: string;
  ttlMs: number;
  signal: AbortSignal;
  read: (entry: EphemeralEntry<T>) => V;
  /** Epoch-based monotonic clock: wall-clock adjustments must not expire live leases. */
  now?: () => number;
}) => {
  const entries = new Map<string, { revision: string; expiresAt: number; value: V }>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  let healthy = false;
  let refreshing: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let watching: Promise<void> | undefined;

  const apply = (entry: EphemeralEntry<T>) => {
    const expiresAt = entry.updatedAt.getTime() + ttlMs;
    if (expiresAt <= now()) return;
    const current = entries.get(entry.key);
    if (current && BigInt(current.revision) >= BigInt(entry.revision)) return;
    entries.set(entry.key, { revision: entry.revision, expiresAt, value: read(entry) });
  };
  const invalidate = () => {
    healthy = false;
    generation++;
    controller?.abort();
    changed();
  };
  const abort = () => {
    invalidate();
    entries.clear();
  };
  signal.addEventListener("abort", abort, { once: true });

  const refresh = async () => {
    signal.throwIfAborted();
    const ownGeneration = ++generation;
    controller?.abort();
    await watching;
    // Sync bounds snapshots by maxEntries and individual NATS request deadlines.
    // A failed read is surfaced; the previous view is never served after watch loss.
    const snapshot = await registry.snapshot({ prefix });
    signal.throwIfAborted();
    if (generation !== ownGeneration) throw new Error("App registry changed connection during snapshot; retry the read");
    const present = new Set(snapshot.entries.map((entry) => entry.key));
    for (const key of entries.keys()) if (!present.has(key)) entries.delete(key);
    for (const entry of snapshot.entries) {
      // An authoritative snapshot may come from a recreated bucket whose
      // revisions restarted. Only reuse an exactly matching stored revision.
      const current = entries.get(entry.key);
      if (current && (current.revision !== entry.revision || current.expiresAt !== entry.updatedAt.getTime() + ttlMs))
        entries.delete(entry.key);
      apply(entry);
    }
    controller = new AbortController();
    const watchSignal = controller.signal;
    healthy = true;
    watching = (async () => {
      try {
        for await (const event of registry.watch({ prefix, after: snapshot.revision, signal: watchSignal })) {
          if (watchSignal.aborted || generation !== ownGeneration) break;
          if (event.type === "resync_required") break;
          if (event.type === "upsert") apply(event.entry);
          else entries.delete(event.key);
          changed();
        }
      } catch {
        // The next reader takes one shared authoritative snapshot and opens a new watch.
      } finally {
        if (generation === ownGeneration) {
          healthy = false;
          changed();
        }
      }
    })();
  };
  return {
    invalidate,
    // Publish invalidations only after applying the corresponding source event.
    changes: (watchSignal: AbortSignal): AsyncIterable<{ type: string }> => ({
      async *[Symbol.asyncIterator]() {
        let dirty = true;
        let wake: (() => void) | undefined;
        const notify = () => {
          dirty = true;
          wake?.();
        };
        listeners.add(notify);
        watchSignal.addEventListener("abort", notify, { once: true });
        try {
          while (!watchSignal.aborted) {
            if (!dirty)
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            if (watchSignal.aborted) break;
            dirty = false;
            yield { type: "change" };
          }
        } finally {
          listeners.delete(notify);
          watchSignal.removeEventListener("abort", notify);
        }
      },
    }),
    stop: async () => {
      abort();
      signal.removeEventListener("abort", abort);
      await watching;
    },
    values: async (): Promise<V[]> => {
      signal.throwIfAborted();
      if (!healthy) {
        refreshing ??= refresh().finally(() => {
          refreshing = undefined;
        });
        await refreshing;
        if (!healthy) throw new Error("App registry watch lost during refresh; retry the read");
      }
      const observedAt = now();
      for (const [key, entry] of entries) if (entry.expiresAt <= observedAt) entries.delete(key);
      return [...entries.values()].map((entry) => structuredClone(entry.value));
    },
  };
};
