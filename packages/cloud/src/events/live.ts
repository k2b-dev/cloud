import type { Topic, TopicConfig } from "@k2b/sync";
import { type SQL, sql } from "bun";
import { z } from "zod";
import { lazySync } from "../_internal/process-sync";
import { logger } from "../services/logging";
import { createPgOutbox } from "../services/outbox";

const RECONCILE_INTERVAL_MS = 1_000;
const STALE_CHECK_INTERVAL_MS = 60_000;

/**
 * The live topic of one application. Frozen: Sync rejects a declaration that
 * differs from the existing stream, so two releases with different values
 * would break each other during a rollout. A change ships under a new id.
 */
export const liveTopicConfig = (appId: string) =>
  ({
    id: `cloud:live:${appId}`,
    owner: "cloud",
    retention: { maxAgeMs: 24 * 3_600_000, maxBytes: 64 * 1024 ** 2 },
    maxPayloadBytes: 40 * 1024,
    deadLetterRetention: { maxBytes: 1024 ** 2 },
  }) satisfies TopicConfig;

/** One outbox row on the topic. `r`: the payload was too large, reload the state of key `k`. */
const LiveEnvelopeSchema = z.object({
  v: z.literal(1),
  k: z.string().min(1),
  d: z.unknown().optional(),
  r: z.literal(true).optional(),
});
type LiveEnvelope = z.infer<typeof LiveEnvelopeSchema>;

type LiveOutboxRow = { id: string; attempts: number; ordering_key: string; payload: LiveEnvelope };

/** A live update read from the topic. `data` is null when the subscriber must reload the state of `key`. */
export type LiveUpdate<T> = { cursor: string; key: string; data: T | null };

const log = logger("events:live");

const liveTopics = lazySync((sync) => {
  const topics = new Map<string, Topic<LiveEnvelope>>();
  return (appId: string): Topic<LiveEnvelope> => {
    const existing = topics.get(appId);
    if (existing) return existing;
    const topic = sync.topic<LiveEnvelope>(liveTopicConfig(appId));
    topics.set(appId, topic);
    return topic;
  };
});

/** Dispatcher of one application's live rows: ordered per key, deleted once published. */
export const liveOutbox = (appId: string, publish: (row: LiveOutboxRow) => Promise<unknown>) =>
  createPgOutbox<LiveOutboxRow>({
    table: "events.outbox",
    name: `events:live:${appId}`,
    where: { kind: "live", app_id: appId },
    orderBy: "ordering_key",
    sequence: "seq",
    onDelivered: "delete",
    reconcileIntervalMs: RECONCILE_INTERVAL_MS,
    publish,
  });

/** Applications whose live updates this process defines, with the wake of their running dispatcher. */
const dispatchers = new Map<string, (() => void) | null>();

const logStaleRows = async (appId: string): Promise<void> => {
  const [row] = await sql<{ count: number; oldest_seconds: number | null }[]>`
    SELECT COUNT(*)::int AS count, EXTRACT(EPOCH FROM now() - MIN(created_at))::int AS oldest_seconds
    FROM events.outbox
    WHERE kind = 'live' AND app_id = ${appId} AND created_at < now() - interval '60 seconds'
  `;
  if (row && row.count > 0) log.warn("Live updates wait to be published", { appId, count: row.count, oldestSeconds: row.oldest_seconds });
};

/**
 * Publishes the rows of the live definitions in this process. `app.start()`
 * calls it with the started application's ID; it does nothing without a
 * definition, and fails when a definition names another application or Core
 * has not created the outbox yet.
 */
export const startLiveOutbox = async (startedAppId: string): Promise<(() => Promise<void>) | null> => {
  const appIds = [...dispatchers.keys()];
  if (appIds.length === 0) return null;
  const foreign = appIds.filter((appId) => appId !== startedAppId);
  if (foreign.length > 0) {
    throw new Error(
      `defineLive() names "${foreign.join('", "')}", but this process starts "${startedAppId}". Use the ID from the application's declaration.`,
    );
  }
  const [installed] = await sql<{ ready: boolean }[]>`
    SELECT to_regprocedure('events.enqueue(uuid,text,text,text,jsonb,text)') IS NOT NULL AS ready
  `;
  if (!installed?.ready) {
    throw new Error(
      `"${appIds.join('", "')}" writes live updates to events.outbox, which does not exist. Update Cloud Core first: its migration creates the outbox.`,
    );
  }
  const stops = appIds.map((appId) => {
    const topic = liveTopics()(appId);
    const outbox = liveOutbox(appId, (row) => topic.publish({ data: row.payload, orderingKey: row.ordering_key, idempotencyKey: row.id }));
    outbox.start();
    dispatchers.set(appId, () => void outbox.notify());
    const staleCheck = setInterval(() => {
      logStaleRows(appId).catch((error) =>
        log.warn("Live outbox check failed", { appId, error: error instanceof Error ? error.message : String(error) }),
      );
    }, STALE_CHECK_INTERVAL_MS);
    staleCheck.unref();
    return async () => {
      clearInterval(staleCheck);
      dispatchers.set(appId, null);
      await outbox.stop();
    };
  });
  return async () => {
    await Promise.all(stops.map((stop) => stop()));
  };
};

/**
 * Live updates of one application: hints, optionally with data, for its own
 * open tabs. Define them once at module scope; `app.start()` then publishes the
 * rows that `publish()` writes. `appId` is required and must be the ID that the
 * process starts; it is never derived from the process.
 */
export const defineLive = <const Event extends z.ZodType>(definition: { appId: string; event: Event }) => {
  const { appId, event } = definition;
  if (!dispatchers.has(appId)) dispatchers.set(appId, null);
  return {
    /**
     * Writes one update in `tx`, the transaction that makes the change: a
     * rollback writes nothing, a commit publishes it at least once. Data above
     * 32 KiB becomes a reload hint for `key`; `data` must not hold anything a
     * reader of `key` may not see.
     */
    publish: async (tx: SQL, input: { key: string; data: z.input<Event> }): Promise<void> => {
      // Store the JSON form of the input, and validate exactly that form here:
      // subscribe() parses it once, so transforms run for the subscriber and data
      // that does not survive JSON fails this write instead of every read.
      const data: unknown = JSON.parse(JSON.stringify(input.data));
      event.parse(data);
      const envelope = JSON.stringify({ v: 1, k: input.key, d: data });
      await tx`SELECT events.enqueue(${crypto.randomUUID()}::uuid, ${appId}, 'live', ${input.key}, ${envelope}::text::jsonb)`;
    },
    /** Publishes committed updates now instead of within the next second. Call it after the commit. */
    wake: (): void => dispatchers.get(appId)?.(),
    /** The topic head. Read it before loading the snapshot it belongs to. */
    cursor: (): Promise<string> => liveTopics()(appId).head(),
    /**
     * Updates after `after`, shared by every subscriber in this process.
     * Interim: a later release replaces it with shared live routes and removes it.
     */
    async *subscribe(options: { after?: string; signal?: AbortSignal } = {}): AsyncGenerator<LiveUpdate<z.output<Event>>> {
      for await (const update of liveTopics()(appId).hub().subscribe(options)) {
        const envelope = LiveEnvelopeSchema.safeParse(update.data);
        if (!envelope.success) {
          log.warn("Skipped a malformed live update", { appId, cursor: update.cursor });
          continue;
        }
        const data = envelope.data.r ? null : event.safeParse(envelope.data.d);
        yield { cursor: update.cursor, key: envelope.data.k, data: data?.success ? data.data : null };
      }
    },
  };
};
