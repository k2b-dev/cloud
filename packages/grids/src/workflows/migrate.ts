import type { SQL } from "bun";

export const GRIDS_WORKFLOW_SCHEMA_VERSION = 9;

/** Refuse incompatible alpha data; startup must never reset user state. */
export const assertGridsAlphaContract = async (sql: SQL): Promise<void> => {
  await sql`
    DO $$ DECLARE relation_name text; has_rows boolean; has_version boolean; BEGIN
      FOREACH relation_name IN ARRAY ARRAY['documents', 'document_issuances', 'workflow_query_data'] LOOP
        IF to_regclass('grids.' || relation_name) IS NULL THEN CONTINUE; END IF;
        EXECUTE format('LOCK TABLE grids.%I IN SHARE ROW EXCLUSIVE MODE', relation_name);
        SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('grids.' || relation_name)
          AND attname = 'hash_version' AND NOT attisdropped) INTO has_version;
        IF has_version THEN
          EXECUTE format('SELECT EXISTS (SELECT 1 FROM grids.%I WHERE hash_version IS DISTINCT FROM 2)', relation_name) INTO has_rows;
        ELSE
          EXECUTE format('SELECT EXISTS (SELECT 1 FROM grids.%I)', relation_name) INTO has_rows;
        END IF;
        IF has_rows THEN
          RAISE EXCEPTION 'Unsupported Grids alpha data in %. Preserve this installation on its previous version; see the Grids alpha upgrade guide. Startup does not convert hashes or delete data.', relation_name;
        END IF;
      END LOOP;
      IF to_regclass('grids.workflow_run_profile') IS NOT NULL THEN
        LOCK TABLE grids.workflow_run_profile IN SHARE ROW EXCLUSIVE MODE;
        SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'grids.workflow_run_profile'::regclass
          AND attname = 'captured_bytes' AND NOT attisdropped) INTO has_version;
        IF has_version THEN
          EXECUTE 'SELECT EXISTS (SELECT 1 FROM grids.workflow_run_profile WHERE captured_bytes IS NULL)' INTO has_rows;
        ELSE
          SELECT EXISTS (SELECT 1 FROM grids.workflow_run_profile) INTO has_rows;
        END IF;
        IF has_rows THEN
          RAISE EXCEPTION 'Unsupported Grids alpha capture budget in workflow_run_profile. Preserve this installation on its previous version; see the Grids alpha upgrade guide. Startup does not reconstruct capture budgets.';
        END IF;
      END IF;
      FOREACH relation_name IN ARRAY ARRAY['workflows', 'workflow_runs', 'workflow_effect_intents',
        'workflow_step_runs', 'workflow_revisions', 'workflow_kernel_migrations'] LOOP
        IF to_regclass('grids.' || relation_name) IS NOT NULL THEN
          RAISE EXCEPTION 'Unsupported Grids alpha workflow schema: %. Preserve this installation on its previous version; see the Grids alpha upgrade guide. Startup does not delete old workflow tables.', relation_name;
        END IF;
      END LOOP;
      IF to_regclass('grids.workflow_launchers') IS NOT NULL THEN
        LOCK TABLE grids.workflow_launchers IN SHARE ROW EXCLUSIVE MODE;
        IF EXISTS (SELECT 1 FROM grids.workflow_launchers WHERE kind NOT IN ('scanner', 'bulk', 'record', 'customApp')) THEN
          RAISE EXCEPTION 'Unsupported Grids alpha workflow launcher. Preserve this installation on its previous version; see the Grids alpha upgrade guide.';
        END IF;
      END IF;
      IF to_regclass('workflows.version') IS NOT NULL THEN
        LOCK TABLE workflows.version IN SHARE ROW EXCLUSIVE MODE;
        IF EXISTS (
          SELECT 1 FROM workflows.version version JOIN workflows.workflow workflow ON workflow.id = version.workflow_id
          WHERE workflow.app_id = 'grids'
          AND (version.id = workflow.active_version_id
            OR EXISTS (SELECT 1 FROM workflows.activation activation
              WHERE activation.workflow_version_id = version.id AND activation.enabled)
            OR EXISTS (SELECT 1 FROM workflows.run run WHERE run.workflow_version_id = version.id
              AND run.state NOT IN ('succeeded', 'failed', 'canceled')))
          AND (
            version.plan->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR
            jsonb_typeof(version.plan->'bindings') IS DISTINCT FROM 'object' OR
            EXISTS (
              SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(version.plan->'bindings') = 'object'
                THEN version.plan->'bindings' ELSE '{}'::jsonb END) binding
              WHERE binding.key LIKE '%.$query' AND (
                binding.value->'schemaHashVersion' IS DISTINCT FROM '3'::jsonb OR
                jsonb_typeof(binding.value->'source') IS DISTINCT FROM 'string' OR
                jsonb_typeof(binding.value->'schemaHash') IS DISTINCT FROM 'string'
              )
            )
          )
        ) THEN
          RAISE EXCEPTION 'Unsupported Grids alpha workflow binding. Preserve this installation on its previous version; see the Grids alpha upgrade guide. Startup does not rewrite published plans.';
        END IF;
      END IF;
    END $$;
  `.simple();
};

