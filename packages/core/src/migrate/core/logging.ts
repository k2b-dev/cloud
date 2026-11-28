import { sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { buildConcurrentIndexesInBackground } from "@k2b/cloud/services/concurrent-index";
import { createIndexes, withTableLock } from "@k2b/cloud/services/migration-ddl";
import { migrateLogMetadataReader } from "./logging-metadata";

/**
 * A source's newest entries: the logs list and the runs list filter by source (one or several) and sort by created_at,
 * id; the accounts overview reads a source's latest sync lines. Built next to live log writes after the migration.
 */
const SOURCE_INDEX = {
  name: "idx_logging_entries_source_created",
  table: "logging.entries",
  definition: "(source, created_at DESC, id DESC)",
};

export const migrate = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS logging`.simple();
  console.log("  ✓ logging schema");

  await sql`
    CREATE TABLE IF NOT EXISTS logging.entries (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      level TEXT NOT NULL DEFAULT 'info',
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  console.log("  ✓ logging.entries table");
  await migrateLogMetadataReader();

  await createIndexes(sql, "logging.entries", [
    { name: "idx_logging_entries_source", definition: "(source)" },
    { name: "idx_logging_entries_level", definition: "(level)" },
    { name: "idx_logging_entries_created_at", definition: "(created_at DESC)" },
  ]);
  // Composite index for the dashboard summary query: filters of the shape
  // `WHERE level = 'error' AND created_at > <cutoff> ORDER BY created_at DESC`
  // become index-only scans. Massively cheaper than the single-column indexes
  // when the table grows past tens of thousands of rows.
  await createIndexes(sql, "logging.entries", [{ name: "idx_logging_entries_level_created_at", definition: "(level, created_at DESC)" }]);

  await sql`
    CREATE TABLE IF NOT EXISTS logging.trace_spans (
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      span_key TEXT,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      app_id TEXT,
      category TEXT NOT NULL DEFAULT 'custom',
      kind TEXT NOT NULL DEFAULT 'internal',
      status TEXT NOT NULL DEFAULT 'unset',
      status_message TEXT,
      attributes JSONB,
      summary JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ,
      duration_ms DOUBLE PRECISION,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (trace_id, span_id)
    )
  `.simple();
  console.log("  ✓ logging.trace_spans table");

  // One row per static source/name and UTC minute; no job ids or payloads.
  await sql`
    CREATE TABLE IF NOT EXISTS logging.run_minutes (
      bucket TIMESTAMPTZ NOT NULL,
      last_ended_at TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL,
      app_id TEXT NOT NULL,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      run_count BIGINT NOT NULL,
      total_duration_ms DOUBLE PRECISION NOT NULL,
      max_duration_ms DOUBLE PRECISION NOT NULL,
      durations BIGINT[] NOT NULL,
      PRIMARY KEY (bucket, source, app_id, category, name)
    )
  `.simple();
  await createIndexes(sql, "logging.run_minutes", [{ name: "idx_logging_run_minutes_source_bucket", definition: "(source, bucket DESC)" }]);

  // span_key deterministically defines the composite primary key. Keeping a
  // second unique constraint creates two competing conflict targets under
  // concurrent idempotent starts.
  await withTableLock(sql, "logging.trace_spans", (tx) =>
    tx`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'logging.trace_spans'::regclass AND conname = 'trace_spans_span_key_key') THEN
        ALTER TABLE logging.trace_spans DROP CONSTRAINT trace_spans_span_key_key;
      END IF;
    END $$`.simple(),
  );
  await createIndexes(sql, "logging.trace_spans", [
    { name: "idx_logging_trace_spans_span_key", definition: "(span_key) WHERE span_key IS NOT NULL" },
  ]);

  await sql`
    CREATE TABLE IF NOT EXISTS logging.trace_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      name TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      attributes JSONB,
      body TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (trace_id, span_id)
        REFERENCES logging.trace_spans(trace_id, span_id)
        ON DELETE CASCADE
    )
  `.simple();
  console.log("  ✓ logging.trace_events table");

  await createIndexes(sql, "logging.trace_spans", [
    { name: "idx_logging_trace_spans_source_started", definition: "(source, started_at DESC)" },
    { name: "idx_logging_trace_spans_status_started", definition: "(status, started_at DESC)" },
    { name: "idx_logging_trace_spans_category_started", definition: "(category, started_at DESC)" },
    { name: "idx_logging_trace_spans_started", definition: "(started_at DESC)" },
    { name: "idx_logging_trace_spans_ended", definition: "(ended_at) WHERE ended_at IS NOT NULL" },
  ]);
  await createIndexes(sql, "logging.trace_events", [
    { name: "idx_logging_trace_events_span_occurred", definition: "(trace_id, span_id, occurred_at ASC)" },
  ]);
  console.log("  ✓ logging indexes");
  // queries run without it until it is valid; startup never waits for the build
  void buildConcurrentIndexesInBackground([SOURCE_INDEX], { log: logger("core:logging"), purpose: "log list by source" });
};
