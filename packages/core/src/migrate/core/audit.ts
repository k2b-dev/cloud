import { sql } from "@k2b/cloud";
import { repairEncodedMetadata } from "./jsonb-metadata";

/** An entry an app's runtime key wrote on its own; `audit.list` and `latest` leave these out (the same words). */
const AUTOMATIC = "(metadata->>'provenance' = 'system' AND metadata->>'service' = 'app-workload') IS TRUE";

/**
 * A partial index on the log, built without blocking the writes of every app: CONCURRENTLY, so outside a transaction.
 * A valid index stays; a build running elsewhere is left alone; an invalid one left by an interrupted build is
 * dropped and built again, because IF NOT EXISTS would keep it. Where the optional TimescaleDB made the log a
 * hypertable, which takes no CONCURRENTLY, each chunk is indexed in its own transaction instead.
 */
const buildPartialIndex = async (name: string, predicate: string) => {
  const index = `audit.${name}`;
  const [state] = await sql<{ present: boolean; valid: boolean; building: boolean; timescale: boolean }[]>`
    SELECT to_regclass(${index}) IS NOT NULL AS present,
      EXISTS (SELECT 1 FROM pg_catalog.pg_index WHERE indexrelid = to_regclass(${index}) AND indisvalid AND indisready AND indislive) AS valid,
      EXISTS (SELECT 1 FROM pg_catalog.pg_stat_progress_create_index progress
        WHERE progress.datname = pg_catalog.current_database() AND progress.relid = to_regclass('audit.events')) AS building,
      EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'timescaledb') AS timescale`;
  if (state?.valid || state?.building) return;
  const columns = "audit.events (created_at DESC, id DESC)";
  if (state?.timescale) {
    const [hyper] = await sql<{ yes: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_schema = 'audit' AND hypertable_name = 'events') AS yes`;
    if (hyper?.yes) {
      if (state.present) await sql.unsafe(`DROP INDEX IF EXISTS ${index}`).simple();
      await sql
        .unsafe(`CREATE INDEX IF NOT EXISTS ${name} ON ${columns} WITH (timescaledb.transaction_per_chunk) WHERE ${predicate}`)
        .simple();
      return;
    }
  }
  if (state?.present) await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${index}`).simple();
  await sql.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${columns} WHERE ${predicate}`).simple();
};

export const migrate = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS audit`.simple();
  console.log("  ✓ audit schema");

  await sql`
    CREATE TABLE IF NOT EXISTS audit.events (
      id BIGINT GENERATED ALWAYS AS IDENTITY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      actor_user_id UUID,
      actor_uid TEXT,
      actor_provider TEXT,
      actor_roles TEXT[] NOT NULL DEFAULT '{}',
      target_type TEXT,
      target_id TEXT,
      target_label TEXT,
      target_provider TEXT,
      reason TEXT,
      error_code TEXT,
      error_message TEXT,
      request_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT audit_events_outcome_check CHECK (outcome IN ('allowed', 'denied', 'failed'))
    )
  `.simple();

  await sql`CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit.events(created_at DESC)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit.events(actor_user_id, created_at DESC)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_events_actor_uid ON audit.events(actor_uid, created_at DESC)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_events_target ON audit.events(target_type, target_id, created_at DESC)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit.events(action, created_at DESC)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_events_outcome ON audit.events(outcome, created_at DESC)`.simple();
  // The visible log alone: the newest visible entries read only themselves, not the automatic app-key entries between
  // them, which are most of the log. Writes of those automatic entries do not touch this index.
  await buildPartialIndex("idx_audit_events_visible_created", `NOT (${AUTOMATIC})`);
  console.log("  ✓ audit.events table");
  await repairEncodedMetadata("audit.events");

  // Optional production enhancement. Local dev does not ship TimescaleDB, and
  // audit correctness must never depend on this extension being installed.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
        BEGIN
          CREATE EXTENSION IF NOT EXISTS timescaledb;
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'Skipping optional TimescaleDB extension setup for audit.events: %', SQLERRM;
        END;
      END IF;

      IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        BEGIN
          PERFORM create_hypertable('audit.events', 'created_at', if_not_exists => TRUE, migrate_data => TRUE);
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'Skipping optional TimescaleDB hypertable setup for audit.events: %', SQLERRM;
        END;
      END IF;
    END $$;
  `.simple();
};
