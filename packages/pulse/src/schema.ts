import type { TransactionSQL } from "bun";

/** The disposable Pulse control-data baseline. Measurements live only in ClickHouse. */
export const installBaseline = async (sql: TransactionSQL): Promise<void> => {
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
      scrape_lease_until TIMESTAMPTZ,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      mirror_pending BOOLEAN NOT NULL DEFAULT true,
      deleted BOOLEAN NOT NULL DEFAULT false,
      last_data_at TIMESTAMPTZ,
      last_accepted_at TIMESTAMPTZ,
      throttled_at TIMESTAMPTZ,
      refused_histograms JSONB NOT NULL DEFAULT '[]'::jsonb,
      skipped_summaries INT NOT NULL DEFAULT 0,
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
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done')),
      accepted_at TIMESTAMPTZ NOT NULL,
      planned_states JSONB,
      response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (source_id, idempotency_key),
      CONSTRAINT pulse_ingest_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 1 AND 200)
    )
  `.simple();

  await sql`CREATE INDEX idx_pulse_ingest_idempotency_expires ON pulse.ingest_idempotency(expires_at)`.simple();

  await sql`CREATE TYPE pulse.metric_type AS ENUM ('gauge','counter')`.simple();
  await sql`CREATE TABLE pulse.metric_defs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
    name TEXT NOT NULL, type pulse.metric_type NOT NULL DEFAULT 'gauge', unit TEXT, UNIQUE(base_id,name)
  )`.simple();
  await sql`CREATE TABLE pulse.metric_series (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
    metric_id UUID NOT NULL REFERENCES pulse.metric_defs(id) ON DELETE CASCADE,
    source_id UUID REFERENCES pulse.sources(id) ON DELETE SET NULL, series_key TEXT NOT NULL,
    dimensions JSONB NOT NULL DEFAULT '{}'::jsonb, resource_key TEXT, resource_type TEXT, resource_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ, last_sample_at TIMESTAMPTZ,
    mirrored BOOLEAN NOT NULL DEFAULT false, UNIQUE(base_id,metric_id,series_key)
  )`.simple();
  await sql`CREATE INDEX ON pulse.metric_series(base_id,last_seen_at)`.simple();
  await sql`CREATE INDEX ON pulse.metric_series(source_id)`.simple();
  await sql`CREATE TABLE pulse.metric_hours (
    base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE, hour TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('dirty','clean','sealed')), revision BIGINT NOT NULL DEFAULT 1,
    lease_until TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(base_id,hour)
  )`.simple();
  await sql`CREATE INDEX ON pulse.metric_hours(state,hour,base_id)`.simple();
  await sql`CREATE TABLE pulse.event_kinds (
    base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE, kind TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(base_id,kind)
  )`.simple();
  await sql`CREATE TABLE pulse.state_keys (
    base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE, state_key TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(base_id,state_key)
  )`.simple();
  await sql`CREATE TABLE pulse.state_variants (
    base_id UUID NOT NULL, state_key TEXT NOT NULL, variant_key TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL, value_hash TEXT NOT NULL, version BIGINT NOT NULL,
    pending_change_id UUID, pending_change_at TIMESTAMPTZ,
    PRIMARY KEY(base_id,state_key,variant_key),
    FOREIGN KEY(base_id,state_key) REFERENCES pulse.state_keys(base_id,state_key) ON DELETE CASCADE
  )`.simple();
  await sql`CREATE TABLE pulse.notification_outbox (
    seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    kind TEXT NOT NULL, user_id UUID NOT NULL, data JSONB NOT NULL, locale TEXT NOT NULL,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), claimed_until TIMESTAMPTZ, last_error TEXT,
    attempts INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await sql`CREATE INDEX ON pulse.notification_outbox(user_id) WHERE claimed_until IS NOT NULL OR attempts > 0`.simple();
  await sql`CREATE TABLE pulse.base_stores (
    base_id UUID PRIMARY KEY REFERENCES pulse.bases(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('provisioning','active','clearing','deleting','failed')),
    operation TEXT CHECK (operation IN ('provision','clear','delete')),
    database_name TEXT UNIQUE NOT NULL, read_user TEXT UNIQUE NOT NULL, read_password_encrypted TEXT,
    profile TEXT NOT NULL DEFAULT 'normal' CHECK (profile IN ('small','normal','large')),
    schema_version INT NOT NULL DEFAULT 0, reconcile_needed BOOLEAN NOT NULL DEFAULT false,
    values_per_minute BIGINT NOT NULL CHECK (values_per_minute > 0),
    bytes_per_minute BIGINT NOT NULL CHECK (bytes_per_minute > 0),
    storage_bytes BIGINT NOT NULL CHECK (storage_bytes > 0),
    max_series BIGINT NOT NULL CHECK (max_series > 0),
    max_event_kinds BIGINT NOT NULL CHECK (max_event_kinds > 0),
    max_state_keys BIGINT NOT NULL CHECK (max_state_keys > 0),
    reset_generation BIGINT NOT NULL DEFAULT 0,
    sealed_before TIMESTAMPTZ,
    usage_bytes BIGINT, usage_rows BIGINT, usage_measured_at TIMESTAMPTZ, storage_exceeded_at TIMESTAMPTZ,
    last_error TEXT CHECK (last_error ~ '^[A-Z0-9_:]{1,64}$'), last_error_at TIMESTAMPTZ,
    attempts INT NOT NULL DEFAULT 0,
    checkpoint_id UUID, pending_checkpoint_id UUID, checkpoint_at TIMESTAMPTZ,
    write_block_reason TEXT CHECK (write_block_reason IN ('checkpoint_mismatch','database_missing')),
    write_blocked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await sql`CREATE INDEX ON pulse.base_stores (state, updated_at)`.simple();
  await sql`CREATE INDEX ON pulse.base_stores (usage_measured_at)`.simple();
  await sql`CREATE TABLE pulse.base_internal_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
    entry TEXT NOT NULL, created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(base_id, entry)
  )`.simple();
  await sql`CREATE INDEX ON pulse.base_internal_targets (created_at, id)`.simple();
  await sql`CREATE TABLE pulse.store_instance (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton), free_bytes BIGINT,
    total_bytes BIGINT, measured_at TIMESTAMPTZ, disk_low_at TIMESTAMPTZ,
    outage_started_at TIMESTAMPTZ, last_outage_ended_at TIMESTAMPTZ
  )`.simple();
};

/** SQL console control data. migrate() holds the installation transaction lock. */
export const installSqlConsole = async (sql: TransactionSQL, timezone: string): Promise<void> => {
  await sql`ALTER TABLE pulse.bases ADD COLUMN icon TEXT NOT NULL DEFAULT 'ti ti-chart-line',
    ADD COLUMN color TEXT NOT NULL DEFAULT 'blue', ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'`.simple();
  await sql`UPDATE pulse.bases SET timezone=${timezone}`;
  await sql`ALTER TABLE pulse.base_stores ADD COLUMN queries_per_hour INTEGER NOT NULL DEFAULT 600 CHECK (queries_per_hour > 0)`.simple();
  await sql`CREATE TABLE pulse.saved_queries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), short_id TEXT NOT NULL CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
    base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    sql TEXT NOT NULL CHECK (octet_length(sql) BETWEEN 1 AND 16384), params JSONB NOT NULL DEFAULT '{}'::jsonb,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by TEXT, updated_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await sql`CREATE UNIQUE INDEX idx_pulse_saved_queries_short_id ON pulse.saved_queries(short_id)`.simple();
  await sql`CREATE UNIQUE INDEX idx_pulse_saved_queries_name ON pulse.saved_queries(base_id,lower(name))`.simple();
  await sql`CREATE INDEX ON pulse.saved_queries(base_id,updated_at DESC,id)`.simple();
  // A receipt survives later revisions/deletion so a retried action never writes twice.
  await sql`CREATE TABLE pulse.saved_query_operations (
    base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
    operation_key TEXT NOT NULL, input_hash TEXT NOT NULL, response JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '24 hours'),
    PRIMARY KEY(base_id,operation_key)
  )`.simple();
  await sql`CREATE INDEX ON pulse.saved_query_operations(expires_at)`.simple();
};

/** Overview and alert state remain in Postgres when the measurement store is unavailable. */
export const installOverviewAlerts = async (sql: TransactionSQL): Promise<void> => {
  await sql`ALTER TABLE pulse.base_stores ADD COLUMN max_alert_rules INTEGER NOT NULL DEFAULT 20 CHECK (max_alert_rules > 0)`.simple();
  await sql`ALTER TABLE pulse.saved_queries ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false`.simple();
  // The base ledger survives query edits/deletion and store resets. A cache
  // miss must never replenish the four-attempt budget for a five-minute slot.
  await sql`CREATE TABLE pulse.overview_state (
    base_id UUID PRIMARY KEY REFERENCES pulse.bases(id) ON DELETE CASCADE,
    slot_start TIMESTAMPTZ NOT NULL,
    attempts JSONB NOT NULL DEFAULT '[]'::jsonb,
    lease_id UUID, lease_until TIMESTAMPTZ,
    snapshots JSONB NOT NULL DEFAULT '[]'::jsonb,
    CHECK (jsonb_typeof(attempts)='array' AND jsonb_array_length(attempts)<=4),
    CHECK (jsonb_typeof(snapshots)='array' AND jsonb_array_length(snapshots)<=4)
  )`.simple();
  await sql`ALTER TABLE pulse.sources
    ADD COLUMN expect_every_seconds INTEGER CHECK (expect_every_seconds > 0),
    ADD COLUMN expect_daily_by TEXT CHECK (expect_daily_by ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD COLUMN stale_since TIMESTAMPTZ,
    ADD COLUMN next_freshness_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD CONSTRAINT pulse_source_expectation CHECK (
      (expect_every_seconds IS NULL OR expect_daily_by IS NULL) AND
      (kind='http_ingest' OR (expect_every_seconds IS NULL AND expect_daily_by IS NULL)))`.simple();
  await sql`CREATE INDEX ON pulse.sources(next_freshness_check_at,base_id) WHERE NOT deleted`.simple();
  await sql`CREATE TABLE pulse.alert_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), short_id TEXT NOT NULL CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
    base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    sql TEXT NOT NULL CHECK (octet_length(sql) BETWEEN 1 AND 16384), params JSONB NOT NULL DEFAULT '{}'::jsonb,
    comparison TEXT NOT NULL CHECK (comparison IN ('above','below')),
    warn DOUBLE PRECISION, critical DOUBLE PRECISION,
    min_duration_seconds INTEGER NOT NULL CHECK (min_duration_seconds >= 0),
    interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 300),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0), created_by TEXT, updated_by TEXT,
    next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(), lease_id UUID, lease_until TIMESTAMPTZ,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('ok','pending','firing','no_data','error')),
    severity TEXT CHECK (severity IN ('warn','critical')), since TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at TIMESTAMPTZ, last_error TEXT, incident_open BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (warn IS NOT NULL OR critical IS NOT NULL),
    CHECK (warn IS NULL OR (warn > '-Infinity'::float8 AND warn < 'Infinity'::float8)),
    CHECK (critical IS NULL OR (critical > '-Infinity'::float8 AND critical < 'Infinity'::float8)),
    CHECK (warn IS NULL OR critical IS NULL OR CASE WHEN comparison='above' THEN critical>=warn ELSE critical<=warn END)
  )`.simple();
  await sql`CREATE UNIQUE INDEX idx_pulse_alert_rules_short_id ON pulse.alert_rules(short_id)`.simple();
  await sql`CREATE UNIQUE INDEX idx_pulse_alert_rules_name ON pulse.alert_rules(base_id,lower(name))`.simple();
  await sql`CREATE INDEX ON pulse.alert_rules(next_check_at,id)`.simple();
  await sql`CREATE TABLE pulse.alert_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES pulse.alert_rules(id) ON DELETE CASCADE, key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ok','pending','firing','no_data','error')),
    severity TEXT CHECK (severity IN ('warn','critical')), value DOUBLE PRECISION,
    since TIMESTAMPTZ NOT NULL, pending_since TIMESTAMPTZ, incident_open BOOLEAN NOT NULL DEFAULT false, last_checked_at TIMESTAMPTZ NOT NULL, last_error TEXT
  )`.simple();
  await sql`CREATE INDEX ON pulse.alert_states(rule_id)`.simple();
  await sql`CREATE TABLE pulse.alert_rule_operations (
    base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE, operation_key TEXT NOT NULL,
    input_hash TEXT NOT NULL, response JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '24 hours'),
    PRIMARY KEY(base_id,operation_key)
  )`.simple();
  await sql`CREATE INDEX ON pulse.alert_rule_operations(expires_at)`.simple();
  await sql`CREATE TABLE pulse.base_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
    at TIMESTAMPTZ NOT NULL DEFAULT now(), kind TEXT NOT NULL, actor JSONB, request_id TEXT, data JSONB NOT NULL
  )`.simple();
  await sql`CREATE INDEX ON pulse.base_activity(base_id,at DESC,id)`.simple();
  await sql`ALTER TABLE pulse.notification_outbox ADD COLUMN base_id UUID REFERENCES pulse.bases(id) ON DELETE CASCADE,
    ADD COLUMN event_id UUID, ADD COLUMN recipient_after UUID,
    ADD COLUMN dispatch_kind TEXT NOT NULL DEFAULT 'delivery' CHECK (dispatch_kind IN ('delivery','fanout')),
    ALTER COLUMN user_id DROP NOT NULL,
    ADD CONSTRAINT pulse_notification_destination CHECK ((dispatch_kind='delivery' AND user_id IS NOT NULL) OR
      (dispatch_kind='fanout' AND user_id IS NULL AND base_id IS NOT NULL AND event_id IS NOT NULL)),
    ADD CONSTRAINT pulse_notification_event_recipient UNIQUE(event_id,user_id)`.simple();
  await sql`CREATE INDEX ON pulse.notification_outbox(dispatch_kind,seq)`.simple();
  await sql`CREATE INDEX ON pulse.notification_outbox(dispatch_kind,base_id,seq) WHERE dispatch_kind='fanout'`.simple();
};

/** Source ownership is durable authorization metadata, independent of activity retention. */
export const installAgentSourceOwnership = async (sql: TransactionSQL): Promise<void> => {
  await sql`ALTER TABLE pulse.sources ADD COLUMN created_by_subject TEXT`.simple();
};
