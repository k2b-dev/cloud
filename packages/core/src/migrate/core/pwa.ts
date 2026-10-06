import { type SQL, sql } from "bun";

/**
 * Paired phones of the mobile app. Additive: without the `pwa` application no row is ever
 * written. Secrets are stored only as SHA-256 hex.
 */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db`CREATE TABLE IF NOT EXISTS auth.pwa_devices (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'other')),
    auth_epoch BIGINT NOT NULL,
    secret_hash TEXT NOT NULL,
    previous_secret_hash TEXT,
    rotated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT
  )`.simple();
  await db`CREATE INDEX IF NOT EXISTS pwa_devices_user_active ON auth.pwa_devices(user_id) WHERE revoked_at IS NULL`.simple();
  // The "new phone paired" notice: Core's maintenance sends it once per device in the locale of
  // the completing request, then sets notified_at.
  await db`ALTER TABLE auth.pwa_devices
    ADD COLUMN IF NOT EXISTS locale TEXT CHECK (locale IS NULL OR char_length(locale) BETWEEN 1 AND 35),
    ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ`.simple();
  await db`CREATE INDEX IF NOT EXISTS pwa_devices_unnotified ON auth.pwa_devices(created_at) WHERE notified_at IS NULL`.simple();
  // App sessions are ordinary session families bound to one device.
  await db`ALTER TABLE auth.session_families
    ADD COLUMN IF NOT EXISTS pwa_device_id UUID REFERENCES auth.pwa_devices(id) ON DELETE CASCADE`.simple();
  await db`CREATE INDEX IF NOT EXISTS session_families_pwa_device
    ON auth.session_families(pwa_device_id) WHERE pwa_device_id IS NOT NULL`.simple();
  await db`CREATE TABLE IF NOT EXISTS auth.pwa_pairings (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    initiator_sid UUID NOT NULL,
    auth_epoch BIGINT NOT NULL,
    link_secret_hash TEXT NOT NULL UNIQUE,
    completion_secret_hash TEXT UNIQUE,
    comparison TEXT CHECK (comparison IS NULL OR comparison ~ '^[0-9]{6}$'),
    platform TEXT CHECK (platform IS NULL OR platform IN ('ios', 'android', 'other')),
    device_name TEXT CHECK (device_name IS NULL OR char_length(device_name) BETWEEN 1 AND 80),
    failed_attempts SMALLINT NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'confirmed', 'completed', 'cancelled')),
    device_id UUID,
    claim_until TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await db`CREATE INDEX IF NOT EXISTS pwa_pairings_user_open ON auth.pwa_pairings(user_id, expires_at)`.simple();
  await db`CREATE INDEX IF NOT EXISTS pwa_pairings_expiry ON auth.pwa_pairings(expires_at)`.simple();
};
