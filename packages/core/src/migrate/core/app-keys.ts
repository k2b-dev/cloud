import { sql } from "bun";

/** App public keys share the existing app-bound service-account credential registry. */
export const migrateAppKeys = async (): Promise<void> => {
  await sql.begin(async (db) => {
    await db`SELECT pg_advisory_xact_lock(hashtextextended('auth.app_keys.install', 0))`;
    await db`
      CREATE TABLE IF NOT EXISTS auth.installation (
        singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
        id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid()
      )
    `.simple();
    await db`INSERT INTO auth.installation (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`;
    // Probe the catalogs before DDL: IF NOT EXISTS on ALTER TABLE still takes an
    // exclusive lock. Repeat app-key migrations must not add that lock to credential traffic.
    await db`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'auth.service_account_credentials'::regclass
          AND attname = 'public_key' AND NOT attisdropped) THEN
          ALTER TABLE auth.service_account_credentials ADD COLUMN public_key TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'auth.service_account_credentials'::regclass
          AND attname = 'fingerprint' AND NOT attisdropped) THEN
          ALTER TABLE auth.service_account_credentials ADD COLUMN fingerprint TEXT;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'auth.service_account_credentials'::regclass
          AND attname = 'token_prefix' AND attnotnull) THEN
          ALTER TABLE auth.service_account_credentials ALTER COLUMN token_prefix DROP NOT NULL;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'auth.service_account_credentials'::regclass
          AND attname = 'secret_hash' AND attnotnull) THEN
          ALTER TABLE auth.service_account_credentials ALTER COLUMN secret_hash DROP NOT NULL;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'auth.service_account_credentials'::regclass
          AND conname = 'service_account_credentials_kind_check' AND position('app_key' IN pg_get_constraintdef(oid)) = 0) THEN
          ALTER TABLE auth.service_account_credentials DROP CONSTRAINT service_account_credentials_kind_check;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'auth.service_account_credentials'::regclass
          AND conname = 'service_account_credentials_kind_check') THEN
          ALTER TABLE auth.service_account_credentials ADD CONSTRAINT service_account_credentials_kind_check
            CHECK (kind IN ('api_token', 'app_key')) NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'auth.service_account_credentials'::regclass
          AND conname = 'service_account_credentials_material_check') THEN
          ALTER TABLE auth.service_account_credentials ADD CONSTRAINT service_account_credentials_material_check CHECK (
            (kind = 'api_token' AND token_prefix IS NOT NULL AND secret_hash IS NOT NULL AND public_key IS NULL AND fingerprint IS NULL)
            OR (kind = 'app_key' AND token_prefix IS NULL AND secret_hash IS NULL
              AND public_key IS NOT NULL AND public_key ~ '^[A-Za-z0-9_-]{43}$'
              AND fingerprint IS NOT NULL AND fingerprint ~ '^[0-9a-f]{32}$')
          ) NOT VALID;
        END IF;
        IF to_regclass('auth.uniq_app_key_public_key') IS NULL THEN
          CREATE UNIQUE INDEX uniq_app_key_public_key
            ON auth.service_account_credentials (service_account_id, public_key) WHERE kind = 'app_key';
        END IF;
      END $$
    `.simple();
  });
  // Validation runs after the DDL transaction releases its exclusive lock.
  await sql`
    DO $$ DECLARE constraint_name TEXT; BEGIN
      FOR constraint_name IN SELECT conname FROM pg_constraint
        WHERE conrelid = 'auth.service_account_credentials'::regclass AND NOT convalidated
          AND conname IN ('service_account_credentials_kind_check', 'service_account_credentials_material_check')
      LOOP
        EXECUTE format('ALTER TABLE auth.service_account_credentials VALIDATE CONSTRAINT %I', constraint_name);
      END LOOP;
    END $$
  `.simple();
};
