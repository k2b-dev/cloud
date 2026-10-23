import type { Topic, TopicConfig } from "@k2b/sync";
import { type SQL, sql } from "bun";
import type { z } from "zod";
import { lazySync } from "../_internal/process-sync";
import { logger } from "../services/logging";
import { createPgOutbox } from "../services/outbox";
import type { LiveEnvelope } from "./live-engine";

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

type LiveOutboxRow = { id: string; attempts: number; ordering_key: string; payload: LiveEnvelope };

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
    reconcileIntervalMs: RECONCILE_INTERVAL_MS,
    publish,
  });

/** Applications whose live updates this process defines, with the wake of their running dispatcher. */
const dispatchers = new Map<string, (() => void) | null>();

export const liveTopic = (appId: string): Topic<LiveEnvelope> => liveTopics()(appId);

const logStaleRows = async (appId: string): Promise<void> => {
  const [row] = await sql<{ count: number; oldest_seconds: number | null }[]>`
    SELECT COUNT(*)::int AS count, EXTRACT(EPOCH FROM now() - MIN(created_at))::int AS oldest_seconds
    FROM events.outbox
    WHERE kind = 'live' AND app_id = ${appId} AND created_at < now() - interval '60 seconds'
  `;
  if (row && row.count > 0) log.warn("Live updates wait to be published", { appId, count: row.count, oldestSeconds: row.oldest_seconds });
};

/** Starts delivery for an application with registered publishers; shared with live sockets and access invalidations. */
export const startLiveDelivery = async (appId: string): Promise<(() => Promise<void>) | null> => {
  if (!dispatchers.has(appId)) return null;
  const [installed] = await sql<{ ready: boolean }[]>`
    SELECT to_regprocedure('events.enqueue(uuid,text,text,text,jsonb,text)') IS NOT NULL AS ready
  `;
  if (!installed?.ready) {
    throw new Error(
      `"${appId}" writes live updates to events.outbox, which does not exist. Update Cloud Core first: its migration creates the outbox.`,
    );
  }
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
};

/** Transactional publisher using the application's existing live topic and outbox. */
export const defineLivePublisher = <const Event extends z.ZodType>(definition: { appId: string; event: Event }) => {
  const { appId, event } = definition;
  if (!dispatchers.has(appId)) dispatchers.set(appId, null);
  return {
    /**
     * Writes one update in `tx`, the transaction that makes the change: a
     * rollback writes nothing, a commit publishes it at least once. Data above
     * 32 KiB becomes a reload hint for `key`; `data` must not hold anything a
     * reader of `key` may not see. `access: true` announces that who may read
     * `key` changed, in a row of its own before the data: every replica checks
     * its subscribers of `key` again before it delivers the data, and its
     * collections right after.
     */
    publish: async (
      tx: SQL,
      input: { key: string; data: z.input<Event>; access?: true } | { key: string; data?: undefined; access: true },
    ): Promise<void> => {
      // Store the JSON form of the input, and validate exactly that form here:
      // the browser parses it, and data that does not survive JSON fails this write.
      const data: unknown = input.data === undefined ? undefined : JSON.parse(JSON.stringify(input.data));
      if (data !== undefined) event.parse(data);
      const enqueue = (envelope: LiveEnvelope) =>
        tx`SELECT events.enqueue(${crypto.randomUUID()}::uuid, ${appId}, 'live', ${input.key}, ${JSON.stringify(envelope)}::text::jsonb)`;
      // The access change is a row of its own, so data too large for the outbox cannot drop it.
      if (input.access) await enqueue({ v: 1, k: input.key, a: true });
      if (data !== undefined) await enqueue({ v: 1, k: input.key, d: data });
    },
    /** Publishes committed updates now instead of within the next second. Call it after the commit. */
    wake: (): void => dispatchers.get(appId)?.(),
    /** The topic head. Read it before loading the snapshot it belongs to. */
    cursor: (): Promise<string> => liveTopics()(appId).head(),
  };
};
