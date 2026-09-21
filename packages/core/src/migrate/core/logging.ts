import { sql } from "bun";
import { migrateLogMetadataReader } from "./logging-metadata";

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

  await sql`
    CREATE INDEX IF NOT EXISTS idx_logging_entries_source
    ON logging.entries(source)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_logging_entries_level
    ON logging.entries(level)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_logging_entries_created_at
    ON logging.entries(created_at DESC)
  `.simple();
  // Composite index for the dashboard summary query: filters of the shape
  // `WHERE level = 'error' AND created_at > <cutoff> ORDER BY created_at DESC`
  // become index-only scans. Massively cheaper than the single-column indexes
  // when the table grows past tens of thousands of rows.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_logging_entries_level_created_at
    ON logging.entries(level, created_at DESC)
  `.simple();

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

  // span_key deterministically defines the composite primary key. Keeping a
  // second unique constraint creates two competing conflict targets under
  // concurrent idempotent starts.
  await sql`
    ALTER TABLE logging.trace_spans
    DROP CONSTRAINT IF EXISTS trace_spans_span_key_key
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_logging_trace_spans_span_key
    ON logging.trace_spans(span_key)
    WHERE span_key IS NOT NULL
  `.simple();

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

  await sql`
    CREATE INDEX IF NOT EXISTS idx_logging_trace_spans_source_started
    ON logging.trace_spans(source, started_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_logging_trace_spans_status_started
    ON logging.trace_spans(status, started_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_logging_trace_spans_category_started
    ON logging.trace_spans(category, started_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_logging_trace_spans_started
    ON logging.trace_spans(started_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_logging_trace_spans_ended
    ON logging.trace_spans(ended_at)
    WHERE ended_at IS NOT NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_logging_trace_events_span_occurred
    ON logging.trace_events(trace_id, span_id, occurred_at ASC)
  `.simple();
  console.log("  ✓ logging indexes");
};
