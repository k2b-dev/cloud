import { createHash } from "node:crypto";
import type { Ephemeral, EphemeralEntry } from "@k2b/sync";

/** Registry payloads are JSON trees. Freeze once at arrival, never clone on reads. */
export const freezeObserved = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeObserved(child);
    Object.freeze(value);
  }
  return value;
};

/** One process-owned, fail-closed KV view. Lease progress and content changes are separate. */
export const createObservedView = <T, V>({
  registry,
  prefix,
  ttlMs,
  signal,
  read,
  now = () => performance.timeOrigin + performance.now(),
  schedule = (run, delay) => {
    const timer = setTimeout(run, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
}: {
  registry: Pick<Ephemeral<T>, "snapshot" | "watch">;
  prefix: string;
  ttlMs: number;
  signal: AbortSignal;
  read: (entry: EphemeralEntry<T>) => V;
  now?: () => number;
  /** Injectable deadline driver for deterministic lease tests. */
  schedule?: (run: () => void, delay: number) => () => void;
}) => {
  const entries = new Map<string, { source: EphemeralEntry<T>; expiresAt: number; digest: string; value: V }>();
  // A per-key read after a local write can run ahead of the covering watch.
  // Keep its fence only until that ordered watch catches up.
  const fences = new Map<string, bigint>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  let healthy = false;
  let refreshing: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let watching: Promise<void> | undefined;
  let cancelExpiry: (() => void) | undefined;
  let nextExpiry = Infinity;
  let coveredRevision = 0n;

  const expire = () => {
    if (now() < nextExpiry) return false;
    let removed = false;
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        removed = true;
      }
    }
    if (removed) changed();
    return true;
  };
  const armExpiry = () => {
    cancelExpiry?.();
    cancelExpiry = undefined;
    nextExpiry = Infinity;
    if (!healthy || signal.aborted || !entries.size) return;
    nextExpiry = Math.min(...[...entries.values()].map((entry) => entry.expiresAt));
    cancelExpiry = schedule(
      () => {
        expire();
        armExpiry();
      },
      Math.max(0, nextExpiry - now()),
    );
  };
  const apply = (entry: EphemeralEntry<T>, authoritative = false): boolean => {
    const current = entries.get(entry.key);
    if (!authoritative && (fences.get(entry.key) ?? -1n) >= BigInt(entry.revision)) return false;
    if (!authoritative && current && BigInt(current.source.revision) >= BigInt(entry.revision)) return false;
    const expiresAt = entry.updatedAt.getTime() + ttlMs;
    if (expiresAt <= now()) return entries.delete(entry.key);
    // Hash the wire content: local upsert values may still contain omitted undefined fields.
    const digest = createHash("sha256")
      .update(JSON.stringify(entry.value ?? null))
      .digest("hex");
    const sameContent = current?.digest === digest;
    // Local upsert results can still belong to their writer. Take ownership once.
    const value = sameContent ? current.source.value : freezeObserved(structuredClone(entry.value));
    const source = { ...entry, value };
    entries.set(entry.key, { source, expiresAt, digest, value: sameContent ? current.value : freezeObserved(read(source)) });
    return !sameContent;
  };
  const invalidate = () => {
    healthy = false;
    generation++;
    controller?.abort();
    cancelExpiry?.();
    changed();
  };
  const abort = () => {
    invalidate();
    entries.clear();
    fences.clear();
  };
  signal.addEventListener("abort", abort, { once: true });

  const refresh = async () => {
    signal.throwIfAborted();
    const ownGeneration = ++generation;
    controller?.abort();
    await watching;
    const snapshot = await registry.snapshot({ prefix });
    signal.throwIfAborted();
    if (generation !== ownGeneration) throw new Error("Registry changed connection during snapshot; retry the read");
    fences.clear();
    coveredRevision = BigInt(snapshot.revision);
    const present = new Set(snapshot.entries.map((entry) => entry.key));
    for (const key of entries.keys()) if (!present.has(key)) entries.delete(key);
    // A recreated bucket can restart its revisions. Snapshot is authoritative.
    for (const entry of snapshot.entries) apply(entry, true);
    controller = new AbortController();
    const watchSignal = controller.signal;
    healthy = true;
    armExpiry();
    watching = (async () => {
      try {
        for await (const event of registry.watch({ prefix, after: snapshot.revision, signal: watchSignal })) {
          if (watchSignal.aborted || generation !== ownGeneration) break;
          if (event.type === "resync_required") break;
          let dirty = false;
          if (event.type === "upsert") dirty = apply(event.entry);
          else {
            const current = entries.get(event.key);
            if (
              (fences.get(event.key) ?? -1n) < BigInt(event.revision) &&
              (!current || BigInt(current.source.revision) < BigInt(event.revision))
            )
              dirty = entries.delete(event.key);
          }
          coveredRevision = BigInt(event.revision);
          for (const [key, revision] of fences) if (revision <= BigInt(event.revision)) fences.delete(key);
          armExpiry();
          if (dirty) changed();
        }
      } catch {
        // A failed watch never serves stale state; the next reader takes one shared snapshot.
      } finally {
        if (generation === ownGeneration) {
          healthy = false;
          cancelExpiry?.();
          changed();
        }
      }
    })();
  };
  const ready = async () => {
    signal.throwIfAborted();
    if (!healthy) {
      refreshing ??= refresh().finally(() => {
        refreshing = undefined;
      });
      await refreshing;
      if (!healthy) throw new Error("Registry watch lost during refresh; retry the read");
    }
    if (expire()) armExpiry();
  };
  return {
    invalidate,
    /** Upsert's acknowledged revision is safe to install ahead of the watch. */
    accept: (entry: EphemeralEntry<T>) => {
      if (!entry.key.startsWith(prefix)) return;
      if (!healthy) {
        invalidate();
        return;
      }
      const dirty = apply(entry);
      armExpiry();
      if (dirty) changed();
    },
    /** Sync's boolean mutations need an authoritative per-key read, not a view restart. */
    reconcile: async (key: string) => {
      if (!key.startsWith(prefix)) return;
      if (!healthy) {
        invalidate();
        return;
      }
      const ownGeneration = generation;
      const snapshot = await registry.snapshot({ prefix: key });
      if (generation !== ownGeneration || !healthy) return;
      const entry = snapshot.entries.find((entry) => entry.key === key);
      const current = entries.get(key);
      // A watch event newer than this snapshot wins.
      const revision = BigInt(snapshot.revision);
      if (coveredRevision > revision || (fences.get(key) ?? -1n) > revision || (current && BigInt(current.source.revision) > revision))
        return;
      const dirty = entry ? apply(entry) : entries.delete(key);
      fences.set(key, BigInt(snapshot.revision));
      armExpiry();
      if (dirty) changed();
    },
    changes: (watchSignal: AbortSignal, initial = true): AsyncIterable<{ type: string }> => ({
      async *[Symbol.asyncIterator]() {
        let dirty = initial;
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
    get: async (key: string): Promise<V | undefined> => {
      await ready();
      return entries.get(key)?.value;
    },
    values: async (): Promise<V[]> => {
      await ready();
      return [...entries.values()].map((entry) => entry.value);
    },
    entries: async () => {
      await ready();
      return [...entries.values()].map(({ source, value }) => ({ ...source, value }));
    },
  };
};
