import { sql } from "bun";

export const migrate = async (): Promise<void> => {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.simple();
  await sql`CREATE SCHEMA IF NOT EXISTS gateway`.simple();
  console.log("  ✓ gateway schema");

  await sql`
    CREATE TABLE IF NOT EXISTS gateway.registered_apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      description TEXT NOT NULL,
      appearance JSONB,
      runtime JSONB,
      base_url TEXT NOT NULL,
      routes JSONB NOT NULL DEFAULT '[]'::jsonb,
      nav JSONB,
      capabilities JSONB,
      legal_links JSONB,
      widgets JSONB,
      openapi TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      removed_at TIMESTAMPTZ,
      last_offline_logged_at TIMESTAMPTZ
    )
  `.simple();
  await sql`ALTER TABLE gateway.registered_apps ADD COLUMN IF NOT EXISTS appearance JSONB`.simple();
  await sql`ALTER TABLE gateway.registered_apps ADD COLUMN IF NOT EXISTS runtime JSONB`.simple();
  await sql`ALTER TABLE gateway.registered_apps ADD COLUMN IF NOT EXISTS capabilities JSONB`.simple();
  // Registry snapshots are rebuilt from live discovery during setup.
  await sql`
    DELETE FROM gateway.registered_apps
    WHERE jsonb_typeof(routes) <> 'array'
       OR (appearance IS NOT NULL AND jsonb_typeof(appearance) <> 'object')
       OR (runtime IS NOT NULL AND jsonb_typeof(runtime) <> 'object')
       OR (nav IS NOT NULL AND jsonb_typeof(nav) <> 'object')
       OR (capabilities IS NOT NULL AND jsonb_typeof(capabilities) <> 'object')
       OR (legal_links IS NOT NULL AND jsonb_typeof(legal_links) <> 'array')
       OR (widgets IS NOT NULL AND jsonb_typeof(widgets) <> 'array')
  `.simple();
  console.log("  ✓ gateway.registered_apps table");

  await sql`
    CREATE INDEX IF NOT EXISTS idx_gateway_registered_apps_last_seen
    ON gateway.registered_apps(last_seen_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_gateway_registered_apps_removed
    ON gateway.registered_apps(removed_at)
  `.simple();
  console.log("  ✓ gateway registered app indexes");

  await sql`
    CREATE TABLE IF NOT EXISTS gateway.health_webhooks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      enabled BOOLEAN NOT NULL DEFAULT true,
      scope_kind TEXT NOT NULL DEFAULT 'all',
      scope_app_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      send_on JSONB NOT NULL DEFAULT '["error","recovery"]'::jsonb,
      min_status TEXT NOT NULL DEFAULT 'error',
      repeat_interval_ms INTEGER NOT NULL DEFAULT 1800000,
      timeout_ms INTEGER NOT NULL DEFAULT 5000,
      last_status TEXT,
      last_sent_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      last_error_at TIMESTAMPTZ,
      last_error TEXT,
      delivery_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  console.log("  ✓ gateway.health_webhooks table");

  await sql`
    CREATE INDEX IF NOT EXISTS idx_gateway_health_webhooks_enabled
    ON gateway.health_webhooks(enabled)
  `.simple();
  console.log("  ✓ gateway health webhook indexes");

  await sql`
    CREATE TABLE IF NOT EXISTS gateway.telemetry_events (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      cursor TEXT NOT NULL,
      kind TEXT NOT NULL,
      app_id TEXT NOT NULL,
      route_prefix TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      status_class INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      error_kind TEXT,
      occurred_at TIMESTAMPTZ NOT NULL
    )
  `.simple();
  // Added after the table shipped — rows predating it keep NULL and render
  // as a fallback to route_prefix rather than breaking the telemetry page.
  await sql`
    ALTER TABLE gateway.telemetry_events
    ADD COLUMN IF NOT EXISTS path_template TEXT
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_gateway_telemetry_events_occurred
    ON gateway.telemetry_events(occurred_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_gateway_telemetry_events_app_route
    ON gateway.telemetry_events(app_id, route_prefix, occurred_at DESC)
  `.simple();
  console.log("  ✓ gateway.telemetry_events table");

  await sql`
    CREATE TABLE IF NOT EXISTS gateway.telemetry_rollups_minute (
      bucket TIMESTAMPTZ NOT NULL,
      app_id TEXT NOT NULL,
      route_prefix TEXT NOT NULL,
      path_template TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      slow_count INTEGER NOT NULL DEFAULT 0,
      total_duration_ms BIGINT NOT NULL DEFAULT 0,
      max_duration_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, app_id, route_prefix, path_template, method, status_code)
    )
  `.simple();
  // Per-template rollups are what let the telemetry page rank endpoints and
  // draw per-row sparklines over 30 days without scanning raw events. Rows
  // only exist for buckets that saw traffic, and the gateway caps distinct
  // templates per app, so this refines the grain without unbounding it.
  // Empty string, not NULL: the column is part of the primary key.
  await sql`
    ALTER TABLE gateway.telemetry_rollups_minute
    ADD COLUMN IF NOT EXISTS path_template TEXT NOT NULL DEFAULT ''
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.key_column_usage
        WHERE table_schema = 'gateway'
          AND table_name = 'telemetry_rollups_minute'
          AND column_name = 'path_template'
      ) THEN
        ALTER TABLE gateway.telemetry_rollups_minute
          DROP CONSTRAINT telemetry_rollups_minute_pkey;
        ALTER TABLE gateway.telemetry_rollups_minute
          ADD PRIMARY KEY (bucket, app_id, route_prefix, path_template, method, status_code);
      END IF;
    END
    $$
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_gateway_telemetry_rollups_minute_bucket
    ON gateway.telemetry_rollups_minute(bucket DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_gateway_telemetry_rollups_minute_app_bucket
    ON gateway.telemetry_rollups_minute(app_id, bucket DESC)
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'gateway'
          AND table_name = 'app_request_slo_windows'
          AND column_name = 'window'
      ) THEN
        ALTER VIEW gateway.app_request_slo_windows RENAME COLUMN "window" TO window_name;
      END IF;
    END
    $$
  `.simple();
  await sql`
    CREATE OR REPLACE VIEW gateway.app_request_slo_windows AS
    WITH windows(name, seconds) AS (
      VALUES ('1h'::text, 3600), ('6h'::text, 21600), ('30d'::text, 2592000)
    ), apps AS (
      SELECT DISTINCT app_id FROM gateway.telemetry_rollups_minute
    )
    SELECT
      apps.app_id,
      windows.name AS window_name,
      COALESCE(sum(rollup.request_count), 0)::bigint AS request_count,
      COALESCE(sum(rollup.error_count), 0)::bigint AS error_count,
      COALESCE(sum(rollup.slow_count), 0)::bigint AS slow_count,
      CASE WHEN COALESCE(sum(rollup.request_count), 0) = 0 THEN 1
        ELSE 1 - (sum(rollup.error_count)::float / sum(rollup.request_count)::float)
      END AS availability_ratio,
      CASE WHEN COALESCE(sum(rollup.request_count), 0) = 0 THEN 1
        ELSE 1 - (sum(rollup.slow_count)::float / sum(rollup.request_count)::float)
      END AS fast_request_ratio,
      min(rollup.bucket) AS observed_since,
      COALESCE(EXTRACT(EPOCH FROM (now() - min(rollup.bucket))), 0)::float AS observed_seconds
    FROM apps
    CROSS JOIN windows
    LEFT JOIN gateway.telemetry_rollups_minute rollup
      ON rollup.app_id = apps.app_id
      AND rollup.bucket >= now() - (windows.seconds * interval '1 second')
    GROUP BY apps.app_id, windows.name, windows.seconds
  `.simple();
  console.log("  ✓ gateway.telemetry_rollups_minute table");
};
