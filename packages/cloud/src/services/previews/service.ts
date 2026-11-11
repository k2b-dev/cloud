import type { PreviewVariant } from "../../shared/previews";
import { PREVIEW_CLEANUP_BATCH, type PreviewStore, previewHash, previewObjectKey } from "./store";
import {
  PREVIEW_DEADLINE_MS,
  type PreviewArtifacts,
  PreviewGenerationError,
  type PreviewManifest,
  type PreviewReader,
  type PreviewReadResult,
  type PreviewSource,
  PreviewSourceChanged,
  PreviewSourceSchema,
  pending,
  sourceState,
  supportsVariant,
} from "./types";

type PreviewObject = {
  write(data: Blob): Promise<unknown>;
  delete(): Promise<void>;
  exists(): Promise<boolean>;
  stream(): ReadableStream<Uint8Array>;
};
export type PreviewDependencies = {
  store: PreviewStore;
  persistent(): Promise<boolean>;
  object(key: string): PreviewObject;
  submit(source: PreviewSource, priority: "high" | "low"): Promise<void>;
  generate(
    reader: PreviewReader,
    source: PreviewSource,
    kind: "image" | "pdf" | "office" | "text",
    signal: AbortSignal,
  ): Promise<PreviewArtifacts>;
};

/** Object-store calls take no abort signal; the job stops waiting at its deadline and frees its slot and transaction. */
const within = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      void work.catch(() => {});
      return abort();
    }
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
/** Cleanup after a failed or abandoned write is best effort within its own short bound; a late object is only a leftover. */
const CLEANUP_MS = 15_000;

