/**
 * JetStream budgets for the Sync jobs and queues of one Cloud process.
 *
 * JetStream reserves a stream's whole `max_bytes` on every replica as soon as
 * the stream exists. @k2b/sync 6.5 gives a job or queue declared without
 * `retention` 1 GiB, and its dead-letter stream always gets the same limit, so
 * every such declaration reserved 2 GiB per replica for work that is almost
 * always a few hundred bytes of identifiers.
 *
 * Cloud therefore declares jobs and queues without `retention` with a budget
 * derived from the primitive's payload limit: `SYNC_BACKLOG_MESSAGES` pending
 * messages at that limit. An explicit `retention` still wins.
 *
 * Sync refuses a declaration whose byte limit differs from the existing
 * stream (`ResourceDriftError`), so before a job or queue is first used this
 * module lowers or raises the limit of its existing streams in place. A stream
 * that already holds more than the new limit would lose its oldest messages;
 * it keeps its current limit instead, and a later start applies the new one.
 */
import type { DeadLetterStore, Job, JobConfig, Queue, QueueConfig, RetentionConfig, Sync } from "@k2b/sync";
import { type JetStreamManager, jetstreamManager, type StreamInfo } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { logger } from "../services/logging";

/** Sync 6.5 defaults that @k2b/sync does not export. */
const SYNC_PAYLOAD_BYTES = 128 * 1024;
const SYNC_DEAD_LETTER_HEADROOM_BYTES = 4096;
const SYNC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Pending messages at the payload limit a job or queue without declared
 * retention holds before Sync discards the oldest. Cloud's jobs carry
 * identifiers whose state lives in Postgres, about half a KiB per stored
 * message, so the same budget holds tens of thousands of typical messages.
 */
const SYNC_BACKLOG_MESSAGES = 256;

/** Retention for a job or queue declared without one. */
const syncBudgetRetention = (maxPayloadBytes = SYNC_PAYLOAD_BYTES): RetentionConfig => ({
  maxAgeMs: SYNC_MAX_AGE_MS,
  maxBytes: SYNC_BACKLOG_MESSAGES * (maxPayloadBytes + SYNC_DEAD_LETTER_HEADROOM_BYTES),
});

/** 33 MiB per stream at Sync's 128 KiB payload limit. */
export const SYNC_DEFAULT_RETENTION = syncBudgetRetention();

const log = logger("sync:budget");

type Kind = "job" | "queue";

/** Memoizes a promise, forgetting a rejection so the next call retries. */
const once = <T>(create: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= create().catch((error: unknown) => {
      pending = undefined;
      throw error;
    }));
};

const isStreamNotFound = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error.code === 10059 || /stream not found/i.test(error.message));

