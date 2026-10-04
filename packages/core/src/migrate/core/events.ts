/**
 * The platform outbox. Applications write live updates (and, later, public
 * app events) in the transaction that makes the change; a dispatcher publishes
 * them after commit. Every application shares this table because they share
 * the platform database, as `workflows.*` already requires.
 *
 * Every row is pending: dispatchers delete a row once it is published. There
 * is no dead state, so `events.enqueue` turns anything that would fail forever
 * into something that cannot: an oversized live payload becomes a resync hint.
 */
import { type SQL, sql } from "bun";

export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    // Core replicas may start together during a rollout.
    await tx`SELECT pg_advisory_xact_lock(hashtext('cloud.events.migrate'))`;
    await tx`CREATE SCHEMA IF NOT EXISTS events`.simple();
    await tx`
      CREATE TABLE IF NOT EXISTS events.outbox (
        seq             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id              UUID NOT NULL UNIQUE,
        app_id          TEXT NOT NULL CHECK (char_length(app_id) BETWEEN 1 AND 80),
        kind            TEXT NOT NULL CHECK (kind IN ('event', 'live')),
        ordering_key    TEXT NOT NULL CHECK (char_length(ordering_key) BETWEEN 1 AND 600),
        coalesce_key    TEXT CHECK (coalesce_key IS NULL OR (kind = 'live' AND char_length(coalesce_key) <= 700)),
        payload         JSONB NOT NULL
                        CHECK (octet_length(payload::text) <= CASE kind WHEN 'event' THEN 4096 ELSE 33792 END),
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        claimed_until   TIMESTAMPTZ,
        last_error      TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.simple();
    await tx`CREATE INDEX IF NOT EXISTS idx_events_outbox_claim ON events.outbox (kind, app_id, next_attempt_at, seq)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS idx_events_outbox_order ON events.outbox (kind, app_id, ordering_key, seq)`.simple();
    await tx`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_outbox_coalesce
      ON events.outbox (app_id, coalesce_key) WHERE coalesce_key IS NOT NULL
    `.simple();
    // The only write path, for the TypeScript API and for application SQL triggers.
    // A coalesce key joins live rows of one transaction: the last payload wins, the first seq stays.
    await tx`
      CREATE OR REPLACE FUNCTION events.enqueue(
        p_id UUID, p_app_id TEXT, p_kind TEXT, p_ordering_key TEXT, p_payload JSONB, p_coalesce TEXT DEFAULT NULL
      ) RETURNS VOID LANGUAGE sql AS $$
        INSERT INTO events.outbox (id, app_id, kind, ordering_key, coalesce_key, payload)
        VALUES (p_id, p_app_id, p_kind, p_ordering_key,
                CASE WHEN p_coalesce IS NULL THEN NULL ELSE pg_current_xact_id()::text || ':' || p_coalesce END,
                CASE WHEN p_kind = 'live' AND octet_length(p_payload::text) > 32768
                     THEN jsonb_build_object('v', 1, 'k', p_ordering_key, 'r', true)
                     ELSE p_payload END)
        ON CONFLICT (app_id, coalesce_key) WHERE coalesce_key IS NOT NULL
        DO UPDATE SET payload = EXCLUDED.payload
      $$
    `.simple();
  });
  console.log("  ✓ events.outbox table");
};
