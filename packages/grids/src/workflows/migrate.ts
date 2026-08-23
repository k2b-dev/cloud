import type { SQL } from "bun";

export const GRIDS_WORKFLOW_SCHEMA_VERSION = 8;

const resetAlphaWorkflowSchema = async (sql: SQL): Promise<boolean> => {
  await sql`
    CREATE TABLE IF NOT EXISTS grids.workflow_migrations (
      version INT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();

  const [migration] = await sql<Array<{ applied: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM grids.workflow_migrations WHERE version = ${GRIDS_WORKFLOW_SCHEMA_VERSION}
    ) AS applied
  `;
  if (migration?.applied) return false;

  /*
   * Workflows are local alpha data, so the schema is reset rather than migrated.
   *
   * grids.workflows is gone for good: identity, versions and activations belong
   * to the kernel now. What it leaves behind — access grants, run options — is
   * re-keyed onto grids.workflow_profile below. Documents and scan records are
   * real user data and survive; only their link back to a run is cleared.
   *
   * grids.workflow_runs and grids.workflow_step_runs follow: runs execute on
   * workflows.run, and a step's outcome — its effect included — is journaled on
   * workflows.step_outcome. grids.workflow_effect_intents went the same way.
   *
   * The ledger itself is dropped too. It was named after an engine Grids no
   * longer has, and carrying the old name forward would have meant explaining
  * it to every reader from here on.
  */
  await sql`
    UPDATE grids.documents SET workflow_run_id = NULL, workflow_step_key = NULL WHERE workflow_run_id IS NOT NULL;
    DROP TABLE IF EXISTS grids.workflow_effect_intents CASCADE;
    DROP TABLE IF EXISTS grids.workflow_email_deliveries CASCADE;
    DROP TABLE IF EXISTS grids.workflow_step_runs CASCADE;
    DROP TABLE IF EXISTS grids.workflow_runs CASCADE;
    DROP TABLE IF EXISTS grids.workflow_launchers CASCADE;
    DROP TABLE IF EXISTS grids.workflow_access CASCADE;
    DROP TABLE IF EXISTS grids.workflow_run_profile CASCADE;
    DROP TABLE IF EXISTS grids.workflow_profile CASCADE;
    DROP TABLE IF EXISTS grids.workflow_revisions CASCADE;
    DROP TABLE IF EXISTS grids.workflows CASCADE;
    DROP TABLE IF EXISTS grids.workflow_kernel_migrations CASCADE;
    DROP FUNCTION IF EXISTS grids.populate_workflow_run_snapshots();
    DROP FUNCTION IF EXISTS grids.bump_workflow_revision();
  `.simple();
  return true;
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
    ALTER TABLE grids.workflow_run_profile DROP CONSTRAINT IF EXISTS workflow_run_profile_launcher_kind_check;
    ALTER TABLE grids.workflow_run_profile DROP CONSTRAINT IF EXISTS workflow_run_profile_channel_check;
    UPDATE grids.workflow_run_profile SET launcher_kind = 'customApp' WHERE launcher_kind = 'dashboard';
    UPDATE grids.workflow_run_profile SET channel = 'customApp' WHERE channel = 'dashboard';
    ALTER TABLE grids.workflow_run_profile
      ADD CONSTRAINT workflow_run_profile_launcher_kind_check
      CHECK (launcher_kind IS NULL OR launcher_kind IN ('scanner', 'bulk', 'record', 'customApp'));
    ALTER TABLE grids.workflow_run_profile
      ADD CONSTRAINT workflow_run_profile_channel_check
      CHECK (channel IN ('api', 'customApp', 'scanner', 'bulk', 'record', 'schedule', 'recordEvent'));
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
    ALTER TABLE grids.workflow_launchers DROP CONSTRAINT IF EXISTS workflow_launchers_kind_check;
    UPDATE grids.workflow_launchers
    SET kind = 'customApp', config = jsonb_set(config, '{kind}', '"customApp"'::jsonb)
    WHERE kind = 'dashboard';
    ALTER TABLE grids.workflow_launchers
      ADD CONSTRAINT workflow_launchers_kind_check CHECK (kind IN ('scanner', 'bulk', 'record', 'customApp'));
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

export const migrateGridsWorkflowTables = async (sql: SQL): Promise<void> => {
  const didReset = await resetAlphaWorkflowSchema(sql);
  await migrateKernelProfile(sql);
  await migrateDefinitionLinks(sql);
  await migrateDeliveries(sql);
  if (didReset) {
    await sql`
      INSERT INTO grids.workflow_migrations (version)
      VALUES (${GRIDS_WORKFLOW_SCHEMA_VERSION})
      ON CONFLICT (version) DO NOTHING
    `;
  }
};
