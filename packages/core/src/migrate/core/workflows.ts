/**
 * The workflow kernel's own storage.
 *
 * Grids and Mail each grew a full run engine — two run tables, two step
 * journals, two lease protocols, two state vocabularies that disagree about
 * what `waiting` means. Both are alpha, so there is one schema here and no
 * compatibility shim.
 *
 * The three rules the shape encodes:
 *   1. A plan is immutable; a run pins its version.
 *   2. A step is a function of its inputs and the prior outcomes.
 *   3. Outcomes are journaled; a recorded outcome is never recomputed.
 *
 * Execution is therefore "find the first step with no recorded outcome, run
 * it, record it". Crash recovery is that same loop, not a second code path.
 *
 * The kernel is app-agnostic: `app_id` and `scope_id` are opaque strings, not
 * foreign keys, because `workflows` cannot reference `grids.bases` or
 * `mail.mailboxes` without inverting the dependency. Apps drop their own
 * workflows when a scope goes away.
 */
import { type SQL, sql } from "bun";

/**
 * The state vocabularies below are inlined as literal SQL rather than shared
 * constants because `.simple()` admits no bind parameters. They are a
 * projection of the kernel's own `WorkflowRunState`, `WorkflowStepOutcome` and
 * `WorkflowPlanningOutcome` discriminants — a state only one app can enter is
 * a state the other app's UI renders wrong, so nothing is invented here.
 */
/**
 * `db` lets a test point this at an isolated connection. Production always uses
 * the ambient one, through `runCoreSetup`.
 */
