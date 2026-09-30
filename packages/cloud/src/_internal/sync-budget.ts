/**
 * Brings existing JetStream streams to the byte limits that the Sync jobs,
 * queues, and topics of one Cloud process declare.
 *
 * JetStream reserves a stream's whole `max_bytes` on every replica as soon as
 * the stream exists. @k2b/sync 7 declares small limits: a job or queue without
 * `retention` holds 256 messages at its payload limit, and `deadLetterRetention`
 * sizes dead letters apart from the work or event stream. Sync never
 * reconfigures an existing stream, though. A stream created with other limits,
 * such as the 1 GiB that Sync 6 gave every job and queue without `retention`,
 * fails the declaration with `ResourceDriftError` on `max_bytes`.
 *
 * Before a job, queue, or topic is first used, this module therefore changes
 * the byte limit of each such stream in place. A stream that holds more than
 * its new limit would lose its oldest messages; it keeps its limit instead:
 *
 * - a job or queue is declared with the stream's current limit, so its work
 *   stays usable, and a later start applies the new limit;
 * - a topic is declared synchronously, before its streams can be inspected,
 *   so its declaration keeps reporting the drift until the stream holds less.
 */
import {
  type DeadLetterStore,
  type Job,
  type JobConfig,
  type Queue,
  type QueueConfig,
  ResourceDriftError,
  type Sync,
  type Topic,
  type TopicConfig,
} from "@k2b/sync";
import { jetstreamManager, RetentionPolicy, type StreamInfo } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { logger } from "../services/logging";

/** Sync 7's limits for a job or queue declared without `retention`, which @k2b/sync does not export. */
const SYNC_PAYLOAD_BYTES = 128 * 1024;
const SYNC_DEAD_LETTER_HEADROOM_BYTES = 4096;
const SYNC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Byte limit Sync 7 gives a job or queue without `retention`: 256 messages at its payload limit, at most 1 GiB. */
export const syncDefaultMaxBytes = (maxPayloadBytes = SYNC_PAYLOAD_BYTES): number =>
  Math.min(1024 ** 3, 256 * (maxPayloadBytes + SYNC_DEAD_LETTER_HEADROOM_BYTES));

const log = logger("sync:budget");

type Kind = "job" | "queue" | "topic";
type Limits = { work: number; deadLetters: number };

/** Memoizes a promise, forgetting a rejection so the next call retries. */
const once = <T>(create: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= create().catch((error: unknown) => {
      pending = undefined;
      throw error;
    }));
};

/** The stream and declared byte limit when Sync refused a declaration only for an existing stream's byte limit. */
const byteLimitDrift = (error: unknown): { stream: string; maxBytes: number } | undefined => {
  if (!(error instanceof ResourceDriftError) || error.differences.length !== 1) return undefined;
  const [difference] = error.differences;
  if (difference?.field !== "max_bytes" || typeof difference.declared !== "number") return undefined;
  return { stream: error.resource, maxBytes: difference.declared };
};

/** Byte limits a job or queue declares for its work and dead-letter streams. */
const declaredLimits = (config: QueueConfig | JobConfig): Limits => {
  const work = config.retention?.maxBytes ?? syncDefaultMaxBytes(config.maxPayloadBytes);
  return { work, deadLetters: config.deadLetterRetention?.maxBytes ?? work };
};

/** The declaration with the given limits, or unchanged when they are its own. */
const withLimits = <Config extends QueueConfig | JobConfig>(config: Config, target: Limits, limits: Limits): Config =>
  limits.work === target.work && limits.deadLetters === target.deadLetters
    ? config
    : {
        ...config,
        retention: { maxAgeMs: SYNC_MAX_AGE_MS, ...config.retention, maxBytes: limits.work },
        deadLetterRetention: { ...config.deadLetterRetention, maxBytes: limits.deadLetters },
      };

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
   * Limits a job or queue declares: its own, except for an existing stream
   * that holds more than its new limit, which keeps its current limit.
   */
  const keep = async (kind: Kind, id: string, target: Limits): Promise<Limits> => {
    const streams = (await list()).get(`${kind}:${id}`) ?? [];
    const kept = (info: StreamInfo | undefined, maxBytes: number): number => {
      if (!info || info.config.max_bytes === maxBytes || info.state.bytes <= maxBytes) return maxBytes;
      log.warn("Kept the byte limit of a Sync stream that holds more than its new limit", {
        kind,
        id,
        stream: info.config.name,
        limit: info.config.max_bytes,
        target: maxBytes,
        held: info.state.bytes,
      });
      return info.config.max_bytes;
    };
    return {
      work: kept(
        streams.find((info) => info.config.retention === RetentionPolicy.Workqueue),
        target.work,
      ),
      deadLetters: kept(
        streams.find((info) => info.config.retention !== RetentionPolicy.Workqueue),
        target.deadLetters,
      ),
    };
  };

  /** Streams reported as too full to lower; a topic retries on every use, but logs once. */
  const reported = new Set<string>();

  /**
   * Provisions a declaration. Each existing stream whose byte limit differs
   * from the declared one gets the declared limit if it holds no more; then
   * the declaration is tried again. Each stream is changed at most once.
   */
  const adopt = async (kind: Kind, id: string, ready: () => Promise<void>): Promise<void> => {
    const changed = new Set<string>();
    for (;;) {
      try {
        return await ready();
      } catch (error) {
        const drift = byteLimitDrift(error);
        if (!drift || changed.has(drift.stream)) throw error;
        changed.add(drift.stream);
        const jsm = await manager();
        const info = await jsm.streams.info(drift.stream);
        if (info.state.bytes > drift.maxBytes) {
          if (reported.has(drift.stream)) throw error;
          reported.add(drift.stream);
          log.warn("Kept the byte limit of a Sync stream that holds more than its new limit", {
            kind,
            id,
            stream: drift.stream,
            limit: info.config.max_bytes,
            target: drift.maxBytes,
            held: info.state.bytes,
          });
          throw error;
        }
        await jsm.streams.update(drift.stream, { max_bytes: drift.maxBytes });
        log.info("Changed the byte limit of a Sync stream", {
          kind,
          id,
          stream: drift.stream,
          from: info.config.max_bytes,
          to: drift.maxBytes,
        });
      }
    }
  };

  return { keep, adopt };
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

