import { type SQL, sql } from "bun";

export const migrate = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('cloud.app-events.migrate'))`;
    await tx`CREATE TABLE IF NOT EXISTS events.app_events (
      seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id UUID NOT NULL UNIQUE, type TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), source TEXT NOT NULL,
      subject_key TEXT NOT NULL, envelope JSONB NOT NULL CHECK(octet_length(envelope::text) <= 4096),
      state TEXT NOT NULL CHECK(state IN ('accepted','rejected')), code TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.simple();
    await tx`CREATE INDEX IF NOT EXISTS app_events_type ON events.app_events(type,version,seq DESC)`.simple();
    await tx`CREATE INDEX IF NOT EXISTS app_events_retention ON events.app_events(received_at)`.simple();
    await tx`CREATE TABLE IF NOT EXISTS events.app_declarations (
      app_id TEXT NOT NULL,
      type TEXT NOT NULL,
      version INTEGER NOT NULL,
      subject TEXT NOT NULL,
      place TEXT,
      automation BOOLEAN NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      data_schema JSONB NOT NULL,
      schema_hash TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(app_id, type, version)
    )`.simple();
    await tx`CREATE TABLE IF NOT EXISTS events.app_manifests (
      app_id TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.simple();
    await tx`CREATE TABLE IF NOT EXISTS events.app_subscriptions (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, event_type TEXT NOT NULL, version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','blocked','cancelled')), reason TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.simple();
    await tx`CREATE TABLE IF NOT EXISTS events.app_deliveries (
      seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id UUID NOT NULL UNIQUE,
      subscription_id TEXT NOT NULL REFERENCES events.app_subscriptions(id),
      event_id UUID NOT NULL REFERENCES events.app_events(id), subject_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','retrying','done','failed','cancelled')),
      code TEXT, last_error TEXT CHECK(length(last_error) <= 1000), attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_attempt_at TIMESTAMPTZ,
      claimed_until TIMESTAMPTZ, claim_token UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(subscription_id,event_id)
    )`.simple();
    await tx`ALTER TABLE events.app_deliveries ADD COLUMN IF NOT EXISTS unreachable_count INTEGER NOT NULL DEFAULT 0`.simple();
    await tx`CREATE INDEX IF NOT EXISTS app_deliveries_pending ON events.app_deliveries(next_attempt_at,seq) WHERE state IN ('pending','retrying')`.simple();
    await tx`CREATE INDEX IF NOT EXISTS app_deliveries_order ON events.app_deliveries(subscription_id,subject_key,seq) WHERE state IN ('pending','retrying','failed')`.simple();
    await tx`CREATE INDEX IF NOT EXISTS app_deliveries_retention ON events.app_deliveries(updated_at)`.simple();
    await tx`CREATE TABLE IF NOT EXISTS events.app_broker_status (
      id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id), last_sequence BIGINT NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'ready', code TEXT, gap_from BIGINT, gap_to BIGINT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.simple();
    await tx`INSERT INTO events.app_broker_status(id) VALUES(true) ON CONFLICT DO NOTHING`;
  });
};
