import { createHash } from "node:crypto";
import { ConflictError } from "@k2b/sync";
import { DiscardPolicy, JetStreamApiError, jetstream, jetstreamManager, StorageType, type StreamInfo } from "@nats-io/jetstream";
import { z } from "zod";
import { getProcessSync } from "../_internal/process-sync";
import { logger } from "../services/logging";
import { SharedTextBoundaryError } from "./boundary";

const valueSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("open"),
    thaw: z.object({ freezeCursor: z.string(), cursor: z.string().nullable(), restoreRevision: z.string() }).optional(),
  }),
  z.object({ state: z.literal("frozen"), expiresAt: z.number(), freezeCursor: z.string().nullable(), restoreRevision: z.string() }),
  z.object({ state: z.literal("closed"), freezeCursor: z.string(), closeCursor: z.string().nullable(), restoreRevision: z.string() }),
]);
export type SharedTextLifecycleValue = z.infer<typeof valueSchema>;
export type SharedTextLifecycleEntry = { revision: number; value: SharedTextLifecycleValue };
export type SharedTextLifecycleStore = {
  get(docId: string): Promise<SharedTextLifecycleEntry | null>;
  put(docId: string, previous: SharedTextLifecycleEntry | null, value: SharedTextLifecycleValue): Promise<SharedTextLifecycleEntry>;
};

/** Call under document admission. Expiry opens admission AND invalidates the old close token atomically. */
export const checkLifecycleAdmission = async (store: SharedTextLifecycleStore, docId: string) => {
  let entry = await store.get(docId);
  if (entry?.value.state === "closed") throw new SharedTextBoundaryError("DOCUMENT_CLOSED");
  if (entry?.value.state === "frozen") {
    if (entry.value.expiresAt > Date.now()) throw new SharedTextBoundaryError("DOCUMENT_FROZEN");
    entry = await store.put(docId, entry, { state: "open" });
  }
  const revision = entry?.revision;
  // A prune can make expectedAfter:null match again after an expired owner
  // resumes. Never acknowledge a publication across a lifecycle transition.
  return async () => {
    const current = await store.get(docId);
    if (current?.value.state === "closed") throw new SharedTextBoundaryError("DOCUMENT_CLOSED");
    if (current?.revision !== revision) throw new SharedTextBoundaryError("DOCUMENT_FROZEN");
  };
};

