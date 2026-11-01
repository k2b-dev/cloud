import type { Topic, TopicConfig } from "@k2b/sync";
import { assertAppEventSize } from "../_internal/app-event-schemas";
import { lazySync } from "../_internal/process-sync";
import { type AppEventEnvelope, AppEventEnvelopeSchema } from "../contracts/app-events";
import { sql } from "../runtime/clients";
import { logger } from "../services/logging";
import { createPgOutbox } from "../services/outbox";

/**
 * Frozen shared stream. It only buffers events until Core has stored them, and
 * JetStream reserves `maxBytes` on every replica: 256 MiB hold 52,428 envelopes
 * at the 4096-byte limit plus a 1024-byte transport allowance. The shared
 * producer budget and thin-envelope outage scenarios are in operations/app-events.
 * Retention passing unseen events becomes a visible gap.
 */
export const appEventTopicConfig = () =>
  ({
    id: "cloud:app-events",
    owner: "cloud",
    retention: { maxAgeMs: 7 * 24 * 3_600_000, maxBytes: 256 * 1024 ** 2 },
    maxPayloadBytes: 8 * 1024,
    deadLetterRetention: { maxBytes: 1024 ** 2 },
  }) satisfies TopicConfig;

const topic = lazySync((sync) => sync.topic<AppEventEnvelope>(appEventTopicConfig()));
export const appEventTopic = (): Topic<AppEventEnvelope> => topic();

export type AppEventOutboxRow = {
  id: string;
  app_id: string;
  created_at: Date | string;
  attempts: number;
  ordering_key: string;
  payload: AppEventEnvelope;
};

/** The committed row owns identity, source and timestamp, including for SQL writers. */
export const appEventFromOutbox = (row: AppEventOutboxRow): AppEventEnvelope => {
  const envelope = AppEventEnvelopeSchema.parse({
    ...row.payload,
    id: row.id,
    source: row.app_id,
    time: new Date(row.created_at).toISOString(),
  });
  assertAppEventSize(envelope);
  return envelope;
};

export const appEventOutbox = (appId: string, publish: (row: AppEventOutboxRow) => Promise<unknown>) =>
  createPgOutbox<AppEventOutboxRow>({
    table: "events.outbox",
    name: `events:app:${appId}`,
    where: { kind: "event", app_id: appId },
    orderBy: "ordering_key",
    sequence: "seq",
    reconcileIntervalMs: 1_000,
    publish,
  });

const dispatchers = new Map<string, (() => void) | null>();
export const registerAppEventPublisher = (appId: string): void => {
  if (!dispatchers.has(appId)) dispatchers.set(appId, null);
};
export const wakeAppEventDelivery = (appId: string): void => dispatchers.get(appId)?.();

export const startAppEventDelivery = async (appId: string): Promise<(() => Promise<void>) | null> => {
  if (!dispatchers.has(appId)) return null;
  const [installed] = await sql<{ ready: boolean }[]>`
    SELECT to_regprocedure('events.enqueue(uuid,text,text,text,jsonb,text)') IS NOT NULL AS ready
  `;
  if (!installed?.ready) throw new Error(`"${appId}" publishes app events: update Cloud Core first to install events.outbox`);
  const destination = appEventTopic();
  const outbox = appEventOutbox(appId, (row) =>
    destination.publish({
      data: appEventFromOutbox(row),
      orderingKey: row.ordering_key,
      idempotencyKey: row.id,
    }),
  );
  outbox.start();
  dispatchers.set(appId, () => void outbox.notify());
  const log = logger("events:app");
  const staleCheck = setInterval(() => {
    sql<
      { count: number }[]
    >`SELECT COUNT(*)::int AS count FROM events.outbox WHERE kind = 'event' AND app_id = ${appId} AND created_at < now() - interval '60 seconds'`
      .then(([row]) => {
        if (row && row.count > 0) log.warn("App events wait to be published", { appId, count: row.count });
      })
      .catch((error: unknown) =>
        log.warn("App event outbox check failed", { appId, error: error instanceof Error ? error.message : String(error) }),
      );
  }, 60_000);
  staleCheck.unref();
  return async () => {
    clearInterval(staleCheck);
    dispatchers.set(appId, null);
    await outbox.stop();
  };
};
