import type { sql } from "bun";

export const installBaseStores = async (tx: typeof sql) => {
  await tx`CREATE TABLE pulse.base_stores (
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
    usage_bytes BIGINT, usage_rows BIGINT, usage_measured_at TIMESTAMPTZ,
    last_error TEXT CHECK (last_error ~ '^[A-Z0-9_:]{1,64}$'), last_error_at TIMESTAMPTZ,
    attempts INT NOT NULL DEFAULT 0,
    checkpoint_id UUID, pending_checkpoint_id UUID, checkpoint_at TIMESTAMPTZ,
    write_block_reason TEXT CHECK (write_block_reason IN ('checkpoint_mismatch','database_missing')),
    write_blocked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await tx`CREATE INDEX ON pulse.base_stores (state, updated_at)`.simple();
  await tx`CREATE INDEX ON pulse.base_stores (usage_measured_at)`.simple();
  await tx`CREATE TABLE pulse.base_internal_targets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), base_id UUID NOT NULL REFERENCES pulse.bases(id) ON DELETE CASCADE,
    entry TEXT NOT NULL, created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(base_id, entry)
  )`.simple();
  await tx`CREATE INDEX ON pulse.base_internal_targets (created_at, id)`.simple();
  await tx`CREATE TABLE pulse.store_instance (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton), free_bytes BIGINT NOT NULL,
    total_bytes BIGINT NOT NULL, measured_at TIMESTAMPTZ NOT NULL
  )`.simple();
};
