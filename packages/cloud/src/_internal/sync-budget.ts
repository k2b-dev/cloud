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
 * messages at that limit, never more than Sync's own 1 GiB. An explicit
 * `retention` still wins.
 *
 * Sync refuses a declaration whose byte limit differs from the existing
 * stream (`ResourceDriftError`), so before a job or queue is first used this
 * module lowers or raises the limit of its existing streams in place. A stream
 * that already holds more than the new limit would lose its oldest messages;
 * it keeps its current limit instead, and a later start applies the new one.
 */
import {
  type DeadLetterStore,
  type Job,
  type JobConfig,
  type Queue,
  type QueueConfig,
  ResourceDriftError,
  type RetentionConfig,
  type Sync,
} from "@k2b/sync";
import { jetstreamManager, type StreamInfo } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { logger } from "../services/logging";

/** Sync 6.5 defaults that @k2b/sync does not export. */
const SYNC_PAYLOAD_BYTES = 128 * 1024;
const SYNC_DEAD_LETTER_HEADROOM_BYTES = 4096;
const SYNC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SYNC_MAX_BYTES = 1024 ** 3;

/**
 * Pending messages at the payload limit a job or queue without declared
 * retention holds before Sync discards the oldest. Cloud's jobs carry
 * identifiers whose state lives in Postgres, about half a KiB per stored
 * message, so the same budget holds tens of thousands of typical messages.
 */
const SYNC_BACKLOG_MESSAGES = 256;

/**
 * Retention for a job or queue declared without one: 33 MiB per stream at
 * Sync's 128 KiB payload limit. Above about 4 MiB per message the budget stops
 * at Sync's own 1 GiB, so no declaration reserves more than it did before.
 */
export const syncBudgetRetention = (maxPayloadBytes = SYNC_PAYLOAD_BYTES): RetentionConfig => ({
  maxAgeMs: SYNC_MAX_AGE_MS,
  maxBytes: Math.min(SYNC_MAX_BYTES, SYNC_BACKLOG_MESSAGES * (maxPayloadBytes + SYNC_DEAD_LETTER_HEADROOM_BYTES)),
});

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

/** Sync refused a declaration only because an existing stream has another byte limit. */
const isByteLimitDrift = (error: unknown): boolean =>
  error instanceof ResourceDriftError &&
  error.differences.length > 0 &&
  error.differences.every((difference) => difference.field === "max_bytes");

const createStreamLimits = (connection: NatsConnection, namespace: string) => {
  const manager = once(() => jetstreamManager(connection));

  /**
   * Work and dead-letter streams per job and queue of this namespace as they
   * are now. Concurrent callers share one listing; a later call lists again,
   * so streams that another process created or changed since are seen.
   */
  let listing: Promise<Map<string, StreamInfo[]>> | undefined;
  const list = () =>
    (listing ??= (async () => {
      const jsm = await manager();
      const streams = new Map<string, StreamInfo[]>();
      for await (const info of jsm.streams.list()) {
        const metadata = info.config.metadata;
        const kind = metadata?.["sync.kind"];
        if (metadata?.["sync.namespace"] !== namespace || metadata["sync.managed"] !== "true") continue;
        // A job's coalescing claims live in a KV bucket without a byte limit.
        if ((kind !== "job" && kind !== "queue") || info.config.name.startsWith("KV_")) continue;
        const key = `${kind}:${metadata["sync.id"]}`;
        streams.set(key, [...(streams.get(key) ?? []), info]);
      }
      return streams;
    })().finally(() => {
      listing = undefined;
    }));

  /**
   * Brings the existing streams of a job or queue to `maxBytes` and returns
   * the byte limit to declare. A stream that holds more than `maxBytes` is
   * left alone: with `keep`, its current limit is returned so the declaration
   * matches it; without, Sync's drift check reports it.
   */
  return async (kind: Kind, id: string, maxBytes: number, keep: boolean): Promise<number> => {
    const streams = (await list()).get(`${kind}:${id}`) ?? [];
    const differing = streams.filter((info) => info.config.max_bytes !== maxBytes);
    if (differing.length === 0) return maxBytes;
    const limits = new Set(streams.map((info) => info.config.max_bytes));
    const held = Math.max(...streams.map((info) => info.state.bytes));
    if (held > maxBytes) {
      const [limit = maxBytes] = limits;
      if (!keep || limits.size > 1) return maxBytes;
      log.warn("Kept the byte limit of a Sync stream that holds more than its new limit", { kind, id, limit, target: maxBytes, held });
      return limit;
    }
    const jsm = await manager();
    for (const info of differing) await jsm.streams.update(info.config.name, { max_bytes: maxBytes });
    log.info("Changed the byte limit of Sync streams", { kind, id, from: [...limits], to: maxBytes });
    return maxBytes;
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
 * declared to Sync and provisioned on its first use or on `ready()`, after its
 * existing streams carry the limit it declares; every other primitive is
 * Sync's own.
 */
export const withSyncBudgets = (sync: Sync, { connection, namespace }: { connection: NatsConnection; namespace: string }): Sync => {
  const fit = createStreamLimits(connection, namespace);
  /** Every job and queue declared so far, so `ready()` provisions them like Sync does. */
  const declared = new Map<string, () => Promise<unknown>>();

  const declare = <Handle extends { ready(): Promise<void> }>(
    kind: Kind,
    config: QueueConfig,
    create: (retention: RetentionConfig) => Handle,
  ): (() => Promise<Handle>) => {
    const target = config.retention ?? syncBudgetRetention(config.maxPayloadBytes);
    const declaration = once(async () => {
      const maxBytes = await fit(kind, config.id, target.maxBytes, true);
      return { handle: create({ ...target, maxBytes }), maxBytes };
    });
    const resolve = once(async () => {
      const { handle, maxBytes } = await declaration();
      try {
        await handle.ready();
      } catch (error) {
        if (!isByteLimitDrift(error)) throw error;
        // Another process created or changed the streams between the check and the declaration.
        await fit(kind, config.id, maxBytes, false);
        await handle.ready();
      }
      return handle;
    });
    declared.set(`${kind}:${config.id}`, resolve);
    return resolve;
  };

  return {
    ...sync,
    ready: async () => {
      await Promise.all([...declared.values()].map((resolve) => resolve()));
      await sync.ready();
    },
    job: <Input>(config: JobConfig) => deferJob(declare("job", config, (retention) => sync.job<Input>({ ...config, retention }))),
    queue: <T>(config: QueueConfig) => deferQueue(declare("queue", config, (retention) => sync.queue<T>({ ...config, retention }))),
  };
};
