/**
 * Workflows, their versions, and what those versions listen to.
 *
 * The one rule underneath everything here: a version is written once. Grids
 * bumped a `revision` column on the workflow row and re-registered its
 * schedules from a reconcile loop, which is the mechanism behind schedules that
 * silently stop firing after a restart — nothing errors, the job just never
 * runs again. A run that pins an immutable version cannot be redirected by an
 * edit, and an activation that pins one cannot be left pointing at a plan that
 * no longer exists.
 */
import { type SQL, sql } from "bun";
import type { WorkflowBoundPlan, WorkflowDiagnostic, WorkflowJsonValue } from "../contracts";
import { validateWorkflowEffectBudget } from "./budget";
import { withTransaction } from "./transaction";

export type WorkflowAuthor = { kind: "user" | "service_account"; id: string } | { kind: "system"; id?: undefined };

export type WorkflowRecord = {
  id: string;
  appId: string;
  scopeId: string;
  key: string;
  name: string;
  description: string | null;
  activeVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkflowVersionRecord = {
  id: string;
  workflowId: string;
  revision: number;
  source: string;
  sourceHash: string;
  plan: WorkflowBoundPlan;
  diagnostics: WorkflowDiagnostic[];
  languageId: string;
  languageVersion: number;
  manifestHash: string;
  createdAt: Date;
};

/** What an activation listens for, and with what configuration. */
export type WorkflowActivationInput = {
  /** Stable within the workflow — the compiler derives it from the trigger's position. */
  key: string;
  /** Namespaced event type, matching a declaration in the app's `workflows.ts`. */
  eventType: string;
  config?: WorkflowJsonValue;
  enabled?: boolean;
};

export type WorkflowActivationRecord = WorkflowActivationInput & {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  enabled: boolean;
};

type WorkflowRow = {
  id: string;
  app_id: string;
  scope_id: string;
  key: string;
  name: string;
  description: string | null;
  active_version_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const toWorkflow = (row: WorkflowRow): WorkflowRecord => ({
  id: row.id,
  appId: row.app_id,
  scopeId: row.scope_id,
  key: row.key,
  name: row.name,
  description: row.description,
  activeVersionId: row.active_version_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const WORKFLOW_COLUMNS = "id, app_id, scope_id, key, name, description, active_version_id, created_at, updated_at";

// ─── Workflows ───────────────────────────────────────────────────────────────

export const createWorkflow = async (
  input: { appId: string; scopeId: string; key: string; name: string; description?: string; author: WorkflowAuthor },
  options: { db?: SQL } = {},
): Promise<WorkflowRecord> => {
  const db = options.db ?? sql;
  const [row] = await db<WorkflowRow[]>`
    INSERT INTO workflows.workflow (app_id, scope_id, key, name, description, created_by_kind, created_by_id)
    VALUES (${input.appId}, ${input.scopeId}, ${input.key}, ${input.name}, ${input.description ?? null},
            ${input.author.kind}, ${input.author.id ?? null}::uuid)
    RETURNING ${db.unsafe(WORKFLOW_COLUMNS)}
  `;
  if (!row) throw new Error("workflow insert returned no row");
  return toWorkflow(row);
};

export const getWorkflow = async (workflowId: string, options: { db?: SQL } = {}): Promise<WorkflowRecord | null> => {
  const db = options.db ?? sql;
  const [row] = await db<WorkflowRow[]>`SELECT ${db.unsafe(WORKFLOW_COLUMNS)} FROM workflows.workflow WHERE id = ${workflowId}::uuid`;
  return row ? toWorkflow(row) : null;
};

export const listWorkflows = async (scope: { appId: string; scopeId: string }, options: { db?: SQL } = {}): Promise<WorkflowRecord[]> => {
  const db = options.db ?? sql;
  const rows = await db<WorkflowRow[]>`
    SELECT ${db.unsafe(WORKFLOW_COLUMNS)} FROM workflows.workflow
    WHERE app_id = ${scope.appId} AND scope_id = ${scope.scopeId}
    ORDER BY name, id
  `;
  return rows.map(toWorkflow);
};

/** Renames only. The plan lives in versions, which is why there is no source here. */
export const renameWorkflow = async (
  workflowId: string,
  input: { name: string; description?: string | null },
  options: { db?: SQL } = {},
): Promise<void> => {
  const db = options.db ?? sql;
  await db`
    UPDATE workflows.workflow
    SET name = ${input.name}, description = ${input.description ?? null}, updated_at = now()
    WHERE id = ${workflowId}::uuid
  `;
};

/**
 * Drops every workflow in a scope.
 *
 * The kernel holds `app_id` and `scope_id` as opaque strings rather than
 * foreign keys — `workflows` cannot reference `grids.bases` without inverting
 * the dependency — so an app calls this when one of its scopes goes away.
 */
export const deleteWorkflowScope = async (scope: { appId: string; scopeId: string }, options: { db?: SQL } = {}): Promise<number> => {
  return withTransaction(options.db, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      DELETE FROM workflows.workflow WHERE app_id = ${scope.appId} AND scope_id = ${scope.scopeId} RETURNING id
    `;
    await tx`DELETE FROM workflows.event WHERE app_id = ${scope.appId} AND scope_id = ${scope.scopeId}`;
    const [ai] = await tx<{ present: boolean }[]>`SELECT to_regclass('ai.workflow_scope_budget') IS NOT NULL AS present`;
    if (ai?.present) {
      await tx`DELETE FROM ai.workflow_scope_budget WHERE app_id = ${scope.appId} AND scope_id = ${scope.scopeId}`;
      await tx`DELETE FROM ai.workflow_scope_admission WHERE app_id = ${scope.appId} AND scope_id = ${scope.scopeId}`;
    }
    return rows.length;
  });
};

// ─── Versions ────────────────────────────────────────────────────────────────

export type PublishWorkflowVersion = {
  workflowId: string;
  source: string;
  plan: WorkflowBoundPlan;
  diagnostics?: WorkflowDiagnostic[];
  /** Caps on external effects for runs of this version. Absent dimensions are uncapped. */
  effectBudget?: Record<string, number>;
  /**
   * Who runs started by these activations act as, when the occurrence has no
   * actor of its own — a schedule tick, an observed row change.
   */
  authorization?: WorkflowJsonValue;
  author: WorkflowAuthor;
  /** What the new version listens to. Replaces the previous version's set wholesale. */
  activations: readonly WorkflowActivationInput[];
  /** `false` publishes the version without making it live — a draft. */
  activate?: boolean;
};

/**
 * Writes a new version and re-points the workflow's activations to it, in one
 * transaction.
 *
 * Atomic because the alternative has a window: an event arriving between
 * deleting the old activations and inserting the new ones would match nothing
 * and be silently dropped. The version row itself is never updated afterwards —
 * a database trigger rejects that — so a run already executing this plan keeps
 * executing exactly this plan.
 */
export const publishWorkflowVersion = async (input: PublishWorkflowVersion, options: { db?: SQL } = {}): Promise<WorkflowVersionRecord> => {
  validateWorkflowEffectBudget(input.effectBudget ?? {});
  return withTransaction(options.db, async (tx) => {
    // Serialise concurrent publishes of the same workflow, so two of them
    // cannot claim the same revision number or interleave their activations.
    const [current] = await tx<{ id: string }[]>`SELECT id FROM workflows.workflow WHERE id = ${input.workflowId}::uuid FOR UPDATE`;
    if (!current) throw new Error(`workflow ${input.workflowId} does not exist`);

    const [version] = await tx<
      {
        id: string;
        workflow_id: string;
        revision: number;
        source: string;
        source_hash: string;
        plan: WorkflowBoundPlan;
        diagnostics: WorkflowDiagnostic[];
        language_id: string;
        language_version: number;
        manifest_hash: string;
        created_at: Date;
      }[]
    >`
      INSERT INTO workflows.version (
        workflow_id, revision, source, source_hash, plan, diagnostics, effect_budget,
        language_id, language_version, manifest_hash, created_by_kind, created_by_id
      )
      SELECT ${input.workflowId}::uuid,
             COALESCE(max(revision), 0) + 1,
             ${input.source}, ${input.plan.sourceHash}, ${input.plan}, ${input.diagnostics ?? []}, ${input.effectBudget ?? {}},
             ${input.plan.languageId}, ${input.plan.languageVersion}, ${input.plan.manifestHash},
             ${input.author.kind}, ${input.author.id ?? null}::uuid
      FROM workflows.version WHERE workflow_id = ${input.workflowId}::uuid
      RETURNING *
    `;
    if (!version) throw new Error("workflow version insert returned no row");

    if (input.activate !== false) {
      // Whether each key is currently enabled, so a publish carries the
      // operator's decision forward instead of turning a disabled workflow
      // back on.
      const existing = await tx<{ key: string; enabled: boolean }[]>`
        SELECT key, enabled FROM workflows.activation WHERE workflow_id = ${input.workflowId}::uuid
      `;
      const wasEnabled = new Map(existing.map((row) => [row.key, row.enabled]));

      if (input.activations.length > 0) {
        const rows = input.activations.map((activation) => ({
          workflow_id: input.workflowId,
          workflow_version_id: version.id,
          key: activation.key,
          event_type: activation.eventType,
          config: activation.config ?? {},
          authorization_snapshot: input.authorization ?? {},
          enabled: activation.enabled ?? wasEnabled.get(activation.key) ?? true,
        }));
        await tx`
          INSERT INTO workflows.activation ${tx(rows)}
          ON CONFLICT (workflow_id, key) DO UPDATE
          SET workflow_version_id = EXCLUDED.workflow_version_id,
              event_type = EXCLUDED.event_type,
              config = EXCLUDED.config,
              authorization_snapshot = EXCLUDED.authorization_snapshot,
              enabled = EXCLUDED.enabled,
              updated_at = now()
        `;
      }
      // A trigger removed from the source must stop firing, so anything not in
      // this publish goes — matched by key, which is stable across versions.
      await tx`
        DELETE FROM workflows.activation
        WHERE workflow_id = ${input.workflowId}::uuid AND workflow_version_id <> ${version.id}::uuid
      `;

      await tx`UPDATE workflows.workflow SET active_version_id = ${version.id}::uuid, updated_at = now() WHERE id = ${input.workflowId}::uuid`;
    }

    return {
      id: version.id,
      workflowId: version.workflow_id,
      revision: version.revision,
      source: version.source,
      sourceHash: version.source_hash,
      plan: version.plan,
      diagnostics: version.diagnostics,
      languageId: version.language_id,
      languageVersion: version.language_version,
      manifestHash: version.manifest_hash,
      createdAt: version.created_at,
    };
  });
};

/** Stops a workflow without deleting it: its activations no longer match. */
export const setWorkflowEnabled = async (workflowId: string, enabled: boolean, options: { db?: SQL } = {}): Promise<void> => {
  const db = options.db ?? sql;
  await db`UPDATE workflows.activation SET enabled = ${enabled}, updated_at = now() WHERE workflow_id = ${workflowId}::uuid`;
};

export const listWorkflowVersions = async (
  workflowId: string,
  options: { db?: SQL; limit?: number } = {},
): Promise<WorkflowVersionRecord[]> => {
  const db = options.db ?? sql;
  const rows = await db<
    {
      id: string;
      workflow_id: string;
      revision: number;
      source: string;
      source_hash: string;
      plan: WorkflowBoundPlan;
      diagnostics: WorkflowDiagnostic[];
      language_id: string;
      language_version: number;
      manifest_hash: string;
      created_at: Date;
    }[]
  >`
    SELECT * FROM workflows.version WHERE workflow_id = ${workflowId}::uuid
    ORDER BY revision DESC LIMIT ${options.limit ?? 50}
  `;
  return rows.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    revision: row.revision,
    source: row.source,
    sourceHash: row.source_hash,
    plan: row.plan,
    diagnostics: row.diagnostics,
    languageId: row.language_id,
    languageVersion: row.language_version,
    manifestHash: row.manifest_hash,
    createdAt: row.created_at,
  }));
};

export const listWorkflowActivations = async (workflowId: string, options: { db?: SQL } = {}): Promise<WorkflowActivationRecord[]> => {
  const db = options.db ?? sql;
  const rows = await db<
    {
      id: string;
      workflow_id: string;
      workflow_version_id: string;
      key: string;
      event_type: string;
      config: WorkflowJsonValue;
      enabled: boolean;
    }[]
  >`
    SELECT id, workflow_id, workflow_version_id, key, event_type, config, enabled
    FROM workflows.activation WHERE workflow_id = ${workflowId}::uuid ORDER BY key
  `;
  return rows.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    key: row.key,
    eventType: row.event_type,
    config: row.config,
    enabled: row.enabled,
  }));
};