const initializeWorkflowSchema = async (sql: SQL): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS grids.workflow_migrations (
      version INT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
};

/**
 * The Grids half of a workflow, now that the kernel owns identity, versions,
 * activations, runs and the journal.
 *
 * What is left here is what the kernel has no opinion about: which base a
 * workflow belongs to, where it sits in the list, and who owns it.
 *
 * There is deliberately nowhere here for a draft. The editor saves on an
 * explicit action and keeps its working copy in a signal, like every other app
 * — so each save is simply a new immutable version, and an unsaved reload
 * losing its edits is the behaviour users already expect.
 *
 * Keyed by the kernel's workflow id with no foreign key to it. app-grids and
 * app-core start concurrently with no dependency declared between them, and
 * Grids' migration regularly wins on a cold database. Grids deletes the kernel
 * rows itself instead, which is why the kernel holds app_id and scope_id as
 * opaque strings rather than as references.
 */
const migrateKernelProfile = async (sql: SQL): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS grids.workflow_profile (
      -- The kernel's workflow id. Named id because the generic access resolver
      -- joins every resource table on resource.id.
      id UUID PRIMARY KEY,
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      short_id TEXT NOT NULL,
      position INT NOT NULL DEFAULT 0,
      owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      /*
       * Whether this workflow may run at all — Grids policy, not the kernel's.
       *
       * The kernel only knows enabled per activation, which cannot express a
       * workflow with no triggers: those are invoked directly, and disabling
       * one has to refuse the invocation too. Grids mirrors this onto its
       * activations so the kernel's dispatcher agrees about triggers.
       */
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      -- Suppresses replay of record events older than the activation.
      record_event_active_since TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT workflow_profile_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$')
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_profile_base_live
    ON grids.workflow_profile(base_id, position, created_at, id) WHERE deleted_at IS NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_profile_record_events
    ON grids.workflow_profile(base_id, record_event_active_since)
    WHERE deleted_at IS NULL AND enabled AND record_event_active_since IS NOT NULL
  `.simple();

  /*
   * Why a run happened, from Grids' point of view.
   *
   * The kernel records the cause as an event; this records what the run list
   * filters and labels by. A table rather than JSONB on the run, because those
   * are indexed predicates.
   */
  await sql`
    CREATE TABLE IF NOT EXISTS grids.workflow_run_profile (
      run_id UUID PRIMARY KEY,
      short_id TEXT NOT NULL,
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      workflow_id UUID NOT NULL,
      launcher_id UUID,
      launcher_kind TEXT CHECK (launcher_kind IS NULL OR launcher_kind IN ('scanner', 'bulk', 'record', 'customApp')),
      channel TEXT NOT NULL CHECK (channel IN ('api', 'customApp', 'scanner', 'bulk', 'record', 'schedule', 'recordEvent')),
      actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      service_account_id UUID REFERENCES auth.service_accounts(id) ON DELETE SET NULL,
      -- Detects "same idempotency key, different request". The kernel answers a
      -- repeat with the first run's id, so without this a changed payload would
      -- be silently ignored rather than refused.
      request_fingerprint TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT workflow_run_profile_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$')
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_run_profile_workflow
    ON grids.workflow_run_profile(workflow_id, created_at DESC, run_id DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_run_profile_base
    ON grids.workflow_run_profile(base_id, channel, created_at DESC, run_id DESC)
  `.simple();
};

/**
 * What still hangs off a workflow, now keyed by the kernel's id.
 *
 * Run options are Grids' own. Workflow authorization is inherited from the
 * owning base and therefore needs no workflow-specific access junction.
 */
const migrateDefinitionLinks = async (sql: SQL): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS grids.workflow_launchers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      workflow_id UUID NOT NULL REFERENCES grids.workflow_profile(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('scanner', 'bulk', 'record', 'customApp')),
      config JSONB NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      -- The revision this launcher's config was checked against. Publishing a
      -- plan that may take different inputs switches it off until someone looks.
      validated_revision INT NOT NULL CHECK (validated_revision >= 1),
      diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT workflow_launchers_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$'),
      CONSTRAINT workflow_launchers_diagnostics_array_chk CHECK (jsonb_typeof(diagnostics) = 'array')
    )
  `.simple();
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grids.workflow_launchers'::regclass
        AND conname = 'workflow_launchers_kind_check' AND pg_get_constraintdef(oid) LIKE '%dashboard%') THEN
        ALTER TABLE grids.workflow_launchers DROP CONSTRAINT workflow_launchers_kind_check;
        ALTER TABLE grids.workflow_launchers
          ADD CONSTRAINT workflow_launchers_kind_check CHECK (kind IN ('scanner', 'bulk', 'record', 'customApp'));
      END IF;
    END $$;
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_launchers_workflow
    ON grids.workflow_launchers(workflow_id, kind, created_at, id) WHERE deleted_at IS NULL
  `.simple();
};

const migrateDeliveries = async (sql: SQL): Promise<void> => {
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_documents_workflow_step
    ON grids.documents(workflow_run_id, workflow_step_key)
    WHERE workflow_run_id IS NOT NULL AND workflow_step_key IS NOT NULL
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.workflow_email_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      workflow_id UUID,
      /*
       * The kernel's run and step, held as plain values: a grids.* to
       * workflows.* foreign key would invert the dependency the kernel avoids
       * on purpose, which is why it keeps app_id and scope_id as opaque strings
       * rather than as references. grids.workflow_profile.id does the same.
       */
      workflow_run_id UUID,
      workflow_step_key TEXT NOT NULL,
      template_id UUID REFERENCES grids.email_templates(id) ON DELETE SET NULL,
      recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('email', 'user')),
      recipient_value TEXT,
      recipient_summary TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      notification_id UUID,
      provider_status TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
      subject TEXT,
      rendered_html TEXT,
      error TEXT,
      recipient_index INT NOT NULL CHECK (recipient_index > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (idempotency_key),
      UNIQUE (workflow_run_id, workflow_step_key, recipient_index)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_email_deliveries_base
    ON grids.workflow_email_deliveries(base_id, created_at DESC, id DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_email_deliveries_run
    ON grids.workflow_email_deliveries(workflow_run_id, created_at, id) WHERE workflow_run_id IS NOT NULL
  `.simple();
};

const migrateQueryData = async (sql: SQL): Promise<void> => {
  await sql`
    ALTER TABLE grids.workflow_run_profile ADD COLUMN IF NOT EXISTS captured_bytes BIGINT NOT NULL DEFAULT 0 CHECK (captured_bytes >= 0);
    ALTER TABLE grids.workflow_run_profile ALTER COLUMN captured_bytes SET NOT NULL;
    ALTER TABLE grids.workflow_run_profile ALTER COLUMN captured_bytes SET DEFAULT 0;
    CREATE TABLE IF NOT EXISTS grids.workflow_query_data (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES grids.workflow_run_profile(run_id) ON DELETE CASCADE,
      step_key TEXT NOT NULL CHECK (length(step_key) > 0),
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      row_count INT NOT NULL CHECK (row_count BETWEEN 0 AND 10000),
      captured_at TIMESTAMPTZ NOT NULL,
      UNIQUE (run_id, step_key)
    );
    ALTER TABLE grids.workflow_query_data ADD COLUMN IF NOT EXISTS hash_version SMALLINT NOT NULL DEFAULT 2 CHECK (hash_version = 2);
    ALTER TABLE grids.workflow_query_data ALTER COLUMN hash_version SET DEFAULT 2;
    DO $$ DECLARE relation_name text; constraint_name text; BEGIN
      FOREACH relation_name IN ARRAY ARRAY['documents', 'document_issuances', 'workflow_query_data'] LOOP
        constraint_name := relation_name || '_hash_version_check';
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass('grids.' || relation_name) AND conname = constraint_name
            AND pg_get_constraintdef(oid) = 'CHECK ((hash_version = 2))' AND convalidated) THEN
          EXECUTE format('ALTER TABLE grids.%I DROP CONSTRAINT IF EXISTS %I', relation_name, constraint_name);
          EXECUTE format('ALTER TABLE grids.%I ADD CONSTRAINT %I CHECK (hash_version = 2)', relation_name, constraint_name);
        END IF;
      END LOOP;
    END $$;
    CREATE OR REPLACE FUNCTION grids.reject_workflow_query_data_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'captured workflow query data is immutable' USING ERRCODE = '55000';
    END
    $$;
    DROP TRIGGER IF EXISTS workflow_query_data_immutable ON grids.workflow_query_data;
    CREATE TRIGGER workflow_query_data_immutable
      BEFORE UPDATE ON grids.workflow_query_data
      FOR EACH ROW EXECUTE FUNCTION grids.reject_workflow_query_data_update();
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_query_data_run_identity ON grids.workflow_query_data(id, run_id);
    ALTER TABLE grids.documents ADD COLUMN IF NOT EXISTS query_data_id UUID;
    ALTER TABLE grids.documents ADD COLUMN IF NOT EXISTS associated_query_data_id UUID;
    ALTER TABLE grids.document_issuances ADD COLUMN IF NOT EXISTS query_data_id UUID REFERENCES grids.workflow_query_data(id) ON DELETE RESTRICT;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grids.documents'::regclass AND conname = 'documents_associated_query_binding_fkey') THEN
        ALTER TABLE grids.documents ADD CONSTRAINT documents_associated_query_binding_fkey
          FOREIGN KEY (associated_query_data_id, workflow_run_id) REFERENCES grids.workflow_query_data(id, run_id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grids.documents'::regclass AND conname = 'documents_associated_query_source_chk') THEN
        ALTER TABLE grids.documents ADD CONSTRAINT documents_associated_query_source_chk
          CHECK (associated_query_data_id IS NULL OR (query_data_id IS NOT NULL AND workflow_run_id IS NOT NULL));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grids.documents'::regclass AND conname = 'documents_query_data_binding_fkey') THEN
        ALTER TABLE grids.documents ADD CONSTRAINT documents_query_data_binding_fkey
          FOREIGN KEY (query_data_id, workflow_run_id) REFERENCES grids.workflow_query_data(id, run_id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grids.documents'::regclass AND conname = 'documents_query_source_chk') THEN
        ALTER TABLE grids.documents ADD CONSTRAINT documents_query_source_chk
          CHECK (query_data_id IS NULL OR (template_id IS NULL AND workflow_run_id IS NOT NULL));
      END IF;
    END $$;
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.guard_document_export_claim()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      -- Claims commit with the issued document, never with its preview.
      RAISE EXCEPTION 'Financial export claims are immutable' USING ERRCODE = '55000';
    END $$;
    DROP TRIGGER IF EXISTS document_export_claim_guard ON grids.document_export_claims;
    CREATE TRIGGER document_export_claim_guard BEFORE UPDATE OR DELETE ON grids.document_export_claims
      FOR EACH ROW EXECUTE FUNCTION grids.guard_document_export_claim();
  `.simple();
};

export const migrateGridsWorkflowTables = async (sql: SQL): Promise<void> => {
  await initializeWorkflowSchema(sql);
  await migrateKernelProfile(sql);
  await migrateDefinitionLinks(sql);
  await migrateDeliveries(sql);
  await migrateQueryData(sql);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_workflow_run_profile_base_identity
      ON grids.workflow_run_profile(run_id, base_id);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'grids.documents'::regclass AND conname = 'documents_workflow_base_fkey') THEN
        ALTER TABLE grids.documents ADD CONSTRAINT documents_workflow_base_fkey
          FOREIGN KEY (workflow_run_id, base_id) REFERENCES grids.workflow_run_profile(run_id, base_id)
          ON DELETE RESTRICT;
      END IF;
    END $$;
    ALTER TABLE grids.documents VALIDATE CONSTRAINT documents_workflow_base_fkey;
  `.simple();
  await sql`
      INSERT INTO grids.workflow_migrations (version)
      VALUES (${GRIDS_WORKFLOW_SCHEMA_VERSION})
      ON CONFLICT (version) DO NOTHING
    `;
};
