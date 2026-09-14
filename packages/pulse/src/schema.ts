import { sql as database } from "bun";

/** Install a fresh Pulse schema atomically. There is deliberately no upgrade path. */
export const initializeSchema = async (): Promise<void> => {
  await database.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('pulse.schema.install', 0))`;
    const [existing] = await sql`
      SELECT to_regclass('pulse.installation') IS NOT NULL AS installed,
             EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'pulse') AS populated
    `;
    if (existing?.installed) return;
    if (existing?.populated) {
      throw new Error(
        "Pulse requires a fresh schema. Remove the disposable Alpha schema explicitly before starting; automatic upgrades are not supported.",
      );
    }
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.simple();

    await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.simple();

    await sql`CREATE SCHEMA IF NOT EXISTS pulse`.simple();

    await sql`
    CREATE TABLE pulse.bases (
      data_clear_error TEXT,
      data_clear_failed_at TIMESTAMPTZ,
      data_clear_completed_at TIMESTAMPTZ,
      data_clear_started_at TIMESTAMPTZ,
      deletion_error TEXT,
      deletion_failed_at TIMESTAMPTZ,
      deletion_started_at TIMESTAMPTZ,
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      name TEXT NOT NULL,
      description TEXT,
      retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
      rollup_retention_days INTEGER NOT NULL DEFAULT 365 CHECK (rollup_retention_days BETWEEN 1 AND 3650),
      sensitive_retention_hours INTEGER NOT NULL DEFAULT 24 CHECK (sensitive_retention_hours BETWEEN 1 AND 8760),
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();

    await sql`CREATE UNIQUE INDEX idx_pulse_bases_short_id ON pulse.bases(short_id)`.simple();

    await sql`CREATE INDEX idx_pulse_bases_created_by ON pulse.bases(created_by)`.simple();

    await sql`
    CREATE INDEX idx_pulse_bases_active_updated
    ON pulse.bases(updated_at DESC)
    WHERE deletion_started_at IS NULL
  `.simple();

    await sql`
    CREATE TABLE pulse.base_deletions (
      base_id UUID PRIMARY KEY REFERENCES pulse.bases(id) ON DELETE CASCADE,
      requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'deleting', 'failed')),
      phase TEXT NOT NULL DEFAULT 'queued',
      deleted_rows BIGINT NOT NULL DEFAULT 0,
      last_batch_rows INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();

    await sql`CREATE INDEX idx_pulse_base_deletions_status ON pulse.base_deletions(status, updated_at)`.simple();

    await sql`
    CREATE TABLE pulse.base_data_clears (
      base_id UUID PRIMARY KEY REFERENCES pulse.bases(id) ON DELETE CASCADE,
      requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'clearing', 'failed', 'completed')),
      phase TEXT NOT NULL DEFAULT 'queued',
      deleted_rows BIGINT NOT NULL DEFAULT 0,
      last_batch_rows INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();

    await sql`CREATE INDEX idx_pulse_base_data_clears_status ON pulse.base_data_clears(status, updated_at)`.simple();

    await sql`
    CREATE TABLE pulse.base_access (
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
      PRIMARY KEY (base_id, access_id)
    )
  `.simple();

    await sql`CREATE INDEX idx_pulse_base_access_access ON pulse.base_access(access_id)`.simple();

    await sql`
    CREATE TYPE pulse.source_kind AS ENUM ('metrics', 'http_ingest');
  `.simple();

    await sql`
    CREATE TABLE pulse.sources (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      kind pulse.source_kind NOT NULL,
      name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      endpoint_url TEXT,
      bearer_token_encrypted TEXT,
      scrape_interval_seconds INTEGER,
      last_scrape_slot_at TIMESTAMPTZ,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_seen_at TIMESTAMPTZ,
      last_error TEXT,
      last_error_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pulse_sources_scrape_interval_check CHECK (scrape_interval_seconds IS NULL OR (scrape_interval_seconds >= 60 AND scrape_interval_seconds <= 86400 AND scrape_interval_seconds % 60 = 0))
    )
  `.simple();

    await sql`CREATE UNIQUE INDEX idx_pulse_sources_short_id ON pulse.sources(short_id)`.simple();

    await sql`CREATE INDEX idx_pulse_sources_base ON pulse.sources(base_id, kind)`.simple();

    await sql`
    CREATE TABLE pulse.source_scrapes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      source_id UUID NOT NULL REFERENCES pulse.sources(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ NOT NULL,
      duration_ms INTEGER NOT NULL,
      success BOOLEAN NOT NULL,
      metrics_count INTEGER NOT NULL DEFAULT 0,
      events_count INTEGER NOT NULL DEFAULT 0,
      states_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT
    )
  `.simple();

    await sql`CREATE INDEX idx_pulse_source_scrapes_source_started ON pulse.source_scrapes(source_id, started_at DESC)`.simple();

    await sql`
    CREATE TABLE pulse.ingest_idempotency (
      source_id UUID NOT NULL REFERENCES pulse.sources(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (source_id, idempotency_key),
      CONSTRAINT pulse_ingest_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 1 AND 200)
    )
  `.simple();

    await sql`CREATE INDEX idx_pulse_ingest_idempotency_expires ON pulse.ingest_idempotency(expires_at)`.simple();

    await sql`
    CREATE TYPE pulse.metric_type AS ENUM ('gauge', 'counter');
  `.simple();

    await sql`
    CREATE TABLE pulse.metric_defs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      unit TEXT,
      type pulse.metric_type NOT NULL DEFAULT 'gauge',
      default_aggregation TEXT NOT NULL DEFAULT 'avg',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (base_id, name)
    )
  `.simple();

    await sql`
    CREATE TABLE pulse.metric_series (
      resource_label TEXT,
      resource_type TEXT,
      resource_id TEXT,
      resource_key TEXT,
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      metric_id UUID NOT NULL REFERENCES pulse.metric_defs(id) ON DELETE CASCADE,
      source_id UUID REFERENCES pulse.sources(id) ON DELETE SET NULL,
      series_key TEXT NOT NULL,
      dimensions_hash TEXT NOT NULL,
      dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ
    )
  `.simple();

    await sql`CREATE INDEX idx_pulse_metric_series_base_metric ON pulse.metric_series(base_id, metric_id)`.simple();

    await sql`CREATE INDEX idx_pulse_metric_series_source ON pulse.metric_series(source_id) WHERE source_id IS NOT NULL`.simple();

    await sql`CREATE INDEX idx_pulse_metric_series_resource ON pulse.metric_series(base_id, resource_key, last_seen_at DESC) WHERE resource_key IS NOT NULL`.simple();

    await sql`CREATE UNIQUE INDEX idx_pulse_metric_series_unique_key ON pulse.metric_series(base_id, metric_id, series_key)`.simple();

    await sql`
    CREATE TABLE pulse.metric_series_dimensions (
      series_id UUID NOT NULL REFERENCES pulse.metric_series(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (series_id, key)
    )
  `.simple();

    await sql`CREATE INDEX idx_pulse_metric_series_dimensions_lookup ON pulse.metric_series_dimensions(key, value, series_id)`.simple();

    await sql`CREATE INDEX idx_pulse_metric_series_dimensions_key_search ON pulse.metric_series_dimensions USING GIN (key gin_trgm_ops)`.simple();

    await sql`CREATE INDEX idx_pulse_metric_series_dimensions_value_search ON pulse.metric_series_dimensions USING GIN (value gin_trgm_ops)`.simple();

    await sql`
    CREATE TABLE pulse.metric_samples (
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      series_id UUID NOT NULL REFERENCES pulse.metric_series(id) ON DELETE CASCADE,
      ts TIMESTAMPTZ NOT NULL,
      value DOUBLE PRECISION NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (series_id, ts)
    )
  `.simple();

    await sql`CREATE INDEX idx_pulse_metric_samples_base_ts ON pulse.metric_samples(base_id, ts DESC)`.simple();

    await sql`
    CREATE TABLE pulse.metric_rollups_hourly (
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      series_id UUID NOT NULL REFERENCES pulse.metric_series(id) ON DELETE CASCADE,
      bucket TIMESTAMPTZ NOT NULL,
      sample_count BIGINT NOT NULL,
      value_sum DOUBLE PRECISION NOT NULL,
      value_min DOUBLE PRECISION NOT NULL,
      value_max DOUBLE PRECISION NOT NULL,
      last_value DOUBLE PRECISION NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (series_id, bucket)
    )
  `.simple();

    await sql`CREATE INDEX idx_pulse_metric_rollups_hourly_base_bucket ON pulse.metric_rollups_hourly(base_id, bucket DESC)`.simple();

    await sql`
    CREATE TABLE pulse.events (
      resource_label TEXT,
      resource_type TEXT,
      resource_id TEXT,
      resource_key TEXT,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      source_id UUID REFERENCES pulse.sources(id) ON DELETE SET NULL,
      ts TIMESTAMPTZ NOT NULL,
      kind TEXT NOT NULL,
      value DOUBLE PRECISION,
      actor_id TEXT,
      session_id TEXT,
      correlation_id TEXT,
      dimensions_hash TEXT NOT NULL,
      dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
      attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
      sensitive JSONB NOT NULL DEFAULT '{}'::jsonb,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (id, ts)
    )
  `.simple();

    await sql`CREATE INDEX idx_pulse_events_base_kind_ts ON pulse.events(base_id, kind, ts DESC)`.simple();

    await sql`CREATE INDEX idx_pulse_events_actor_ts ON pulse.events(base_id, actor_id, ts DESC) WHERE actor_id IS NOT NULL`.simple();

    await sql`CREATE INDEX idx_pulse_events_correlation_ts ON pulse.events(base_id, correlation_id, ts DESC) WHERE correlation_id IS NOT NULL`.simple();

    await sql`CREATE INDEX idx_pulse_events_resource_ts ON pulse.events(base_id, resource_key, ts DESC) WHERE resource_key IS NOT NULL`.simple();

    await sql`CREATE INDEX idx_pulse_events_ts_brin ON pulse.events USING BRIN (ts) WITH (autosummarize = on)`.simple();

    await sql`
    CREATE TABLE pulse.states_current (
      resource_label TEXT,
      resource_type TEXT,
      resource_id TEXT,
      resource_key TEXT,
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      state_key TEXT NOT NULL,
      variant_key TEXT NOT NULL,
      source_id UUID REFERENCES pulse.sources(id) ON DELETE SET NULL,
      value JSONB NOT NULL,
      dimensions_hash TEXT NOT NULL,
      dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (base_id, state_key, variant_key)
    )
  `.simple();

    await sql`CREATE INDEX idx_pulse_states_current_resource ON pulse.states_current(base_id, resource_key, updated_at DESC) WHERE resource_key IS NOT NULL`.simple();

    await sql`
    CREATE TABLE pulse.state_changes (
      sequence BIGINT GENERATED ALWAYS AS IDENTITY,
      resource_label TEXT,
      resource_type TEXT,
      resource_id TEXT,
      resource_key TEXT,
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      state_key TEXT NOT NULL,
      variant_key TEXT NOT NULL,
      source_id UUID REFERENCES pulse.sources(id) ON DELETE SET NULL,
      value JSONB NOT NULL,
      dimensions_hash TEXT NOT NULL,
      dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
      changed_at TIMESTAMPTZ NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();

    await sql`CREATE INDEX idx_pulse_state_changes_key_ts ON pulse.state_changes(base_id, state_key, changed_at DESC, sequence DESC)`.simple();

    await sql`CREATE INDEX idx_pulse_state_changes_resource_ts ON pulse.state_changes(base_id, resource_key, changed_at DESC) WHERE resource_key IS NOT NULL`.simple();

    await sql`
    CREATE TABLE pulse.signal_fields (
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      source_id UUID NOT NULL REFERENCES pulse.sources(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('metric', 'event', 'state')),
      signal_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('dimension', 'attribute', 'sensitive')),
      key TEXT NOT NULL,
      value_type TEXT NOT NULL CHECK (value_type IN ('null', 'string', 'number', 'boolean', 'object', 'array', 'mixed')),
      observed_count BIGINT NOT NULL DEFAULT 0,
      first_seen_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (base_id, source_id, scope, signal_name, role, key)
    )
  `.simple();

    await sql`CREATE INDEX idx_pulse_signal_fields_catalog ON pulse.signal_fields(base_id, scope, signal_name, role, key)`.simple();

    await sql`
    CREATE TABLE pulse.observed_resources (
      search_text TEXT,
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      resource_key TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      resource_type TEXT,
      label TEXT NOT NULL,
      source_ids UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
      dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (base_id, resource_key)
    )
  `.simple();

    await sql`CREATE UNIQUE INDEX idx_pulse_observed_resources_id ON pulse.observed_resources(id)`.simple();

    await sql`CREATE INDEX idx_pulse_observed_resources_base_seen ON pulse.observed_resources(base_id, last_seen_at DESC)`.simple();

    await sql`CREATE INDEX idx_pulse_observed_resources_base_type ON pulse.observed_resources(base_id, resource_type, last_seen_at DESC)`.simple();

    await sql`CREATE INDEX idx_pulse_observed_resources_sources ON pulse.observed_resources USING GIN (source_ids)`.simple();

    await sql`
    CREATE INDEX idx_pulse_observed_resources_search
    ON pulse.observed_resources USING GIN (search_text gin_trgm_ops)
  `.simple();

    await sql`
    CREATE FUNCTION pulse.refresh_observed_resource_search_text()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.search_text := concat_ws(' ', NEW.resource_key, NEW.resource_id, NEW.resource_type, NEW.label, NEW.dimensions::text);
      RETURN NEW;
    END $$
  `.simple();

    await sql`
    CREATE TRIGGER pulse_observed_resources_search_text
    BEFORE INSERT OR UPDATE OF resource_key, resource_id, resource_type, label, dimensions
    ON pulse.observed_resources
    FOR EACH ROW EXECUTE FUNCTION pulse.refresh_observed_resource_search_text()
  `.simple();

    await sql`CREATE INDEX idx_pulse_metric_defs_name_search ON pulse.metric_defs USING GIN (name gin_trgm_ops)`.simple();

    await sql`CREATE INDEX idx_pulse_metric_series_base_source_seen ON pulse.metric_series(base_id, source_id, last_seen_at DESC)`.simple();

    await sql`CREATE INDEX idx_pulse_events_base_source_ts ON pulse.events(base_id, source_id, ts DESC)`.simple();

    await sql`CREATE INDEX idx_pulse_states_base_source_updated ON pulse.states_current(base_id, source_id, updated_at DESC)`.simple();

    await sql`CREATE INDEX idx_pulse_events_kind_search ON pulse.events USING GIN (kind gin_trgm_ops)`.simple();

    await sql`CREATE INDEX idx_pulse_states_key_search ON pulse.states_current USING GIN (state_key gin_trgm_ops)`.simple();

    await sql`
    CREATE TABLE pulse.dashboards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      public_enabled BOOLEAN NOT NULL DEFAULT false,
      public_token_encrypted TEXT,
      public_token_hash TEXT UNIQUE,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();

    await sql`CREATE UNIQUE INDEX idx_pulse_dashboards_short_id ON pulse.dashboards(short_id)`.simple();

    await sql`CREATE INDEX idx_pulse_dashboards_base ON pulse.dashboards(base_id)`.simple();

    await sql`CREATE INDEX idx_pulse_dashboards_public ON pulse.dashboards(public_token_hash) WHERE public_enabled = TRUE AND public_token_hash IS NOT NULL`.simple();

    await sql`
    CREATE TABLE pulse.saved_queries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      query TEXT NOT NULL,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();

    await sql`CREATE UNIQUE INDEX idx_pulse_saved_queries_short_id ON pulse.saved_queries(short_id)`.simple();

    await sql`CREATE INDEX idx_pulse_saved_queries_base_updated ON pulse.saved_queries(base_id, updated_at DESC)`.simple();

    await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        PERFORM create_hypertable('pulse.metric_samples', 'ts', if_not_exists => TRUE);
        PERFORM create_hypertable('pulse.metric_rollups_hourly', 'bucket', if_not_exists => TRUE);
        PERFORM create_hypertable('pulse.events', 'ts', if_not_exists => TRUE);
      END IF;
    END $$
  `.simple();
    await sql`CREATE TABLE pulse.installation (installed_at TIMESTAMPTZ NOT NULL DEFAULT now())`.simple();
    await sql`INSERT INTO pulse.installation DEFAULT VALUES`;
  });
};