export const migrate = async (db: SQL = sql): Promise<void> => {
  await db`CREATE SCHEMA IF NOT EXISTS workflows`.simple();
  console.log("  ✓ workflows schema");

  // ─── Definition ────────────────────────────────────────────────────────────

  await db`
    CREATE TABLE IF NOT EXISTS workflows.workflow (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      app_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      key TEXT NOT NULL,
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
      description TEXT CHECK (description IS NULL OR char_length(description) <= 2000),
      active_version_id UUID,
      created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('user', 'service_account', 'system')),
      created_by_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT workflow_created_by_chk CHECK (
        (created_by_kind = 'system' AND created_by_id IS NULL) OR (created_by_kind <> 'system' AND created_by_id IS NOT NULL)
      ),
      UNIQUE (app_id, scope_id, key),
      UNIQUE (id, app_id),
      CONSTRAINT workflow_scope_identity_uniq UNIQUE (id, app_id, scope_id)
    )
  `.simple();
  await db`
    CREATE INDEX IF NOT EXISTS idx_workflows_workflow_scope
    ON workflows.workflow(app_id, scope_id, name, id)
  `.simple();
  console.log("  ✓ workflows.workflow table");

  /**
   * A version is written once and never updated. Grids relied on convention
   * for this and Mail on a trigger; the trigger is the one that actually
   * holds, because a run pinned to a version has no way to notice that the
   * plan underneath it changed.
   */
  await db`
    CREATE TABLE IF NOT EXISTS workflows.version (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workflow_id UUID NOT NULL REFERENCES workflows.workflow(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      source TEXT NOT NULL CHECK (char_length(source) BETWEEN 1 AND 200000),
      source_hash TEXT NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
      plan JSONB NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
      diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(diagnostics) = 'array'),
      -- Caps on external effects, keyed by dimension. Grids had none: an email
      -- action inside a loop over ten thousand records was bounded only by the
      -- loop limit, which is a safety gap rather than a missing convenience.
      effect_budget JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(effect_budget) = 'object'),
      language_id TEXT NOT NULL CHECK (char_length(language_id) BETWEEN 1 AND 200),
      language_version INTEGER NOT NULL CHECK (language_version > 0),
      manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
      created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('user', 'service_account', 'system')),
      created_by_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workflow_id, revision),
      UNIQUE (id, workflow_id)
    )
  `.simple();
  await db`
    CREATE INDEX IF NOT EXISTS idx_workflows_version_history
    ON workflows.version(workflow_id, revision DESC)
  `.simple();

  await db`
    CREATE OR REPLACE FUNCTION workflows.reject_version_update() RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'workflow versions are immutable' USING ERRCODE = '55000';
    END;
    $$ LANGUAGE plpgsql
  `.simple();
  await db`DROP TRIGGER IF EXISTS version_reject_update ON workflows.version`.simple();
  await db`
    CREATE TRIGGER version_reject_update
    BEFORE UPDATE ON workflows.version
    FOR EACH ROW EXECUTE FUNCTION workflows.reject_version_update()
  `.simple();

  await db`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_active_version_fk') THEN
        ALTER TABLE workflows.workflow
          ADD CONSTRAINT workflow_active_version_fk
          FOREIGN KEY (active_version_id, id) REFERENCES workflows.version(id, workflow_id) ON DELETE SET NULL (active_version_id)
          DEFERRABLE INITIALLY DEFERRED;
      END IF;
    END $$
  `.simple();
  console.log("  ✓ workflows.version table");

  /**
   * Binds one version to one event type. Activations are what the dispatcher
   * reads, so pinning the version here — rather than following the workflow's
   * current pointer — is what stops an edit from redirecting work that is
   * already in flight.
   */
  await db`
    CREATE TABLE IF NOT EXISTS workflows.activation (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workflow_id UUID NOT NULL,
      workflow_version_id UUID NOT NULL,
      key TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 200),
      event_type TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 200),
      config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
      authorization_snapshot JSONB NOT NULL CHECK (jsonb_typeof(authorization_snapshot) = 'object'),
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (workflow_version_id, workflow_id) REFERENCES workflows.version(id, workflow_id) ON DELETE CASCADE,
      UNIQUE (workflow_id, key)
    )
  `.simple();
  await db`
    CREATE INDEX IF NOT EXISTS idx_workflows_activation_dispatch
    ON workflows.activation(event_type, workflow_id, id)
    WHERE enabled
  `.simple();
  console.log("  ✓ workflows.activation table");

  // ─── Cause ─────────────────────────────────────────────────────────────────

  /**
   * Everything that starts work is an event: a schedule tick, a button press,
   * an inbound message. A run therefore always has an inspectable cause rather
   * than a bare channel enum, and one event can start several runs.
   *
   * `dedupe_key` makes delivery at-most-once for the sources that can repeat
   * themselves — a schedule slot, a provider webhook.
   */
  await db`
    CREATE TABLE IF NOT EXISTS workflows.event (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      app_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (char_length(type) BETWEEN 1 AND 200),
      data JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
      dedupe_key TEXT CHECK (dedupe_key IS NULL OR char_length(dedupe_key) BETWEEN 1 AND 500),
      /*
       * Everything the plan reads under context.* — a captured row, the
       * launcher that was pressed. Distinct from data, which is the event's
       * own payload: an app may hand a run facts it already has rather than
       * make every step read them again.
       */
      context JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
      /*
       * Restricts matching to one workflow's activations.
       *
       * Some occurrences concern exactly one workflow and nobody else: an app
       * that evaluates its own trigger filter has already decided who should
       * run. A column rather than a call argument, because dispatch is deferred
       * and re-reads the row — an argument would evaporate and the event would
       * fan out to every activation in the scope.
       */
      target_workflow_id UUID,
      -- Who the resulting runs act as, frozen at emission. Named _snapshot to
      -- match activation and run, and because "authorization" is reserved.
      authorization_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(authorization_snapshot) = 'object'),
      occurred_at TIMESTAMPTZ NOT NULL,
      dispatched_at TIMESTAMPTZ,
      dispatch_after TIMESTAMPTZ NOT NULL DEFAULT now(),
      dispatch_failed_at TIMESTAMPTZ,
      matched_count INTEGER NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
      -- Dispatch can fail on its own — a version deleted mid-flight, a
      -- constraint the activation violates. Recording why keeps an event that
      -- matched nothing from disappearing silently, which is how Grids'
      -- schedules stopped firing with no error anywhere.
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await db`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_event_dedupe
    ON workflows.event(app_id, scope_id, type, dedupe_key)
    WHERE dedupe_key IS NOT NULL
  `.simple();
  await db`
    CREATE INDEX IF NOT EXISTS idx_workflows_event_pending
    ON workflows.event(dispatch_after, occurred_at, id)
    WHERE dispatched_at IS NULL AND dispatch_failed_at IS NULL AND matched_count > 0
  `.simple();
  await db`
    CREATE INDEX IF NOT EXISTS idx_workflows_event_history
    ON workflows.event(app_id, scope_id, occurred_at DESC, id DESC)
  `.simple();
  /**
   * The exact activation/version match is frozen when the event is recorded.
   * Deferred dispatch reads this receipt-time snapshot, so publishing a new
   * version cannot redirect an occurrence that already happened.
   *
   * workflow/version intentionally have no foreign key here. Deleting a
   * workflow must remain possible; a pending delivery then fails visibly
   * instead of either blocking deletion or silently vanishing.
   */
  await db`
    CREATE TABLE IF NOT EXISTS workflows.event_delivery (
      event_id UUID NOT NULL REFERENCES workflows.event(id) ON DELETE CASCADE,
      activation_id UUID NOT NULL,
      workflow_id UUID NOT NULL,
      workflow_version_id UUID NOT NULL,
      authorization_snapshot JSONB NOT NULL CHECK (jsonb_typeof(authorization_snapshot) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (event_id, activation_id)
    )
  `.simple();
  await db`
    CREATE INDEX IF NOT EXISTS idx_workflows_event_delivery_workflow
    ON workflows.event_delivery(workflow_id, event_id)
  `.simple();
  console.log("  ✓ workflows.event table");

  // ─── Execution ─────────────────────────────────────────────────────────────

  /**
   * Fan-out is child runs via `parent_run_id`, not a targets table. A 10,000
   * row bulk operation becomes 10,000 runs — the same row count Mail's
   * `workflow_run_targets` would have produced, but with one lease protocol,
   * one journal and one observability query instead of two of each.
   */
  await db`
    CREATE TABLE IF NOT EXISTS workflows.run (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      app_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      workflow_id UUID NOT NULL,
      workflow_version_id UUID NOT NULL,
      event_id UUID REFERENCES workflows.event(id) ON DELETE SET NULL,
      parent_run_id UUID REFERENCES workflows.run(id) ON DELETE CASCADE,
      parent_step_key TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('execute', 'dryRun')),
      state TEXT NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled', 'needs_attention')),
      inputs JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(inputs) = 'object'),
      /** Read by the plan as context.*; carried over from the event. */
      context JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
      -- What this run has actually spent, charged as it goes. Checking only
      -- before execution is what let Mail approve one set of effects and
      -- perform another; charging at the moment of the effect closes that.
      effects_used JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(effects_used) = 'object'),
      authorization_snapshot JSONB NOT NULL CHECK (jsonb_typeof(authorization_snapshot) = 'object'),
      idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
      occurred_at TIMESTAMPTZ NOT NULL,
      -- The fence. Every claim increments it, so a worker whose lease expired
      -- writes with a stale generation and is rejected. A lease token would be
      -- a second fence that can never disagree with this one.
      execution_generation BIGINT NOT NULL DEFAULT 0 CHECK (execution_generation >= 0),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      -- Set when a worker gives up a lease without recording an outcome, so a
      -- run that keeps dying cannot spin at full speed.
      retry_after TIMESTAMPTZ,
      -- When this run may next be picked up, as one orderable value: a queued
      -- run has never been leased, an expired lease is claimable again, and a
      -- released one waits out its backoff. Asking that as a disjunction over
      -- two nullable columns cannot be answered by one index scan, and
      -- degrades to a full scan of every unfinished run — measured, not
      -- assumed.
      claimable_at TIMESTAMPTZ NOT NULL GENERATED ALWAYS AS (
        GREATEST(COALESCE(lease_expires_at, '-infinity'::timestamptz), COALESCE(retry_after, '-infinity'::timestamptz))
      ) STORED,
      wake_at TIMESTAMPTZ,
      cancel_requested_at TIMESTAMPTZ,
      result JSONB,
      -- What the run said about itself, distinct from what it produced. A plan
      -- that ends with an explicit succeed or fail carries a sentence for a
      -- person; folding it into the result column would put it in the output
      -- that later steps and callers read as data.
      result_message TEXT,
      error JSONB CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Cascade, not RESTRICT: a workflow cascades to its versions, so
      -- restricting here made deleting any workflow that had ever run
      -- impossible. Deleting a workflow is a deliberate act that takes its
      -- history with it.
      FOREIGN KEY (workflow_version_id, workflow_id) REFERENCES workflows.version(id, workflow_id) ON DELETE CASCADE,
      CONSTRAINT run_parent_chk CHECK ((parent_run_id IS NULL) = (parent_step_key IS NULL)),
      CONSTRAINT run_lease_chk CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
      UNIQUE (workflow_id, mode, idempotency_key),
      CONSTRAINT run_scope_identity_uniq UNIQUE (id, app_id, scope_id),
      CONSTRAINT run_workflow_scope_fk FOREIGN KEY (workflow_id, app_id, scope_id)
        REFERENCES workflows.workflow(id, app_id, scope_id) ON DELETE CASCADE,
      CONSTRAINT run_parent_scope_fk FOREIGN KEY (parent_run_id, app_id, scope_id)
        REFERENCES workflows.run(id, app_id, scope_id) ON DELETE CASCADE
    )
  `.simple();
  // Claimable work, oldest first:
  //   WHERE state IN ('queued', 'running') AND claimable_at < now()
  //   ORDER BY claimable_at, created_at, id
  await db`
    CREATE INDEX IF NOT EXISTS idx_workflows_run_dispatch
    ON workflows.run(claimable_at, created_at, id)
    WHERE state IN ('queued', 'running')
  `.simple();
  // Parked runs the wake scan has to pick up once their deadline passes.
  await db`
    CREATE INDEX IF NOT EXISTS idx_workflows_run_wake
    ON workflows.run(wake_at, id)
    WHERE state = 'waiting' AND wake_at IS NOT NULL
  `.simple();
  // Fan-out: both "how are my children doing" and "list them" read this.
  await db`
    CREATE INDEX IF NOT EXISTS idx_workflows_run_children
    ON workflows.run(parent_run_id, state, created_at, id)
    WHERE parent_run_id IS NOT NULL
  `.simple();
  await db`
    CREATE INDEX IF NOT EXISTS idx_workflows_run_workflow_history
    ON workflows.run(workflow_id, created_at DESC, id DESC)
    WHERE parent_run_id IS NULL
  `.simple();
  await db`
    CREATE INDEX IF NOT EXISTS idx_workflows_run_scope_history
    ON workflows.run(app_id, scope_id, created_at DESC, id DESC)
    WHERE parent_run_id IS NULL
  `.simple();
  console.log("  ✓ workflows.run table");

  /**
   * The journal. A recorded outcome is never recomputed, so this table is what
   * makes a replay after a crash skip the work that already happened.
   *
   * Effects live here too rather than in a separate intent table: an impure
   * step writes `effect_state = 'executing'` with its key before it acts, then
   * settles it. The key is stable across replays — it is derived from the run
   * and step — so `(run_id, step_key)` already guarantees the uniqueness Grids
   * enforced with a global unique index on its intents.
   */
  await db`
    CREATE TABLE IF NOT EXISTS workflows.step_outcome (
      run_id UUID NOT NULL REFERENCES workflows.run(id) ON DELETE CASCADE,
      step_key TEXT NOT NULL CHECK (char_length(step_key) BETWEEN 1 AND 1000),
      source_path JSONB NOT NULL CHECK (jsonb_typeof(source_path) = 'array'),
      iteration_path JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(iteration_path) = 'array'),
      kind TEXT NOT NULL,
      action TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('execute', 'dryRun')),
      state TEXT NOT NULL CHECK (
        state IN (
          'running',
          -- WorkflowStepOutcome
          'completed', 'waiting', 'failed', 'needs_attention', 'terminal',
          -- WorkflowPlanningOutcome
          'planned', 'unsupported', 'indeterminate', 'canceled'
        )
      ),
      outcome JSONB,
      dependency JSONB CHECK (dependency IS NULL OR jsonb_typeof(dependency) = 'object'),
      execution_generation BIGINT NOT NULL CHECK (execution_generation >= 0),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      effect_key TEXT CHECK (effect_key IS NULL OR char_length(effect_key) BETWEEN 1 AND 500),
      effect_state TEXT CHECK (effect_state IS NULL OR effect_state IN ('executing', 'succeeded', 'ambiguous', 'failed')),
      effect_started_at TIMESTAMPTZ,
      -- What the effect produced, recorded in the same transaction that
      -- performed it. A transactional action can only keep its promise -- a
      -- crash means it did not happen -- if the evidence commits with the work.
      effect_output JSONB,
      -- When this step's effect budget was charged. A parked step is executed
      -- again when its dependency fires, and an allowance sized per effect
      -- would be exhausted by the resume of the effect it already paid for.
      budget_charged_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (run_id, step_key),
      CONSTRAINT step_outcome_effect_chk CHECK ((effect_key IS NULL) = (effect_state IS NULL)),
      -- A step has an outcome exactly when it is no longer in flight.
      CONSTRAINT step_outcome_settled_chk CHECK (
        (state IN ('running', 'waiting') AND outcome IS NULL)
        OR (state NOT IN ('running', 'waiting') AND outcome IS NOT NULL)
      ),
      CONSTRAINT step_outcome_dependency_chk CHECK ((state = 'waiting') = (dependency IS NOT NULL))
    )
  `.simple();
  await db`ALTER TABLE workflows.step_outcome ADD COLUMN IF NOT EXISTS budget_charged_at TIMESTAMPTZ`.simple();
  // Resuming a parked run: find the steps blocked on a dependency that fired.
  await db`
    CREATE INDEX IF NOT EXISTS idx_workflows_step_outcome_dependency
    ON workflows.step_outcome((dependency ->> 'kind'), (dependency ->> 'key'))
    WHERE state = 'waiting'
  `.simple();
  // Ambiguous effects that never settled are the queue a human works through.
  await db`
    CREATE INDEX IF NOT EXISTS idx_workflows_step_outcome_unsettled_effect
    ON workflows.step_outcome(effect_started_at, run_id)
    WHERE effect_state IN ('executing', 'ambiguous')
  `.simple();
  /**
   * A dependency may fire just before its action manages to park. Persisting
   * the signal makes both orderings converge; app_id prevents one app from
   * waking another app's coincidentally equal dependency key.
   *
   * Keys identify one durable occurrence and must therefore be unique within
   * an app. Re-emitting the same key is idempotent.
   */
  await db`
    CREATE TABLE IF NOT EXISTS workflows.dependency_signal (
      app_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 200),
      key TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 500),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (app_id, kind, key)
    )
  `.simple();
  console.log("  ✓ workflows.step_outcome table");
};
