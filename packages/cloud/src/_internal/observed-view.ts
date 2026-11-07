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
  type Change = "content" | "lease";
  const listeners = new Set<{ notify: () => void; liveness: boolean }>();
  const changed = (kind: Change = "content") => {
    for (const listener of listeners) if (kind === "content" || listener.liveness) listener.notify();
  };
  let healthy = false;
  let refreshing: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let watching: Promise<void> | undefined;
  let cancelExpiry: (() => void) | undefined;
  let nextExpiry = Infinity;
  let coveredRevision = 0n;
  let coverageDue: { revision: bigint; at: number } | undefined;

  // A local acknowledgement can beat delivery. Give the ordered watch one
  // heartbeat interval (TTL / 3) to cover it, without extending that deadline
  // on subsequent writes. A silent consumer must not stay healthy forever.
  const requireCoverage = (revision: bigint) => {
    if (revision <= coveredRevision || coverageDue) return;
    coverageDue = { revision, at: now() + ttlMs / 3 };
  };

  const cover = (revision: bigint) => {
    coveredRevision = revision;
    if (coverageDue && coveredRevision >= coverageDue.revision) coverageDue = undefined;
  };

  const expire = () => {
    if (now() < nextExpiry) return false;
    // A locally expired lease can mean a stalled watch, even for read-only
    // processes. One shared snapshot must decide whether it is really dead.
    invalidate();
    return true;
  };
  const armExpiry = () => {
    cancelExpiry?.();
    cancelExpiry = undefined;
    nextExpiry = Infinity;
    if (!healthy || signal.aborted) return;
    nextExpiry = Math.min(coverageDue?.at ?? Infinity, ...[...entries.values()].map((entry) => entry.expiresAt));
    if (nextExpiry === Infinity) return;
    cancelExpiry = schedule(
      () => {
        expire();
        armExpiry();
      },
      Math.max(0, nextExpiry - now()),
    );
  };
  const apply = (entry: EphemeralEntry<T>, authoritative = false): Change | undefined => {
    const current = entries.get(entry.key);
    if (!authoritative && coveredRevision >= BigInt(entry.revision)) return;
    if (!authoritative && (fences.get(entry.key) ?? -1n) >= BigInt(entry.revision)) return;
    if (!authoritative && current && BigInt(current.source.revision) >= BigInt(entry.revision)) return;
    const expiresAt = entry.updatedAt.getTime() + ttlMs;
    if (expiresAt <= now()) return entries.delete(entry.key) ? "content" : undefined;
    // Hash the wire content: local upsert values may still contain omitted undefined fields.
    const digest = createHash("sha256")
      .update(JSON.stringify(entry.value ?? null))
      .digest("hex");
    const sameContent = current?.digest === digest;
    // Local upsert results can still belong to their writer. Take ownership once.
    const value = sameContent ? current.source.value : freezeObserved(structuredClone(entry.value));
    const source = { ...entry, value };
    entries.set(entry.key, { source, expiresAt, digest, value: sameContent ? current.value : freezeObserved(read(source)) });
    return sameContent ? "lease" : "content";
  };
  const invalidate = () => {
    healthy = false;
    coverageDue = undefined;
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
    coverageDue = undefined;
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
          let change: Change | undefined;
          if (event.type === "upsert") change = apply(event.entry);
          else {
            const current = entries.get(event.key);
            if (
              (fences.get(event.key) ?? -1n) < BigInt(event.revision) &&
              (!current || BigInt(current.source.revision) < BigInt(event.revision))
            )
              change = entries.delete(event.key) ? "content" : undefined;
          }
          cover(BigInt(event.revision));
          for (const [key, revision] of fences) if (revision <= BigInt(event.revision)) fences.delete(key);
          armExpiry();
          if (change) changed(change);
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
  const ready = async (): Promise<void> => {
    signal.throwIfAborted();
    if (!healthy) {
      refreshing ??= refresh().finally(() => {
        refreshing = undefined;
      });
      await refreshing;
      if (!healthy) throw new Error("Registry watch lost during refresh; retry the read");
    }
    if (expire()) {
      armExpiry();
      if (!healthy) await ready();
    }
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
      const change = apply(entry);
      requireCoverage(BigInt(entry.revision));
      armExpiry();
      if (change) changed(change);
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
      const change = entry ? apply(entry) : entries.delete(key) ? "content" : undefined;
      fences.set(key, revision);
      // The bucket watermark may include keys outside this watch's prefix.
      // The touched key's revision is a sufficient ordered-delivery barrier.
      requireCoverage(entry ? BigInt(entry.revision) : revision);
      armExpiry();
      if (change) changed(change);
    },
    changes: (
      watchSignal: AbortSignal,
      { initial = true, liveness = false }: { initial?: boolean; liveness?: boolean } = {},
    ): AsyncIterable<{ type: string }> => ({
      async *[Symbol.asyncIterator]() {
        let dirty = initial;
        let wake: (() => void) | undefined;
        const notify = () => {
          dirty = true;
          wake?.();
        };
        const listener = { notify, liveness };
        listeners.add(listener);
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
          listeners.delete(listener);
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
