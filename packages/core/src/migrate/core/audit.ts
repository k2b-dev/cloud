import { sql } from "@k2b/cloud";
import { createIndexes } from "@k2b/cloud/services/migration-ddl";
import { repairEncodedMetadata } from "./jsonb-metadata";

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

  await createIndexes(sql, "audit.events", [
    { name: "idx_audit_events_created_at", definition: "(created_at DESC)" },
    { name: "idx_audit_events_actor", definition: "(actor_user_id, created_at DESC)" },
    { name: "idx_audit_events_actor_uid", definition: "(actor_uid, created_at DESC)" },
    { name: "idx_audit_events_target", definition: "(target_type, target_id, created_at DESC)" },
    { name: "idx_audit_events_action", definition: "(action, created_at DESC)" },
    { name: "idx_audit_events_outcome", definition: "(outcome, created_at DESC)" },
  ]);
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
