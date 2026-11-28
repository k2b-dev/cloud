import { sql } from "@k2b/cloud";
import { addColumns, createIndexes, withTableLock } from "@k2b/cloud/services/migration-ddl";
import type { SQL } from "bun";

export const migrate = async (db: SQL = sql): Promise<void> => {
  // One transaction for all steps; withTableLock bounds its lock waits and retries it as a whole.
  const tables = [
    "events.app_events",
    "events.app_declarations",
    "events.app_subscriptions",
    "events.app_deliveries",
    "events.app_broker_status",
  ];
  await withTableLock(db, tables, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('cloud.app-events.migrate'))`;
    await tx`CREATE TABLE IF NOT EXISTS events.app_events (
      seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id UUID NOT NULL UNIQUE, type TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), source TEXT NOT NULL,
      subject_key TEXT NOT NULL, envelope JSONB NOT NULL CHECK(octet_length(envelope::text) <= 4096),
      state TEXT NOT NULL CHECK(state IN ('accepted','rejected')), code TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.simple();
    await createIndexes(tx, "events.app_events", [
      { name: "app_events_type", definition: "(type,version,seq DESC)" },
      { name: "app_events_retention", definition: "(received_at)" },
    ]);
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
      retired_at TIMESTAMPTZ,
      PRIMARY KEY(app_id, type, version)
    )`.simple();
    await addColumns(tx, "events.app_declarations", { retired_at: "TIMESTAMPTZ" });
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
    await addColumns(tx, "events.app_subscriptions", { resource_binding: "JSONB" });
    await createIndexes(tx, "events.app_subscriptions", [
      {
        name: "app_subscriptions_resource",
        definition: "((resource_binding->>'consumer'),(resource_binding->>'key')) WHERE resource_binding IS NOT NULL",
      },
    ]);
    // Build atomically before the broker starts. CONCURRENTLY cannot run in this transaction.
    // Separate partial indexes keep each OR arm bounded by its matching subscriptions.
    await createIndexes(tx, "events.app_subscriptions", [
      { name: "app_subscriptions_fanout_service", definition: "(event_type,version) WHERE state='active' AND resource_binding IS NULL" },
      {
        name: "app_subscriptions_fanout_resource",
        definition:
          "(event_type,version,(resource_binding->'place'->>'type'),(resource_binding->'place'->>'id'),first_seen_at) WHERE state='active' AND resource_binding IS NOT NULL",
      },
    ]);
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
    await addColumns(tx, "events.app_deliveries", { unreachable_count: "INTEGER NOT NULL DEFAULT 0", retained_from: "TIMESTAMPTZ" });
    // ALTER COLUMN locks the table even without a change, so the catalog decides first.
    await tx`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'events.app_deliveries'::regclass AND a.attname = 'retained_from' AND NOT a.attisdropped
          AND (NOT a.attnotnull OR pg_get_expr(d.adbin, d.adrelid) IS DISTINCT FROM 'now()')) THEN
        UPDATE events.app_deliveries SET retained_from = created_at WHERE retained_from IS NULL;
        ALTER TABLE events.app_deliveries ALTER COLUMN retained_from SET DEFAULT now(), ALTER COLUMN retained_from SET NOT NULL;
      END IF;
    END $$`.simple();
    await createIndexes(tx, "events.app_deliveries", [
      { name: "app_deliveries_event", definition: "(event_id)" },
      { name: "app_deliveries_pending", definition: "(next_attempt_at,seq) WHERE state IN ('pending','retrying')" },
      { name: "app_deliveries_order", definition: "(subscription_id,subject_key,seq) WHERE state IN ('pending','retrying','failed')" },
      { name: "app_deliveries_retention", definition: "(updated_at)" },
    ]);
    await tx`CREATE TABLE IF NOT EXISTS events.app_broker_status (
      id BOOLEAN PRIMARY KEY DEFAULT true CHECK(id), last_sequence BIGINT NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'ready', code TEXT, gap_from BIGINT, gap_to BIGINT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.simple();
    await addColumns(tx, "events.app_broker_status", { unseen_sequences: "INT8MULTIRANGE NOT NULL DEFAULT '{}'::int8multirange" });
    await tx`INSERT INTO events.app_broker_status(id) VALUES(true) ON CONFLICT DO NOTHING`;
  });
};