const createStreamLimits = (connection: NatsConnection, namespace: string) => {
  const manager = once(() => jetstreamManager(connection));
  /** Work and dead-letter stream names per job and queue of this namespace, listed once per process. */
  const inventory = once(async () => {
    const jsm = await manager();
    const names = new Map<string, string[]>();
    for await (const info of jsm.streams.list()) {
      const metadata = info.config.metadata;
      const kind = metadata?.["sync.kind"];
      if (metadata?.["sync.namespace"] !== namespace || metadata["sync.managed"] !== "true") continue;
      // A job's coalescing claims live in a KV bucket without a byte limit.
      if ((kind !== "job" && kind !== "queue") || info.config.name.startsWith("KV_")) continue;
      const key = `${kind}:${metadata["sync.id"]}`;
      names.set(key, [...(names.get(key) ?? []), info.config.name]);
    }
    return names;
  });

  const current = async (jsm: JetStreamManager, name: string): Promise<StreamInfo | null> =>
    jsm.streams.info(name).catch((error: unknown) => {
      if (isStreamNotFound(error)) return null;
      throw error;
    });

  /** Brings existing streams to `target.maxBytes` and returns the retention to declare. */
  const apply = async (kind: Kind, id: string, target: RetentionConfig): Promise<RetentionConfig> => {
    const jsm = await manager();
    const names = (await inventory()).get(`${kind}:${id}`) ?? [];
    const streams = (await Promise.all(names.map((name) => current(jsm, name)))).filter((info) => info !== null);
    const limits = new Set(streams.map((info) => info.config.max_bytes));
    if (streams.length === 0 || (limits.size === 1 && limits.has(target.maxBytes))) return target;
    // Unequal limits did not come from Sync; its drift check reports them.
    if (limits.size > 1) return target;
    const [limit = target.maxBytes] = limits;
    const held = Math.max(...streams.map((info) => info.state.bytes));
    if (held > target.maxBytes) {
      log.warn("Kept the byte limit of a Sync stream that holds more than its new limit", {
        kind,
        id,
        limit,
        target: target.maxBytes,
        held,
      });
      return { ...target, maxBytes: limit };
    }
    for (const info of streams) await jsm.streams.update(info.config.name, { max_bytes: target.maxBytes });
    log.info("Changed the byte limit of Sync streams", { kind, id, from: limit, to: target.maxBytes });
    return target;
  };

  const applied = new Map<string, () => Promise<RetentionConfig>>();
  return (kind: Kind, id: string, target: RetentionConfig): Promise<RetentionConfig> => {
    const key = `${kind}:${id}:${target.maxBytes}`;
    let run = applied.get(key);
    if (!run) {
      run = once(() => apply(kind, id, target));
      applied.set(key, run);
    }
    return run();
  };
};

const deferDeadLetters = <T>(resolve: () => Promise<{ deadLetters: DeadLetterStore<T> }>): DeadLetterStore<T> => ({
  page: async (options) => (await resolve()).deadLetters.page(options),
  get: async (input) => (await resolve()).deadLetters.get(input),
  list: async (options) => (await resolve()).deadLetters.list(options),
  requeue: async (input) => (await resolve()).deadLetters.requeue(input),
  delete: async (input) => (await resolve()).deadLetters.delete(input),
});

const deferJob = <Input>(resolve: () => Promise<Job<Input>>): Job<Input> => ({
  ready: async () => (await resolve()).ready(),
  submit: async (job) => (await resolve()).submit(job),
  submitMany: async (jobs, options) => (await resolve()).submitMany(jobs, options),
  submitBatch: async (jobs) => (await resolve()).submitBatch(jobs),
  pause: async (options) => (await resolve()).pause(options),
  resume: async () => (await resolve()).resume(),
  process: async (options, handler) => (await resolve()).process(options, handler),
  deadLetters: deferDeadLetters(resolve),
});

const deferQueue = <T>(resolve: () => Promise<Queue<T>>): Queue<T> => ({
  ready: async () => (await resolve()).ready(),
  send: async (message) => (await resolve()).send(message),
  sendBatch: async (messages) => (await resolve()).sendBatch(messages),
  pause: async (options) => (await resolve()).pause(options),
  resume: async () => (await resolve()).resume(),
  process: async (options, handler) => (await resolve()).process(options, handler),
  reader: async (options) => (await resolve()).reader(options),
  deadLetters: deferDeadLetters(resolve),
});

/**
 * The process Sync with Cloud's job and queue budgets. A job or queue is
 * declared to Sync on its first use, after its existing streams carry the
 * limit it declares; every other primitive is Sync's own.
 */
export const withSyncBudgets = (sync: Sync, { connection, namespace }: { connection: NatsConnection; namespace: string }): Sync => {
  const limits = createStreamLimits(connection, namespace);
  const retention = (kind: Kind, config: QueueConfig) =>
    limits(kind, config.id, config.retention ?? syncBudgetRetention(config.maxPayloadBytes));
  return {
    ...sync,
    job: <Input>(config: JobConfig) =>
      deferJob(once(async () => sync.job<Input>({ ...config, retention: await retention("job", config) }))),
    queue: <T>(config: QueueConfig) =>
      deferQueue(once(async () => sync.queue<T>({ ...config, retention: await retention("queue", config) }))),
  };
};
