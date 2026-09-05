import { sql } from "bun";

export const migrate = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS oauth`.simple();
  console.log("  ✓ oauth schema");

  await sql`
    CREATE TABLE IF NOT EXISTS oauth.clients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      description TEXT,
      client_id TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
      client_secret_hash TEXT,
      redirect_uris TEXT[] NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT ARRAY['openid', 'profile', 'email'],
      audiences TEXT[] NOT NULL DEFAULT ARRAY['cloud'],
      service_account_id UUID REFERENCES auth.service_accounts(id) ON DELETE SET NULL,
      allowed_profiles TEXT[] NOT NULL DEFAULT ARRAY['user', 'guest'],
      registration_kind TEXT NOT NULL DEFAULT 'managed',
      is_public BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      authorized_at TIMESTAMPTZ,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      logout_uri TEXT
    )
  `.simple();
  await sql`
    ALTER TABLE oauth.clients
    ADD COLUMN IF NOT EXISTS audiences TEXT[] NOT NULL DEFAULT ARRAY['cloud']
  `.simple();
  await sql`
    ALTER TABLE oauth.clients
    ADD COLUMN IF NOT EXISTS service_account_id UUID REFERENCES auth.service_accounts(id) ON DELETE SET NULL
  `.simple();
  await sql`
    ALTER TABLE oauth.clients
    ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'profiles'
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'oauth_clients_access_mode_check'
          AND conrelid = 'oauth.clients'::regclass
      ) THEN
        ALTER TABLE oauth.clients
        ADD CONSTRAINT oauth_clients_access_mode_check CHECK (access_mode IN ('profiles', 'specific'));
      END IF;
    END $$
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_clients_service_account
    ON oauth.clients(service_account_id)
  `.simple();
  await sql`
    ALTER TABLE oauth.clients
    ADD COLUMN IF NOT EXISTS registration_kind TEXT NOT NULL DEFAULT 'managed'
  `.simple();
  await sql`
    ALTER TABLE oauth.clients
    ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMPTZ
  `.simple();
  await sql`
    DO $$
    DECLARE
      delete_action "char";
    BEGIN
      SELECT confdeltype
      INTO delete_action
      FROM pg_constraint
      WHERE conname = 'clients_created_by_fkey'
        AND conrelid = 'oauth.clients'::regclass;

      IF delete_action IS DISTINCT FROM 'n' THEN
        ALTER TABLE oauth.clients DROP CONSTRAINT IF EXISTS clients_created_by_fkey;
        ALTER TABLE oauth.clients
        ADD CONSTRAINT clients_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
      END IF;
    END $$
  `.simple();
  await sql`ALTER TABLE oauth.clients DROP CONSTRAINT IF EXISTS clients_name_key`.simple();
  await sql`ALTER TABLE oauth.clients DROP CONSTRAINT IF EXISTS oauth_clients_name_key`.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'oauth_clients_registration_kind_check'
          AND conrelid = 'oauth.clients'::regclass
      ) THEN
        ALTER TABLE oauth.clients
        ADD CONSTRAINT oauth_clients_registration_kind_check
        CHECK (registration_kind IN ('managed', 'first_party', 'dynamic'));
      END IF;
    END $$
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS oauth_clients_managed_name_key
    ON oauth.clients(name)
    WHERE registration_kind IN ('managed', 'first_party')
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS oauth_clients_dynamic_created_at
    ON oauth.clients(created_at)
    WHERE registration_kind = 'dynamic'
  `.simple();
  console.log("  ✓ oauth.clients table");

  await sql`
    CREATE TABLE IF NOT EXISTS oauth.client_access_users (
      client_id UUID NOT NULL REFERENCES oauth.clients(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      PRIMARY KEY (client_id, user_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_client_access_users_user
    ON oauth.client_access_users(user_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS oauth.client_access_groups (
      client_id UUID NOT NULL REFERENCES oauth.clients(id) ON DELETE CASCADE,
      group_id UUID NOT NULL REFERENCES auth.groups(id) ON DELETE CASCADE,
      PRIMARY KEY (client_id, group_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_client_access_groups_group
    ON oauth.client_access_groups(group_id)
  `.simple();
  console.log("  ✓ oauth client access tables");

  await sql`
    CREATE TABLE IF NOT EXISTS oauth.codes (
      code TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      client_id TEXT NOT NULL REFERENCES oauth.clients(client_id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT ARRAY['openid', 'profile', 'email'],
      audiences TEXT[],
      resource TEXT,
      nonce TEXT,
      code_challenge TEXT,
      code_challenge_method TEXT CHECK (code_challenge_method = 'S256'),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '5 minutes',
      used BOOLEAN NOT NULL DEFAULT false
    )
  `.simple();
  await sql`
    ALTER TABLE oauth.codes
    ADD COLUMN IF NOT EXISTS nonce TEXT
  `.simple();
  await sql`
    ALTER TABLE oauth.codes
    ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT ARRAY['openid', 'profile', 'email']
  `.simple();
  await sql`
    ALTER TABLE oauth.codes
    ADD COLUMN IF NOT EXISTS resource TEXT
  `.simple();
  // Retain existing code snapshots; all writers now supply audiences explicitly.
  await sql.begin(async (tx) => {
    await tx`LOCK TABLE oauth.codes IN ACCESS EXCLUSIVE MODE`.simple();
    await tx`ALTER TABLE oauth.codes ADD COLUMN IF NOT EXISTS audiences TEXT[]`.simple();
    await tx`ALTER TABLE oauth.codes ALTER COLUMN audiences DROP DEFAULT`.simple();
    await tx`DROP TRIGGER IF EXISTS fill_code_audiences ON oauth.codes`.simple();
    await tx`DROP FUNCTION IF EXISTS oauth.fill_code_audiences()`.simple();
    await tx`
      UPDATE oauth.codes code
      SET audiences = CASE
        WHEN code.resource IS NOT NULL THEN ARRAY[code.resource]
        ELSE ARRAY(
          SELECT audience
          FROM unnest(ARRAY['cloud', code.client_id]::text[] || client.audiences) WITH ORDINALITY AS value(audience, position)
          GROUP BY audience
          ORDER BY min(position)
        )
      END
      FROM oauth.clients client
      WHERE client.client_id = code.client_id
        AND (code.audiences IS NULL OR code.audiences = ARRAY['cloud']::text[])
    `.simple();
    await tx`ALTER TABLE oauth.codes ALTER COLUMN audiences SET NOT NULL`.simple();
  });
  await sql`ALTER TABLE oauth.codes ADD COLUMN IF NOT EXISTS authority_nonce UUID`.simple();
  await sql`ALTER TABLE oauth.codes ADD COLUMN IF NOT EXISTS authority_issued_at TIMESTAMPTZ`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires
    ON oauth.codes(expires_at)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_codes_client
    ON oauth.codes(client_id)
  `.simple();
  await sql`DELETE FROM oauth.codes WHERE code_challenge_method = 'plain'`.simple();
  await sql`ALTER TABLE oauth.codes DROP CONSTRAINT IF EXISTS codes_code_challenge_method_check`.simple();
  await sql`
    ALTER TABLE oauth.codes
    ADD CONSTRAINT codes_code_challenge_method_check
    CHECK (code_challenge_method IS NULL OR code_challenge_method = 'S256')
  `.simple();
  console.log("  ✓ oauth.codes table");

  await sql`
    CREATE TABLE IF NOT EXISTS oauth.refresh_token_families (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id TEXT NOT NULL REFERENCES oauth.clients(client_id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      scopes TEXT[] NOT NULL,
      audiences TEXT[] NOT NULL DEFAULT ARRAY['cloud'],
      resource TEXT,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      revoked_reason TEXT,
      CONSTRAINT oauth_refresh_token_families_status_check CHECK (status IN ('active', 'revoked'))
    )
  `.simple();
  await sql`
    ALTER TABLE oauth.refresh_token_families
    ADD COLUMN IF NOT EXISTS resource TEXT
  `.simple();
  await sql`
    UPDATE oauth.refresh_token_families
    SET status = 'revoked',
      revoked_at = COALESCE(revoked_at, now()),
      revoked_reason = 'legacy_resource_binding_migration'
    WHERE resource IS NULL
      AND status = 'active'
      AND (NOT audiences @> ARRAY['cloud']::text[] OR NOT client_id = ANY(audiences))
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_token_families_user
    ON oauth.refresh_token_families(user_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_token_families_client
    ON oauth.refresh_token_families(client_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS oauth.refresh_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id UUID NOT NULL REFERENCES oauth.refresh_token_families(id) ON DELETE CASCADE,
      token_prefix TEXT NOT NULL UNIQUE,
      secret_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      generation INTEGER NOT NULL,
      previous_token_id UUID REFERENCES oauth.refresh_tokens(id),
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      rotated_at TIMESTAMPTZ,
      authority_nonce UUID,
      authority_reserved_at TIMESTAMPTZ,
      authority_issued_at TIMESTAMPTZ,
      authority_scopes TEXT[],
      authority_audiences TEXT[],
      authority_resource TEXT,
      revoked_at TIMESTAMPTZ,
      CONSTRAINT oauth_refresh_tokens_status_check CHECK (status IN ('active', 'issuing', 'rotated', 'revoked', 'reused'))
    )
  `.simple();
  await sql`ALTER TABLE oauth.refresh_tokens ADD COLUMN IF NOT EXISTS authority_nonce UUID`.simple();
  await sql`ALTER TABLE oauth.refresh_tokens ADD COLUMN IF NOT EXISTS authority_reserved_at TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE oauth.refresh_tokens ADD COLUMN IF NOT EXISTS authority_issued_at TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE oauth.refresh_tokens ADD COLUMN IF NOT EXISTS authority_scopes TEXT[]`.simple();
  await sql`ALTER TABLE oauth.refresh_tokens ADD COLUMN IF NOT EXISTS authority_audiences TEXT[]`.simple();
  await sql`ALTER TABLE oauth.refresh_tokens ADD COLUMN IF NOT EXISTS authority_resource TEXT`.simple();
  await sql`ALTER TABLE oauth.refresh_tokens DROP CONSTRAINT IF EXISTS oauth_refresh_tokens_status_check`.simple();
  await sql`
    ALTER TABLE oauth.refresh_tokens
    ADD CONSTRAINT oauth_refresh_tokens_status_check
    CHECK (status IN ('active', 'issuing', 'rotated', 'revoked', 'reused'))
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family
    ON oauth.refresh_tokens(family_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_expires
    ON oauth.refresh_tokens(expires_at)
  `.simple();
  await sql`
    UPDATE oauth.refresh_tokens token
    SET status = 'revoked',
      revoked_at = COALESCE(token.revoked_at, now())
    FROM oauth.refresh_token_families family
    WHERE token.family_id = family.id
      AND family.revoked_reason = 'legacy_resource_binding_migration'
      AND token.status = 'active'
  `.simple();
  console.log("  ✓ oauth refresh token tables");

  await sql`
    CREATE TABLE IF NOT EXISTS oauth.client_credentials_authority_grants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nonce UUID NOT NULL DEFAULT gen_random_uuid(),
      client_id TEXT NOT NULL REFERENCES oauth.clients(client_id) ON DELETE CASCADE,
      scopes TEXT[] NOT NULL,
      audiences TEXT[] NOT NULL,
      resource TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '1 minute',
      consumed_at TIMESTAMPTZ
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_oauth_client_credentials_authority_grants_expires
    ON oauth.client_credentials_authority_grants(expires_at)
  `.simple();
  console.log("  ✓ oauth client credentials authority grants");

  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM oauth.clients WHERE client_id = 'cloud-cli') THEN
        UPDATE oauth.clients
        SET name = 'Cloud CLI',
          description = 'First-party public OAuth client for the cloud CLI.',
          redirect_uris = ARRAY['http://127.0.0.1/callback', 'http://[::1]/callback'],
          scopes = ARRAY['openid', 'profile', 'email', 'offline_access', 'read', 'write'],
          audiences = ARRAY['cloud'],
          service_account_id = NULL,
          allowed_profiles = ARRAY['user', 'guest'],
          access_mode = 'profiles',
          registration_kind = 'first_party',
          is_public = true,
          client_secret_hash = NULL
        WHERE client_id = 'cloud-cli';
      ELSIF EXISTS (
        SELECT 1
        FROM oauth.clients
        WHERE name = 'Cloud CLI'
          AND registration_kind <> 'dynamic'
      ) THEN
        UPDATE oauth.clients
        SET client_id = 'cloud-cli',
          name = 'Cloud CLI',
          description = 'First-party public OAuth client for the cloud CLI.',
          redirect_uris = ARRAY['http://127.0.0.1/callback', 'http://[::1]/callback'],
          scopes = ARRAY['openid', 'profile', 'email', 'offline_access', 'read', 'write'],
          audiences = ARRAY['cloud'],
          service_account_id = NULL,
          allowed_profiles = ARRAY['user', 'guest'],
          access_mode = 'profiles',
          registration_kind = 'first_party',
          is_public = true,
          client_secret_hash = NULL
        WHERE name = 'Cloud CLI'
          AND registration_kind <> 'dynamic';
      ELSE
        INSERT INTO oauth.clients (
          name,
          description,
          client_id,
          redirect_uris,
          scopes,
          audiences,
          allowed_profiles,
          access_mode,
          registration_kind,
          is_public
        )
        VALUES (
          'Cloud CLI',
          'First-party public OAuth client for the cloud CLI.',
          'cloud-cli',
          ARRAY['http://127.0.0.1/callback', 'http://[::1]/callback'],
          ARRAY['openid', 'profile', 'email', 'offline_access', 'read', 'write'],
          ARRAY['cloud'],
          ARRAY['user', 'guest'],
          'profiles',
          'first_party',
          true
        );
      END IF;
    END $$
  `.simple();
  await sql`
    DELETE FROM oauth.client_access_users
    WHERE client_id = (SELECT id FROM oauth.clients WHERE client_id = 'cloud-cli')
  `.simple();
  await sql`
    DELETE FROM oauth.client_access_groups
    WHERE client_id = (SELECT id FROM oauth.clients WHERE client_id = 'cloud-cli')
  `.simple();
  console.log("  ✓ oauth first-party CLI client");

  // Coordinated hard cut: old replicas must be stopped before this migration.
  // Client registrations, authorization codes and refresh grants are retained.
  await sql`DROP TABLE IF EXISTS oauth.keys`.simple();
  await sql`DROP TABLE IF EXISTS oauth.issuance_state`.simple();
  console.log("  ✓ OAuth signing authority belongs exclusively to Core");
};