/** A declared topic whose every provisioning use waits until `ready` has adopted its streams. */
const deferTopic = <T>(topic: Topic<T>, ready: () => Promise<void>): Topic<T> => {
  const whenReady = <Result>(use: () => Promise<Result>): Promise<Result> => ready().then(use);
  const iterateWhenReady = async function* <Event>(open: () => AsyncIterable<Event>): AsyncIterable<Event> {
    await ready();
    yield* open();
  };
  return {
    ready,
    publish: (input) => whenReady(() => topic.publish(input)),
    publishBatch: (input) => whenReady(() => topic.publishBatch(input)),
    hub: (options) => {
      const hub = topic.hub(options);
      return { subscribe: (subscription) => iterateWhenReady(() => hub.subscribe(subscription)), close: () => hub.close() };
    },
    cursorSequence: (cursor) => topic.cursorSequence(cursor),
    cursorAt: (sequence) => topic.cursorAt(sequence),
    pauseConsumer: (input) => whenReady(() => topic.pauseConsumer(input)),
    resumeConsumer: (input) => whenReady(() => topic.resumeConsumer(input)),
    latestCursor: (options) => whenReady(() => topic.latestCursor(options)),
    head: () => whenReady(() => topic.head()),
    live: (options) => iterateWhenReady(() => topic.live(options)),
    replay: (options) => iterateWhenReady(() => topic.replay(options)),
    follow: (options) => iterateWhenReady(() => topic.follow(options)),
    destroy: () => topic.destroy(),
    process: (options, handler) => whenReady(() => topic.process(options, handler)),
    deadLetters: {
      list: (options) => whenReady(() => topic.deadLetters.list(options)),
      get: (input) => whenReady(() => topic.deadLetters.get(input)),
      delete: (input) => whenReady(() => topic.deadLetters.delete(input)),
      replay: (input) => whenReady(() => topic.deadLetters.replay(input)),
    },
  };
};

/**
 * The process Sync whose jobs, queues, and topics adopt the byte limits of
 * their existing streams before first use. A job or queue is declared to Sync
 * on its first use or on `ready()`; a topic is declared at once. Every other
 * primitive is Sync's own.
 */
export const withSyncBudgets = (sync: Sync, { connection, namespace }: { connection: NatsConnection; namespace: string }): Sync => {
  const { keep, adopt } = createStreamLimits(connection, namespace);
  /** Every job, queue, and topic declared so far, so `ready()` provisions them like Sync does. */
  const declared = new Map<string, () => Promise<unknown>>();

  const declareWork = <Config extends QueueConfig | JobConfig, Handle extends { ready(): Promise<void> }>(
    kind: "job" | "queue",
    config: Config,
    create: (config: Config) => Handle,
  ): (() => Promise<Handle>) => {
    const resolve = once(async () => {
      const target = declaredLimits(config);
      const handle = create(withLimits(config, target, await keep(kind, config.id, target)));
      await adopt(kind, config.id, () => handle.ready());
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
    job: <Input>(config: JobConfig) => deferJob(declareWork("job", config, (declaration) => sync.job<Input>(declaration))),
    queue: <T>(config: QueueConfig) => deferQueue(declareWork("queue", config, (declaration) => sync.queue<T>(declaration))),
    topic: <T>(config: TopicConfig) => {
      const topic = sync.topic<T>(config);
      const ready = once(() => adopt("topic", config.id, () => topic.ready()));
      declared.set(`topic:${config.id}`, ready);
      return deferTopic(topic, ready);
    },
  };
};
