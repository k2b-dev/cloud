import { type SQL, sql } from "bun";

/** Additive, opt-in credential storage. Private keys never enter this schema. */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db`CREATE TABLE IF NOT EXISTS auth.app_devices (
    id UUID PRIMARY KEY, issuer TEXT NOT NULL, user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, public_key JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, assisted BOOLEAN NOT NULL,
    enrolled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL, notified_at TIMESTAMPTZ,
    UNIQUE(issuer, user_id, public_key)
  )`.simple();
  // Opaque authenticator push token; it can only trigger a wake-up notification.
  await db`ALTER TABLE auth.app_devices ADD COLUMN IF NOT EXISTS push_token TEXT`.simple();
  await db`ALTER TABLE auth.app_devices ADD COLUMN IF NOT EXISTS actions_at TIMESTAMPTZ`.simple();
  await db`ALTER TABLE auth.app_devices ADD COLUMN IF NOT EXISTS action_wake_at TIMESTAMPTZ`.simple();
  await db`ALTER TABLE auth.app_devices ADD COLUMN IF NOT EXISTS action_wake_ref UUID`.simple();
  await db`ALTER TABLE auth.app_devices ADD COLUMN IF NOT EXISTS login_wake_at TIMESTAMPTZ`.simple();
  await db`ALTER TABLE auth.app_devices ADD COLUMN IF NOT EXISTS login_wake_ref UUID`.simple();
  await db`ALTER TABLE auth.app_devices ADD COLUMN IF NOT EXISTS accepts TEXT[]`.simple();
  await db`CREATE INDEX IF NOT EXISTS app_devices_owner ON auth.app_devices(issuer, user_id, created_at, id)`.simple();
  // Signing an account out everywhere revokes its devices under every issuer, often in per-user loops.
  await db`CREATE INDEX IF NOT EXISTS app_devices_user ON auth.app_devices(user_id)`.simple();
  await db`CREATE TABLE IF NOT EXISTS auth.app_pairings (
    id UUID PRIMARY KEY, issuer TEXT NOT NULL, user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    initiated_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    assisted BOOLEAN NOT NULL, initiator_sid UUID NOT NULL,
    secret_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','confirmed','cancelled')),
    device_id UUID, public_key JSONB, name TEXT, comparison TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`.simple();
  // The target account's epoch at start: signing out everywhere voids pairings that are still open.
  await db`ALTER TABLE auth.app_pairings ADD COLUMN IF NOT EXISTS auth_epoch BIGINT`.simple();
  await db`CREATE INDEX IF NOT EXISTS app_pairings_expiry ON auth.app_pairings(expires_at)`.simple();
  await db`CREATE TABLE IF NOT EXISTS auth.app_logins (
    id UUID PRIMARY KEY, issuer TEXT NOT NULL, user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    auth_epoch BIGINT, category TEXT NOT NULL, browser_hash TEXT NOT NULL, challenge TEXT NOT NULL,
    comparison TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','denied','consumed')),
    approved_by UUID REFERENCES auth.app_devices(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
  )`.simple();
  await db`ALTER TABLE auth.app_logins ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'browser'`.simple();
  await db`ALTER TABLE auth.app_logins ADD COLUMN IF NOT EXISTS device_authorization_id UUID`.simple();
  await db`ALTER TABLE auth.app_logins ADD COLUMN IF NOT EXISTS client_id TEXT`.simple();
  await db`ALTER TABLE auth.app_logins ADD COLUMN IF NOT EXISTS scopes TEXT[]`.simple();
  await db`ALTER TABLE auth.app_logins ADD COLUMN IF NOT EXISTS lifetime_seconds INTEGER`.simple();
  await db`ALTER TABLE auth.app_logins ADD COLUMN IF NOT EXISTS context JSONB`.simple();
  await db`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='auth.app_logins'::regclass AND conname='app_logins_context_bytes') THEN
      ALTER TABLE auth.app_logins ADD CONSTRAINT app_logins_context_bytes CHECK (context IS NULL OR octet_length(context::text) <= 512);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='auth.app_logins'::regclass AND conname='app_logins_kind') THEN
      ALTER TABLE auth.app_logins ADD CONSTRAINT app_logins_kind CHECK (kind IN ('browser','terminal'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='auth.app_logins'::regclass AND conname='app_logins_terminal') THEN
      ALTER TABLE auth.app_logins ADD CONSTRAINT app_logins_terminal CHECK (
        (kind='terminal' AND device_authorization_id IS NOT NULL AND client_id IS NOT NULL AND scopes IS NOT NULL AND lifetime_seconds IS NOT NULL)
        OR (kind='browser' AND device_authorization_id IS NULL AND client_id IS NULL AND scopes IS NULL AND lifetime_seconds IS NULL));
    END IF;
  END $$`.simple();
  await db`CREATE UNIQUE INDEX IF NOT EXISTS app_logins_device_authorization ON auth.app_logins(device_authorization_id) WHERE device_authorization_id IS NOT NULL`.simple();
  await db`CREATE INDEX IF NOT EXISTS app_logins_pending ON auth.app_logins(issuer, user_id, expires_at)`.simple();
  await db`CREATE INDEX IF NOT EXISTS app_logins_expiry ON auth.app_logins(expires_at)`.simple();
  await db`CREATE TABLE IF NOT EXISTS auth.app_device_proofs (
    device_id UUID NOT NULL REFERENCES auth.app_devices(id) ON DELETE CASCADE,
    jti UUID NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(device_id,jti)
  )`.simple();
  await db`CREATE INDEX IF NOT EXISTS app_device_proofs_expiry ON auth.app_device_proofs(expires_at)`.simple();
};
