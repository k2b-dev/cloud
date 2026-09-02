import { sql } from "bun";

export const migrate = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS auth`.simple();
  console.log("  ✓ auth schema");

  await sql`
    CREATE TABLE IF NOT EXISTS auth.users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      uid TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      profile TEXT NOT NULL,
      given_name TEXT NOT NULL DEFAULT '',
      sn TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      mail TEXT,
      avatar_data_url TEXT,
      avatar_hash TEXT,
      account_expires TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_local TIMESTAMPTZ,
      admin BOOLEAN NOT NULL DEFAULT false,
      CONSTRAINT users_provider_check CHECK (provider IN ('local', 'ipa')),
      CONSTRAINT users_profile_check CHECK (profile IN ('user', 'guest')),
      CONSTRAINT users_admin_check CHECK (admin = false OR (provider = 'local' AND profile = 'user')),
      CONSTRAINT users_avatar_data_url_check CHECK (
        avatar_data_url IS NULL OR (
          length(avatar_data_url) <= 65536
          AND avatar_data_url ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'
        )
      ),
      CONSTRAINT users_avatar_hash_check CHECK (
        (avatar_data_url IS NULL AND avatar_hash IS NULL)
        OR (
          avatar_data_url IS NOT NULL
          AND avatar_hash IS NOT NULL
          AND avatar_hash ~ '^[a-f0-9]{64}$'
        )
      )
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider_mail
    ON auth.users(provider, mail) WHERE mail IS NOT NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_users_provider_profile
    ON auth.users(provider, profile)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_users_account_expires
    ON auth.users(account_expires)
    WHERE account_expires IS NOT NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_users_mail
    ON auth.users(mail)
    WHERE mail IS NOT NULL
  `.simple();
  await sql`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS auth_epoch BIGINT NOT NULL DEFAULT 0`.simple();
  await sql`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS legacy_session_generation BIGINT NOT NULL DEFAULT 0`.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_auth_epoch_nonnegative_check'
          AND conrelid = 'auth.users'::regclass
      ) THEN
        ALTER TABLE auth.users
          ADD CONSTRAINT users_auth_epoch_nonnegative_check
          CHECK (auth_epoch >= 0) NOT VALID;
      END IF;
    END $$;
  `.simple();
  await sql`ALTER TABLE auth.users VALIDATE CONSTRAINT users_auth_epoch_nonnegative_check`.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_legacy_session_generation_nonnegative_check'
          AND conrelid = 'auth.users'::regclass
      ) THEN
        ALTER TABLE auth.users
          ADD CONSTRAINT users_legacy_session_generation_nonnegative_check
          CHECK (legacy_session_generation >= 0) NOT VALID;
      END IF;
    END $$;
  `.simple();
  await sql`ALTER TABLE auth.users VALIDATE CONSTRAINT users_legacy_session_generation_nonnegative_check`.simple();
  console.log("  ✓ auth.users table");

  await sql`
    CREATE TABLE IF NOT EXISTS auth.signing_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      purpose TEXT NOT NULL,
      state TEXT NOT NULL,
      kid TEXT NOT NULL UNIQUE,
      alg TEXT NOT NULL DEFAULT 'RS256',
      public_jwk JSONB NOT NULL,
      encrypted_private_jwk TEXT NOT NULL,
      encryption_key_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      activate_at TIMESTAMPTZ NOT NULL,
      activated_at TIMESTAMPTZ,
      sign_until TIMESTAMPTZ NOT NULL,
      retired_at TIMESTAMPTZ,
      verify_until TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoke_reason TEXT,
      CONSTRAINT signing_keys_purpose_check CHECK (purpose IN ('session', 'invocation', 'oauth')),
      CONSTRAINT signing_keys_state_check CHECK (state IN ('pending', 'active', 'retired', 'revoked')),
      CONSTRAINT signing_keys_alg_check CHECK (alg = 'RS256'),
      CONSTRAINT signing_keys_kid_check CHECK (kid ~ '^[0-9a-f-]{36}$'),
      CONSTRAINT signing_keys_public_jwk_size_check CHECK (octet_length(public_jwk::text) <= 16384),
      CONSTRAINT signing_keys_private_jwk_size_check CHECK (octet_length(encrypted_private_jwk) <= 32768),
      CONSTRAINT signing_keys_lifecycle_check CHECK (
        sign_until >= activate_at
        AND verify_until >= sign_until
        AND (state <> 'active' OR activated_at IS NOT NULL)
        AND (state <> 'retired' OR retired_at IS NOT NULL)
        AND (state <> 'revoked' OR revoked_at IS NOT NULL)
      )
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_signing_keys_one_pending_per_purpose
    ON auth.signing_keys(purpose)
    WHERE state = 'pending'
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_signing_keys_one_active_per_purpose
    ON auth.signing_keys(purpose)
    WHERE state = 'active'
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_signing_keys_publishable
    ON auth.signing_keys(purpose, state, verify_until)
  `.simple();
  console.log("  ✓ auth.signing_keys table");

  await sql`
    CREATE TABLE IF NOT EXISTS auth.session_families (
      sid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      auth_epoch BIGINT NOT NULL,
      signing_kid TEXT NOT NULL REFERENCES auth.signing_keys(kid) ON DELETE RESTRICT,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revocation_reason TEXT,
      created_request_id TEXT,
      created_user_agent TEXT,
      revoked_request_id TEXT,
      CONSTRAINT session_families_auth_epoch_nonnegative_check CHECK (auth_epoch >= 0),
      CONSTRAINT session_families_expiry_check CHECK (expires_at > issued_at),
      CONSTRAINT session_families_revocation_check CHECK (
        (revoked_at IS NULL AND revocation_reason IS NULL)
        OR revoked_at IS NOT NULL
      ),
      CONSTRAINT session_families_request_id_size_check CHECK (
        (created_request_id IS NULL OR octet_length(created_request_id) <= 256)
        AND (revoked_request_id IS NULL OR octet_length(revoked_request_id) <= 256)
      ),
      CONSTRAINT session_families_user_agent_size_check CHECK (
        created_user_agent IS NULL OR octet_length(created_user_agent) <= 1024
      )
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_session_families_active_sid_user_expiry
    ON auth.session_families(sid, user_id, expires_at)
    WHERE revoked_at IS NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_session_families_user_active
    ON auth.session_families(user_id, expires_at DESC)
    WHERE revoked_at IS NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_session_families_signing_kid_expiry
    ON auth.session_families(signing_kid, expires_at DESC)
  `.simple();
  console.log("  ✓ auth.session_families table");

  await sql`
    CREATE TABLE IF NOT EXISTS auth.user_ipa_data (
      user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      uid_number INTEGER,
      phone TEXT,
      employee_type TEXT,
      mobile TEXT,
      addr_street TEXT,
      addr_postal_code TEXT,
      addr_city TEXT,
      addr_state TEXT,
      ipa_password_expires TIMESTAMPTZ,
      last_login_ipa TIMESTAMPTZ,
      synced_at TIMESTAMPTZ,
      ssh_public_keys TEXT[] NOT NULL DEFAULT '{}',
      ssh_fingerprints TEXT[] NOT NULL DEFAULT '{}'
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_user_ipa_data_uid_number
    ON auth.user_ipa_data(uid_number)
    WHERE uid_number IS NOT NULL
  `.simple();
  console.log("  ✓ auth.user_ipa_data table");

  await sql`
    CREATE TABLE IF NOT EXISTS auth.groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cn TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL DEFAULT 'ipa',
      name TEXT NOT NULL,
      description TEXT,
      gid_number INTEGER,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT groups_provider_check CHECK (provider IN ('local', 'ipa')),
      CONSTRAINT groups_provider_name_unique UNIQUE (provider, name)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_groups_provider
    ON auth.groups(provider)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_groups_name
    ON auth.groups(name)
  `.simple();
  console.log("  ✓ auth.groups table");

  await sql`
    CREATE TABLE IF NOT EXISTS auth.user_groups_v2 (
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      group_id UUID NOT NULL REFERENCES auth.groups(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, group_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_user_groups_v2_group
    ON auth.user_groups_v2(group_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_user_groups_v2_user
    ON auth.user_groups_v2(user_id)
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS auth.group_groups_v2 (
      parent_group_id UUID NOT NULL REFERENCES auth.groups(id) ON DELETE CASCADE,
      child_group_id UUID NOT NULL REFERENCES auth.groups(id) ON DELETE CASCADE,
      PRIMARY KEY (parent_group_id, child_group_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_group_groups_v2_child
    ON auth.group_groups_v2(child_group_id)
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS auth.group_manager_users_v2 (
      group_id UUID NOT NULL REFERENCES auth.groups(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      PRIMARY KEY (group_id, user_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_group_manager_users_v2_user
    ON auth.group_manager_users_v2(user_id)
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS auth.group_manager_groups_v2 (
      group_id UUID NOT NULL REFERENCES auth.groups(id) ON DELETE CASCADE,
      manager_group_id UUID NOT NULL REFERENCES auth.groups(id) ON DELETE CASCADE,
      PRIMARY KEY (group_id, manager_group_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_group_manager_groups_v2_manager
    ON auth.group_manager_groups_v2(manager_group_id)
  `.simple();
  console.log("  ✓ auth.user/group junction tables");

  await sql`
    CREATE TABLE IF NOT EXISTS auth.ipa_user_effective_groups (
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      group_name TEXT NOT NULL,
      PRIMARY KEY (user_id, group_name)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ipa_user_effective_groups_group
    ON auth.ipa_user_effective_groups(group_name)
  `.simple();
  await sql`
    INSERT INTO auth.ipa_user_effective_groups (user_id, group_name)
    WITH RECURSIVE all_groups AS (
      SELECT ug.user_id, ug.group_id
      FROM auth.user_groups_v2 ug
      JOIN auth.groups g ON g.id = ug.group_id
      JOIN auth.users u ON u.id = ug.user_id
      WHERE g.provider = 'ipa'
        AND u.provider = 'ipa'
      UNION
      SELECT ag.user_id, gg.parent_group_id
      FROM auth.group_groups_v2 gg
      JOIN auth.groups g_parent ON g_parent.id = gg.parent_group_id
      JOIN all_groups ag ON gg.child_group_id = ag.group_id
      WHERE g_parent.provider = 'ipa'
    )
    SELECT DISTINCT ag.user_id, g.name
    FROM all_groups ag
    JOIN auth.groups g ON g.id = ag.group_id
    ON CONFLICT DO NOTHING
  `.simple();
  console.log("  ✓ auth.ipa_user_effective_groups table");

  await sql`
    CREATE OR REPLACE FUNCTION auth.enforce_provider_safe_group_relations()
    RETURNS trigger AS $$
    DECLARE
      target_group_provider TEXT;
      related_user_provider TEXT;
      related_group_provider TEXT;
    BEGIN
      IF TG_TABLE_NAME = 'user_groups_v2' THEN
        SELECT provider INTO target_group_provider FROM auth.groups WHERE id = NEW.group_id;
        IF target_group_provider = 'ipa' THEN
          SELECT provider INTO related_user_provider FROM auth.users WHERE id = NEW.user_id;
          IF related_user_provider IS DISTINCT FROM 'ipa' THEN
            RAISE EXCEPTION 'IPA groups may only contain IPA users';
          END IF;
        END IF;
        RETURN NEW;
      END IF;

      IF TG_TABLE_NAME = 'group_groups_v2' THEN
        SELECT provider INTO target_group_provider FROM auth.groups WHERE id = NEW.parent_group_id;
        SELECT provider INTO related_group_provider FROM auth.groups WHERE id = NEW.child_group_id;
        IF target_group_provider IS DISTINCT FROM related_group_provider THEN
          RAISE EXCEPTION 'Group nesting must stay within the same provider tree';
        END IF;
        RETURN NEW;
      END IF;

      IF TG_TABLE_NAME = 'group_manager_users_v2' THEN
        SELECT provider INTO target_group_provider FROM auth.groups WHERE id = NEW.group_id;
        IF target_group_provider = 'ipa' THEN
          SELECT provider INTO related_user_provider FROM auth.users WHERE id = NEW.user_id;
          IF related_user_provider IS DISTINCT FROM 'ipa' THEN
            RAISE EXCEPTION 'IPA groups may only be managed by IPA users';
          END IF;
        END IF;
        RETURN NEW;
      END IF;

      IF TG_TABLE_NAME = 'group_manager_groups_v2' THEN
        SELECT provider INTO target_group_provider FROM auth.groups WHERE id = NEW.group_id;
        SELECT provider INTO related_group_provider FROM auth.groups WHERE id = NEW.manager_group_id;
        IF target_group_provider IS DISTINCT FROM related_group_provider THEN
          RAISE EXCEPTION 'Group manager relations must stay within the same provider tree';
        END IF;
        RETURN NEW;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_user_groups_v2_provider_guard'
          AND tgrelid = 'auth.user_groups_v2'::regclass
      ) THEN
        CREATE TRIGGER trg_user_groups_v2_provider_guard
        BEFORE INSERT OR UPDATE ON auth.user_groups_v2
        FOR EACH ROW
        EXECUTE FUNCTION auth.enforce_provider_safe_group_relations();
      END IF;
    END $$;
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_group_groups_v2_provider_guard'
          AND tgrelid = 'auth.group_groups_v2'::regclass
      ) THEN
        CREATE TRIGGER trg_group_groups_v2_provider_guard
        BEFORE INSERT OR UPDATE ON auth.group_groups_v2
        FOR EACH ROW
        EXECUTE FUNCTION auth.enforce_provider_safe_group_relations();
      END IF;
    END $$;
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_group_manager_users_v2_provider_guard'
          AND tgrelid = 'auth.group_manager_users_v2'::regclass
      ) THEN
        CREATE TRIGGER trg_group_manager_users_v2_provider_guard
        BEFORE INSERT OR UPDATE ON auth.group_manager_users_v2
        FOR EACH ROW
        EXECUTE FUNCTION auth.enforce_provider_safe_group_relations();
      END IF;
    END $$;
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'trg_group_manager_groups_v2_provider_guard'
          AND tgrelid = 'auth.group_manager_groups_v2'::regclass
      ) THEN
        CREATE TRIGGER trg_group_manager_groups_v2_provider_guard
        BEFORE INSERT OR UPDATE ON auth.group_manager_groups_v2
        FOR EACH ROW
        EXECUTE FUNCTION auth.enforce_provider_safe_group_relations();
      END IF;
    END $$;
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS auth.account_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      phone TEXT,
      comment TEXT,
      accepted_agb BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'pending',
      denied_reason TEXT,
      processed_at TIMESTAMPTZ,
      processed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT account_requests_status_check CHECK (status IN ('pending', 'completed', 'denied'))
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_account_requests_user
    ON auth.account_requests(user_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_account_requests_status
    ON auth.account_requests(status)
  `.simple();
  console.log("  ✓ auth.account_requests table");

  await sql`
    CREATE TABLE IF NOT EXISTS auth.service_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      delegated_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      app_id TEXT,
      resource_type TEXT,
      resource_id TEXT,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT service_accounts_kind_check CHECK (kind IN ('user_delegated', 'resource_bound')),
      CONSTRAINT service_accounts_status_check CHECK (status IN ('active', 'disabled')),
      CONSTRAINT service_accounts_binding_check CHECK (
        (
          kind = 'user_delegated'
          AND delegated_user_id IS NOT NULL
          AND app_id IS NULL
          AND resource_type IS NULL
          AND resource_id IS NULL
        ) OR (
          kind = 'resource_bound'
          AND delegated_user_id IS NULL
          AND app_id IS NOT NULL
          AND resource_type IS NOT NULL
          AND resource_id IS NOT NULL
        )
      )
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_service_accounts_delegated_user
    ON auth.service_accounts(delegated_user_id)
    WHERE delegated_user_id IS NOT NULL
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_service_accounts_user_delegated
    ON auth.service_accounts(delegated_user_id)
    WHERE kind = 'user_delegated'
      AND delegated_user_id IS NOT NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_service_accounts_resource
    ON auth.service_accounts(app_id, resource_type, resource_id)
    WHERE app_id IS NOT NULL AND resource_type IS NOT NULL AND resource_id IS NOT NULL
  `.simple();
  await sql`DROP INDEX IF EXISTS uniq_service_accounts_resource_bound`.simple();
  console.log("  ✓ auth.service_accounts table");

  await sql`
    CREATE TABLE IF NOT EXISTS auth.mandates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      subject_kind TEXT NOT NULL,
      subject_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      subject_service_account_id UUID REFERENCES auth.service_accounts(id) ON DELETE CASCADE,
      owner_app_id TEXT NOT NULL,
      workload_type TEXT NOT NULL,
      workload_id TEXT NOT NULL,
      policy JSONB NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      revision BIGINT NOT NULL DEFAULT 1,
      expires_at TIMESTAMPTZ,
      confirmed_at TIMESTAMPTZ DEFAULT now(),
      confirmation_deadline TIMESTAMPTZ,
      created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      revoked_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      revoked_by_app_id TEXT,
      revoke_reason TEXT,
      CONSTRAINT mandates_subject_kind_check CHECK (subject_kind IN ('user', 'service_account')),
      CONSTRAINT mandates_subject_shape_check CHECK (
        (subject_kind = 'user' AND subject_user_id IS NOT NULL AND subject_service_account_id IS NULL)
        OR
        (subject_kind = 'service_account' AND subject_user_id IS NULL AND subject_service_account_id IS NOT NULL)
      ),
      CONSTRAINT mandates_owner_app_id_check CHECK (
        char_length(owner_app_id) BETWEEN 1 AND 80
        AND owner_app_id ~ '^[a-z][a-z0-9-]*$'
      ),
      CONSTRAINT mandates_workload_type_check CHECK (
        char_length(workload_type) BETWEEN 1 AND 120
        AND workload_type ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'
      ),
      CONSTRAINT mandates_workload_id_check CHECK (char_length(workload_id) BETWEEN 1 AND 200),
      CONSTRAINT mandates_policy_size_check CHECK (octet_length(policy::text) <= 16384),
      CONSTRAINT mandates_policy_version_check CHECK (policy->>'version' = '1'),
      CONSTRAINT mandates_state_check CHECK (state IN ('active', 'paused', 'revoked')),
      CONSTRAINT mandates_revision_check CHECK (revision > 0),
      CONSTRAINT mandates_expiry_check CHECK (expires_at IS NULL OR expires_at > created_at),
      CONSTRAINT mandates_confirmation_check CHECK (
        (confirmed_at IS NOT NULL AND confirmation_deadline IS NULL)
        OR
        (confirmed_at IS NULL AND confirmation_deadline IS NOT NULL AND confirmation_deadline > created_at)
      ),
      CONSTRAINT mandates_revocation_check CHECK (
        (state = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
        OR
        (state <> 'revoked' AND revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoked_by_app_id IS NULL AND revoke_reason IS NULL)
      ),
      CONSTRAINT mandates_revoked_by_app_id_check CHECK (
        revoked_by_app_id IS NULL OR (
          char_length(revoked_by_app_id) BETWEEN 1 AND 80
          AND revoked_by_app_id ~ '^[a-z][a-z0-9-]*$'
        )
      ),
      CONSTRAINT mandates_revoke_reason_check CHECK (revoke_reason IS NULL OR char_length(revoke_reason) BETWEEN 1 AND 500)
    )
  `.simple();
  await sql`ALTER TABLE auth.mandates ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ DEFAULT now()`.simple();
  await sql`ALTER TABLE auth.mandates ADD COLUMN IF NOT EXISTS confirmation_deadline TIMESTAMPTZ`.simple();
  await sql`
    UPDATE auth.mandates
    SET confirmed_at = COALESCE(confirmed_at, created_at)
    WHERE confirmed_at IS NULL AND confirmation_deadline IS NULL
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'auth.mandates'::regclass
          AND conname = 'mandates_confirmation_check'
      ) THEN
        ALTER TABLE auth.mandates
        ADD CONSTRAINT mandates_confirmation_check CHECK (
          (confirmed_at IS NOT NULL AND confirmation_deadline IS NULL)
          OR
          (confirmed_at IS NULL AND confirmation_deadline IS NOT NULL AND confirmation_deadline > created_at)
        );
      END IF;
    END
    $$
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_mandates_live_owner_workload
    ON auth.mandates(owner_app_id, workload_type, workload_id)
    WHERE state IN ('active', 'paused')
  `.simple();
  await sql`DROP INDEX IF EXISTS auth.uq_mandates_owner_workload`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_mandates_subject_user
    ON auth.mandates(subject_user_id)
    WHERE subject_user_id IS NOT NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_mandates_subject_service_account
    ON auth.mandates(subject_service_account_id)
    WHERE subject_service_account_id IS NOT NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_mandates_active_expiry
    ON auth.mandates(expires_at)
    WHERE state = 'active' AND expires_at IS NOT NULL
  `.simple();
  await sql`DROP INDEX IF EXISTS auth.idx_mandates_unconfirmed_deadline`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_mandates_unconfirmed_deadline
    ON auth.mandates(confirmation_deadline)
    WHERE state IN ('active', 'paused') AND confirmed_at IS NULL
  `.simple();
  console.log("  ✓ auth.mandates table");

  await sql`
    CREATE TABLE IF NOT EXISTS auth.service_account_credentials (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      service_account_id UUID NOT NULL REFERENCES auth.service_accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'api_token',
      status TEXT NOT NULL DEFAULT 'active',
      token_prefix TEXT NOT NULL UNIQUE,
      secret_hash TEXT NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{}',
      expires_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT service_account_credentials_kind_check CHECK (kind IN ('api_token')),
      CONSTRAINT service_account_credentials_status_check CHECK (status IN ('active', 'revoked')),
      CONSTRAINT service_account_credentials_revoked_check CHECK (
        (status = 'revoked' AND revoked_at IS NOT NULL)
        OR (status = 'active' AND revoked_at IS NULL)
      )
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_service_account_credentials_service_account
    ON auth.service_account_credentials(service_account_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_service_account_credentials_active_prefix
    ON auth.service_account_credentials(token_prefix)
    WHERE status = 'active'
  `.simple();
  console.log("  ✓ auth.service_account_credentials table");

  await sql`
    CREATE TABLE IF NOT EXISTS auth.webauthn_credentials (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key BYTEA NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports TEXT[] NOT NULL DEFAULT '{}',
      device_type TEXT,
      backed_up BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user
    ON auth.webauthn_credentials(user_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_created_at
    ON auth.webauthn_credentials(created_at DESC)
  `.simple();
  console.log("  ✓ auth.webauthn_credentials table");

  await sql`
    DO $$ BEGIN
      CREATE TYPE auth.permission_level AS ENUM ('none', 'read', 'write', 'admin');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$
  `.simple();
  console.log("  ✓ auth.permission_level enum");

  await sql`
    CREATE TABLE IF NOT EXISTS auth.access (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      group_id UUID REFERENCES auth.groups(id) ON DELETE CASCADE,
      service_account_id UUID REFERENCES auth.service_accounts(id) ON DELETE CASCADE,
      authenticated_only BOOLEAN NOT NULL DEFAULT false,
      permission auth.permission_level NOT NULL DEFAULT 'read',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT principal_check CHECK (
        (user_id IS NOT NULL AND group_id IS NULL AND service_account_id IS NULL AND authenticated_only = false) OR
        (user_id IS NULL AND group_id IS NOT NULL AND service_account_id IS NULL AND authenticated_only = false) OR
        (user_id IS NULL AND group_id IS NULL AND service_account_id IS NOT NULL AND authenticated_only = false) OR
        (user_id IS NULL AND group_id IS NULL AND service_account_id IS NULL AND authenticated_only = true) OR
        (user_id IS NULL AND group_id IS NULL AND service_account_id IS NULL AND authenticated_only = false)
      )
    )
  `.simple();
  await sql`
    ALTER TABLE auth.access
    ADD COLUMN IF NOT EXISTS service_account_id UUID REFERENCES auth.service_accounts(id) ON DELETE CASCADE
  `.simple();
  await sql`
    ALTER TABLE auth.access
    DROP CONSTRAINT IF EXISTS principal_check
  `.simple();
  await sql`
    ALTER TABLE auth.access
    ADD CONSTRAINT principal_check CHECK (
      (user_id IS NOT NULL AND group_id IS NULL AND service_account_id IS NULL AND authenticated_only = false) OR
      (user_id IS NULL AND group_id IS NOT NULL AND service_account_id IS NULL AND authenticated_only = false) OR
      (user_id IS NULL AND group_id IS NULL AND service_account_id IS NOT NULL AND authenticated_only = false) OR
      (user_id IS NULL AND group_id IS NULL AND service_account_id IS NULL AND authenticated_only = true) OR
      (user_id IS NULL AND group_id IS NULL AND service_account_id IS NULL AND authenticated_only = false)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_access_user
    ON auth.access(user_id) WHERE user_id IS NOT NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_access_group
    ON auth.access(group_id) WHERE group_id IS NOT NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_access_service_account
    ON auth.access(service_account_id) WHERE service_account_id IS NOT NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_access_public
    ON auth.access(id) WHERE user_id IS NULL AND group_id IS NULL AND service_account_id IS NULL AND authenticated_only = false
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_access_authenticated
    ON auth.access(id) WHERE user_id IS NULL AND group_id IS NULL AND service_account_id IS NULL AND authenticated_only = true
  `.simple();
  console.log("  ✓ auth.access table");

  await sql`
    CREATE TABLE IF NOT EXISTS auth.deleted_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      deleted_user_id UUID NOT NULL,
      uid TEXT NOT NULL,
      mail TEXT,
      display_name TEXT,
      previous_provider TEXT,
      previous_profile TEXT,
      reason TEXT NOT NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT deleted_accounts_reason_check CHECK (reason IN (
        'ipa_expired_demoted', 'ipa_expired_deleted',
        'sync_out_of_scope_demoted', 'sync_out_of_scope_deleted',
        'guest_expired_deleted', 'local_user_expired_deleted',
        'manual_delete', 'manual_demote'
      ))
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_deleted_accounts_deleted_at
    ON auth.deleted_accounts(deleted_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_deleted_accounts_reason
    ON auth.deleted_accounts(reason)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_deleted_accounts_uid
    ON auth.deleted_accounts(uid)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_deleted_accounts_deleted_user_id
    ON auth.deleted_accounts(deleted_user_id)
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS auth.account_lifecycle_reminders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      threshold_days INTEGER NOT NULL,
      target_expiry_at TIMESTAMPTZ NOT NULL,
      uid TEXT,
      mail TEXT,
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_account_lifecycle_reminders_target
    ON auth.account_lifecycle_reminders(user_id, kind, threshold_days, target_expiry_at)
    WHERE user_id IS NOT NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_account_lifecycle_reminders_status
    ON auth.account_lifecycle_reminders(status)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_account_lifecycle_reminders_created_at
    ON auth.account_lifecycle_reminders(created_at DESC)
  `.simple();
  console.log("  ✓ auth.account_lifecycle_reminders table");

  // ──────────────────────────────────────────────────────────────────────────
  // Upgrade-safe ALTERs. The CREATE TABLE IF NOT EXISTS blocks above do not
  // evolve existing tables — every constraint/column/index added after initial
  // deploy must be applied idempotently here so fresh and upgraded DBs match.
  // ──────────────────────────────────────────────────────────────────────────

  // deleted_accounts.previous_provider / previous_profile were added after the
  // initial shape; older DBs must receive them before destructive paths insert.
  await sql`
    ALTER TABLE auth.deleted_accounts
    ADD COLUMN IF NOT EXISTS previous_provider TEXT,
    ADD COLUMN IF NOT EXISTS previous_profile TEXT
  `.simple();

  // Exactly one pending account request per user — previously enforced only at
  // service level, which races under concurrent submission.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_account_requests_one_pending_per_user
    ON auth.account_requests(user_id)
    WHERE status = 'pending'
  `.simple();

  await sql`
    ALTER TABLE auth.users
    ADD COLUMN IF NOT EXISTS avatar_data_url TEXT,
    ADD COLUMN IF NOT EXISTS avatar_hash TEXT
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_avatar_data_url_check'
          AND conrelid = 'auth.users'::regclass
      ) THEN
        ALTER TABLE auth.users
          ADD CONSTRAINT users_avatar_data_url_check
          CHECK (
            avatar_data_url IS NULL OR (
              length(avatar_data_url) <= 65536
              AND avatar_data_url ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'
            )
          ) NOT VALID;
      END IF;
    END $$;
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_avatar_hash_check'
          AND conrelid = 'auth.users'::regclass
      ) THEN
        ALTER TABLE auth.users
          ADD CONSTRAINT users_avatar_hash_check
          CHECK (
            (avatar_data_url IS NULL AND avatar_hash IS NULL)
            OR (
              avatar_data_url IS NOT NULL
              AND avatar_hash IS NOT NULL
              AND avatar_hash ~ '^[a-f0-9]{64}$'
            )
          ) NOT VALID;
      END IF;
    END $$;
  `.simple();
  await sql`
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE auth.users
          VALIDATE CONSTRAINT users_avatar_data_url_check;
      EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'Skipping VALIDATE for users_avatar_data_url_check: %', SQLERRM;
      END;
      BEGIN
        ALTER TABLE auth.users
          VALIDATE CONSTRAINT users_avatar_hash_check;
      EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'Skipping VALIDATE for users_avatar_hash_check: %', SQLERRM;
      END;
    END $$;
  `.simple();

  // account_lifecycle_reminders: the API expects a strict set of values. Add
  // CHECK constraints as NOT VALID then VALIDATE so upgrade doesn't fail on
  // pre-existing bad rows without operator awareness.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'account_lifecycle_reminders_kind_check'
          AND conrelid = 'auth.account_lifecycle_reminders'::regclass
      ) THEN
        ALTER TABLE auth.account_lifecycle_reminders
          ADD CONSTRAINT account_lifecycle_reminders_kind_check
          CHECK (kind IN ('account_expiry')) NOT VALID;
      END IF;
    END $$;
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'account_lifecycle_reminders_status_check'
          AND conrelid = 'auth.account_lifecycle_reminders'::regclass
      ) THEN
        ALTER TABLE auth.account_lifecycle_reminders
          ADD CONSTRAINT account_lifecycle_reminders_status_check
          CHECK (status IN ('pending', 'sent', 'error')) NOT VALID;
      END IF;
    END $$;
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'account_lifecycle_reminders_threshold_days_check'
          AND conrelid = 'auth.account_lifecycle_reminders'::regclass
      ) THEN
        ALTER TABLE auth.account_lifecycle_reminders
          ADD CONSTRAINT account_lifecycle_reminders_threshold_days_check
          CHECK (threshold_days > 0) NOT VALID;
      END IF;
    END $$;
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'account_lifecycle_reminders_attempt_count_check'
          AND conrelid = 'auth.account_lifecycle_reminders'::regclass
      ) THEN
        ALTER TABLE auth.account_lifecycle_reminders
          ADD CONSTRAINT account_lifecycle_reminders_attempt_count_check
          CHECK (attempt_count >= 0) NOT VALID;
      END IF;
    END $$;
  `.simple();
  // Validate best-effort. Swallow errors so an unexpectedly bad row doesn't
  // block startup; operator sees the failure in logs.
  await sql`
    DO $$
    BEGIN
      BEGIN
        ALTER TABLE auth.account_lifecycle_reminders
          VALIDATE CONSTRAINT account_lifecycle_reminders_kind_check;
      EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'Skipping VALIDATE for account_lifecycle_reminders_kind_check: % ', SQLERRM;
      END;
      BEGIN
        ALTER TABLE auth.account_lifecycle_reminders
          VALIDATE CONSTRAINT account_lifecycle_reminders_status_check;
      EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'Skipping VALIDATE for account_lifecycle_reminders_status_check: %', SQLERRM;
      END;
      BEGIN
        ALTER TABLE auth.account_lifecycle_reminders
          VALIDATE CONSTRAINT account_lifecycle_reminders_threshold_days_check;
      EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'Skipping VALIDATE for account_lifecycle_reminders_threshold_days_check: %', SQLERRM;
      END;
      BEGIN
        ALTER TABLE auth.account_lifecycle_reminders
          VALIDATE CONSTRAINT account_lifecycle_reminders_attempt_count_check;
      EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'Skipping VALIDATE for account_lifecycle_reminders_attempt_count_check: %', SQLERRM;
      END;
    END $$;
  `.simple();
  console.log("  ✓ auth upgrade-safe ALTERs applied");
};
