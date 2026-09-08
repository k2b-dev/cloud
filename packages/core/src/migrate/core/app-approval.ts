import { sql, type SQL } from "bun";

/** Additive, opt-in credential storage. Private keys never enter this schema. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db`CREATE TABLE IF NOT EXISTS auth.app_devices (
    id UUID PRIMARY KEY, issuer TEXT NOT NULL, user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, public_key JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, assisted BOOLEAN NOT NULL,
    enrolled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL, notified_at TIMESTAMPTZ,
    UNIQUE(issuer, user_id, public_key)
  )`.simple();
  await db`CREATE INDEX IF NOT EXISTS app_devices_owner ON auth.app_devices(issuer, user_id, created_at, id)`.simple();
  await db`CREATE TABLE IF NOT EXISTS auth.app_pairings (
    id UUID PRIMARY KEY, issuer TEXT NOT NULL, user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    initiated_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    assisted BOOLEAN NOT NULL, initiator_sid UUID NOT NULL,
    secret_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','confirmed','cancelled')),
    device_id UUID, public_key JSONB, name TEXT, comparison TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  await db`CREATE INDEX IF NOT EXISTS app_pairings_expiry ON auth.app_pairings(expires_at)`.simple();
  await db`CREATE TABLE IF NOT EXISTS auth.app_logins (
    id UUID PRIMARY KEY, issuer TEXT NOT NULL, user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    auth_epoch BIGINT, category TEXT NOT NULL, browser_hash TEXT NOT NULL, challenge TEXT NOT NULL,
    comparison TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','denied','consumed')),
    approved_by UUID REFERENCES auth.app_devices(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
  )`.simple();
  await db`CREATE INDEX IF NOT EXISTS app_logins_pending ON auth.app_logins(issuer, user_id, expires_at)`.simple();
  await db`CREATE INDEX IF NOT EXISTS app_logins_expiry ON auth.app_logins(expires_at)`.simple();
  await db`CREATE TABLE IF NOT EXISTS auth.app_device_proofs (
    device_id UUID NOT NULL REFERENCES auth.app_devices(id) ON DELETE CASCADE,
    jti UUID NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(device_id,jti)
  )`.simple();
  await db`CREATE INDEX IF NOT EXISTS app_device_proofs_expiry ON auth.app_device_proofs(expires_at)`.simple();
};