/** One pool is shared by both Sync consumers and inline requests. No unbounded local wait list. */
export function createPreviewsService(deps: PreviewDependencies) {
  let reader: PreviewReader | undefined;
  let active = 0;
  const stopping = new AbortController();
  const running = new Set<Promise<unknown>>();
  const removeObjects = async (row: { key_hash: string; revision: string; variants: PreviewManifest }) => {
    for (const variant of Object.keys(row.variants)) await deps.object(previewObjectKey(row.key_hash, row.revision, variant)).delete();
  };
  const discardWritten = async (written: string[]) => {
    const keys = written.splice(0);
    const bound = AbortSignal.timeout(CLEANUP_MS);
    for (const key of keys) await within(deps.object(key).delete(), bound).catch(() => {});
  };
  async function generate(source: PreviewSource, signal: AbortSignal, persistent: boolean): Promise<PreviewArtifacts | null> {
    if (active >= 2 || stopping.signal.aborted) return null;
    active++;
    const written: string[] = [];
    try {
      const result = await deps.store.withKey(previewHash(source.key), async (store) => {
        const existing = await store.find(source);
        if (existing && (persistent || existing.state !== "ready")) return null;
        const detected = sourceState(source);
        if ("state" in detected) {
          await store.put(source, detected.state);
          return null;
        }
        if (!reader) throw new Error("Register a preview reader during application startup");
        const bounded = AbortSignal.any([signal, stopping.signal, AbortSignal.timeout(PREVIEW_DEADLINE_MS)]);
        try {
          const artifacts = await deps.generate(reader, source, detected.kind, bounded);
          bounded.throwIfAborted();
          if (persistent) {
            const manifest: PreviewManifest = {};
            for (const variant of ["small", "large", "pdf", "text"] as const) {
              const blob = artifacts[variant];
              if (!blob) continue;
              bounded.throwIfAborted();
              const key = previewObjectKey(previewHash(source.key), source.revision, variant);
              written.push(key);
              await within(deps.object(key).write(blob), bounded);
              manifest[variant] = { type: blob.type, bytes: blob.size };
            }
            bounded.throwIfAborted();
            await store.put(source, "ready", manifest);
          }
          return artifacts;
        } catch (error) {
          await discardWritten(written);
          if (error instanceof PreviewSourceChanged || signal.aborted || stopping.signal.aborted) return null;
          const failure =
            error instanceof PreviewGenerationError
              ? error
              : new PreviewGenerationError("failed", bounded.aborted ? "timed_out" : "generation_failed");
          await store.put(source, failure.state, {}, failure.code);
          return null;
        }
      });
      return result?.value ?? null;
    } catch (error) {
      // Object writes precede the metadata commit. Compensate if that commit fails too.
      await discardWritten(written);
      throw error;
    } finally {
      active--;
    }
  }
  const trackedGenerate = (source: PreviewSource, signal: AbortSignal, persistent: boolean) => {
    const task = generate(source, signal, persistent);
    running.add(task);
    void task.finally(() => running.delete(task)).catch(() => {});
    return task;
  };
  return {
    reader(value: PreviewReader) {
      if (reader) throw new Error("A preview reader is already registered");
      reader = value;
    },
    async read(input: PreviewSource, variant: PreviewVariant, options: { signal?: AbortSignal } = {}): Promise<PreviewReadResult> {
      const source = PreviewSourceSchema.parse(input);
      if (!["small", "large", "pdf", "text"].includes(variant)) throw new TypeError("Unknown preview variant");
      const signal = options.signal ?? new AbortController().signal;
      signal.throwIfAborted();
      const detected = sourceState(source);
      if ("state" in detected) {
        await deps.store.withKey(previewHash(source.key), async (store) => {
          if (!(await store.find(source))) await store.put(source, detected.state);
        });
        return detected;
      }
      if (!supportsVariant(detected.kind, variant)) return { state: "unsupported" };
      const row = await deps.store.find(source);
      if (row && row.state !== "ready") return { state: row.state };
      const persistent = await deps.persistent();
      if (persistent && row) {
        const entry = row.variants[variant];
        if (!entry) return { state: "unsupported" };
        const object = deps.object(previewObjectKey(row.key_hash, row.revision, variant));
        if (await object.exists()) {
          if (Date.now() - new Date(row.shown_at).getTime() >= 86_400_000) await deps.store.shown(source);
          return { state: "ready", body: object.stream(), ...entry };
        }
        await deps.store.withKey(row.key_hash, async (store) => {
          await removeObjects(row);
          await store.remove(row);
        });
      }
      if (persistent) {
        await deps.submit(source, "high");
        return pending();
      }
      const artifacts = await trackedGenerate(source, signal, false);
      signal.throwIfAborted();
      const body = artifacts?.[variant];
      if (body) return { state: "ready", body, type: body.type, bytes: body.size };
      const failed = await deps.store.find(source);
      return failed && failed.state !== "ready" ? { state: failed.state } : pending();
    },
    async enqueue(input: PreviewSource): Promise<void> {
      const source = PreviewSourceSchema.parse(input);
      if (!(await deps.persistent()) || "state" in sourceState(source) || (await deps.store.find(source))) return;
      await deps.submit(source, "low");
    },
    async retry(input: PreviewSource): Promise<void> {
      const source = PreviewSourceSchema.parse(input);
      const result = await deps.store.withKey(previewHash(source.key), (store) => store.retry(source));
      if (result && (await deps.persistent())) await deps.submit(source, "high");
    },
    async discard(key: string): Promise<void> {
      if (!key || new TextEncoder().encode(key).byteLength > 512) throw new TypeError("Invalid preview key");
      const keyHash = previewHash(key);
      const result = await deps.store.withKey(keyHash, async (store) => {
        const deadline = Date.now() + PREVIEW_DEADLINE_MS;
        for (;;) {
          if (Date.now() >= deadline) throw new Error("Preview discard deadline exceeded");
          const rows = await store.rows(keyHash);
          for (const row of rows) {
            await removeObjects(row);
            await store.remove(row);
          }
          if (rows.length < PREVIEW_CLEANUP_BATCH) break;
        }
      });
      if (!result) throw new Error("Preview generation is busy; retry discard");
    },
    async work(input: PreviewSource, signal: AbortSignal): Promise<void> {
      const source = PreviewSourceSchema.parse(input);
      if (await deps.persistent()) await trackedGenerate(source, signal, true);
    },
    async maintain(maxBytes: number, signal: AbortSignal): Promise<number> {
      let removed = await deps.store.expireTerminal();
      const rows = await deps.store.eviction(maxBytes);
      for (const row of rows) {
        signal.throwIfAborted();
        const result = await deps.store.withKey(row.key_hash, async (store) => {
          const candidates = await store.eviction(maxBytes);
          if (!candidates.some((candidate) => candidate.key_hash === row.key_hash && candidate.revision === row.revision)) return false;
          await removeObjects(row);
          await store.remove(row);
          return true;
        });
        if (result?.value) removed++;
      }
      return removed;
    },
    async stop() {
      stopping.abort();
      await Promise.allSettled([...running]);
    },
  };
}