/** One compacted stream per document log; never a stream per document or a prunable prefix. */
export const createLifecycleStore = (config: { id: string; maxBytes: number; ready(): Promise<void> }): SharedTextLifecycleStore => {
  if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes < 4096) throw new RangeError("Lifecycle maxBytes must be at least 4096");
  let pending: ReturnType<typeof prepare> | undefined;
  let warnedLargerBudget = false;
  // Cache decoded values within the declared byte budget. Each read still verifies
  // the broker revision: delayed/lost invalidations must never admit an edit.
  const cache = new Map<string, { entry: SharedTextLifecycleEntry; bytes: number }>();
  let bytes = 0;
  const remember = (key: string, entry: SharedTextLifecycleEntry, size: number) => {
    const old = cache.get(key);
    if (old) bytes -= old.bytes;
    cache.delete(key);
    cache.set(key, { entry, bytes: size });
    bytes += size;
    while (bytes > config.maxBytes) {
      const first = cache.entries().next().value;
      if (!first) break;
      cache.delete(first[0]);
      bytes -= first[1].bytes;
    }
    return entry;
  };
  const prepare = async () => {
    await config.ready();
    const sync = getProcessSync();
    const control = (await sync.resources()).find((entry) => entry.kind === "topic" && entry.id === config.id);
    if (!control) throw new Error("Shared text lifecycle requires a declared document topic");
    let replicas: number | undefined;
    for await (const topic of sync.listTopics({ idPrefix: config.id })) if (topic.id === config.id) replicas = topic.replicas;
    if (!replicas) throw new Error("Shared text document topic is unavailable");
    const suffix = createHash("sha256")
      .update(JSON.stringify([control.namespace, config.id]))
      .digest("hex");
    const name = `cloud_text_lifecycle_${suffix}`;
    const subject = `${name}.`;
    const { getProcessNats } = await import("../_internal/process-sync");
    const connection = getProcessNats();
    const manager = await jetstreamManager(connection);
    const declared = {
      name,
      subjects: [`${subject}>`],
      max_bytes: config.maxBytes,
      max_msgs_per_subject: 1,
      max_msg_size: 4096,
      max_age: 0,
      discard: DiscardPolicy.New,
      storage: StorageType.File,
      num_replicas: replicas,
      metadata: { "cloud.shared-text.lifecycle": config.id, "sync.namespace": control.namespace },
    };
    let existing: StreamInfo | undefined;
    try {
      existing = await manager.streams.info(name);
    } catch (error) {
      if (!(error instanceof JetStreamApiError && error.code === 10059)) throw error;
    }
    if (existing) {
      for (const key of ["max_msgs_per_subject", "max_msg_size", "max_age", "discard", "storage"] as const)
        if (existing.config[key] !== declared[key]) throw new Error(`Shared text lifecycle stream configuration differs: ${key}`);
      if (
        existing.config.subjects?.length !== 1 ||
        existing.config.subjects[0] !== declared.subjects[0] ||
        existing.config.metadata?.["cloud.shared-text.lifecycle"] !== config.id ||
        existing.config.metadata?.["sync.namespace"] !== control.namespace
      )
        throw new Error("Shared text lifecycle stream identity differs");
      // Old pods and rollbacks retain the larger reservation without evicting fences.
      if (existing.config.max_bytes > declared.max_bytes) {
        declared.max_bytes = existing.config.max_bytes;
        if (!warnedLargerBudget) {
          warnedLargerBudget = true;
          logger("shared-text-lifecycle").warn("Keeping the larger existing lifecycle byte budget", {
            log: config.id,
            declaredMaxBytes: config.maxBytes,
            retainedMaxBytes: declared.max_bytes,
          });
        }
      }
      if (existing.config.max_bytes !== declared.max_bytes || existing.config.num_replicas !== replicas)
        existing = await manager.streams.update(name, { max_bytes: declared.max_bytes, num_replicas: replicas });
    }
    const actual = (existing ?? (await manager.streams.add(declared))).config;
    for (const key of ["max_bytes", "max_msgs_per_subject", "max_msg_size", "max_age", "discard", "storage", "num_replicas"] as const)
      if (actual[key] !== declared[key]) throw new Error(`Shared text lifecycle stream configuration differs: ${key}`);
    return { manager, client: jetstream(connection), name, subject };
  };
  const ready = () =>
    (pending ??= prepare().catch((error: unknown) => {
      pending = undefined;
      throw error;
    }));
  const keyFor = (docId: string) => createHash("sha256").update(docId).digest("hex");
  return {
    async get(docId) {
      const { manager, name, subject } = await ready();
      const key = keyFor(docId);
      const message = await manager.streams.getMessage(name, { last_by_subj: subject + key });
      if (!message) return null;
      const cached = cache.get(key);
      if (cached?.entry.revision === message.seq) return remember(key, cached.entry, cached.bytes);
      return remember(key, { revision: message.seq, value: valueSchema.parse(message.json()) }, message.data.length);
    },
    async put(docId, previous, value) {
      const { client, subject } = await ready();
      const key = keyFor(docId);
      const data = new TextEncoder().encode(JSON.stringify(valueSchema.parse(value)));
      try {
        const receipt = await client.publish(subject + key, data, { expect: { lastSubjectSequence: previous?.revision ?? 0 } });
        return remember(key, { revision: receipt.seq, value }, data.length);
      } catch (error) {
        if (error instanceof JetStreamApiError && error.code === 10071) throw new ConflictError("Shared text lifecycle changed");
        throw error;
      }
    },
  };
};
