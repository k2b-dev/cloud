/**
 * Grids workflow definitions, stored by the kernel.
 *
 * Identity, versions and activations live in `workflows.*`; what is genuinely
 * Grids' own — the base, the short id, sidebar order, the owner, and whether
 * the workflow may run at all — lives in `grids.workflow_profile`. A
 * `GridsWorkflow` is the join of the two.
 *
 * Three things change shape compared with the table this replaces:
 *
 * A version is written once. Saving publishes a new one rather than mutating a
 * row, so a run already executing a plan keeps executing exactly that plan —
 * and the revision history stops being a side effect of a database trigger.
 *
 * `revision` therefore counts published plans, not edits. Renaming a workflow
 * no longer produces a revision in which nothing about the plan changed.
 *
 * `enabled` stays here rather than moving to the kernel's per-activation flag,
 * because it also refuses direct invocation — and a workflow with no triggers
 * has no activation to carry it.
 */

import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { WorkflowBoundPlan, WorkflowDiagnostic } from "@k2b/cloud/workflows";
import type { WorkflowActivationInput } from "@k2b/cloud/workflows/store";
import {
  createWorkflow as createKernelWorkflow,
  publishWorkflowVersion,
  renameWorkflow as renameKernelWorkflow,
  setWorkflowEnabled,
} from "@k2b/cloud/workflows/store";
import { type SQL, sql } from "bun";
import { compileAndBindGridsWorkflowSource } from "../workflows/binder";
import type {
  CreateGridsWorkflowInput,
  GridsWorkflow,
  GridsWorkflowRevision,
  GridsWorkflowRevisionSummary,
  UpdateGridsWorkflowInput,
} from "../workflows/contracts";
import { GridsWorkflowRevisionSchema } from "../workflows/contracts";
import { GRIDS_EVENT } from "../workflows/events";
import { logAudit } from "./audit";
import { emitMetadataEvent } from "./metadata-events";
import { insertWithShortId } from "./short-id";
import { loadWorkflowCatalog } from "./workflow-catalog";
import { assertWorkflowEmailTemplatesAvailable, lockWorkflowCatalogMutation } from "./workflow-catalog-mutation";
import { getWorkflow } from "./workflow-read";
import { emitWorkflowRuntimeEvent } from "./workflow-runtime-events";
import { workflowServiceText } from "./workflow-service-messages";

export {
  getWorkflowByShortIdForBase,
  listRecordEventBaseIds,
  listRecordEventWorkflows,
  listScheduledWorkflows,
  listWorkflowScopes,
  listWorkflows,
} from "./workflow-read";
export { getWorkflow };

/** How Grids identifies itself to the kernel. A base is one scope. */
const APP_ID = "grids";

type DbRow = Record<string, unknown>;

const revisionConflict = (locale?: string) => ({
  code: "CONFLICT" as const,
  message: workflowServiceText(locale).workflowChangedEditor,
  status: 409 as const,
});

/**
 * The latest published version, joined onto the Grids profile.
 *
 * Latest rather than active: this is what the editor last saved, which is what
 * every caller means by "the workflow". A disabled workflow still has its plan.
 */
const compileAndBind = async (
  baseId: string,
  source: string,
  db: SQL = sql,
): Promise<Result<{ plan: WorkflowBoundPlan; source: string }>> => {
  const bound = await compileAndBindGridsWorkflowSource(source, await loadWorkflowCatalog(baseId, db));
  return bound.ok
    ? ok({ plan: bound.plan, source: bound.source ?? source })
    : fail(err.badInput(bound.diagnostics.map((diagnostic) => diagnostic.message).join("; ")));
};

export const validateWorkflowSource = async (
  baseId: string,
  source: string,
): Promise<{ ok: true; plan: WorkflowBoundPlan } | { ok: false; diagnostics: WorkflowDiagnostic[] }> => {
  const bound = await compileAndBindGridsWorkflowSource(source, await loadWorkflowCatalog(baseId));
  return bound.ok ? { ok: true, plan: bound.plan } : bound;
};

/**
 * What the plan's triggers subscribe to.
 *
 * The key is positional and stable across publishes, so re-publishing an
 * unchanged trigger updates its activation rather than deleting and recreating
 * it — which is what stops an event arriving mid-publish from matching nothing.
 */
const activationsFor = (plan: WorkflowBoundPlan, enabled: boolean): WorkflowActivationInput[] => [
  /*
   * The two nobody writes. Being runnable from the API and from a launcher is
   * not a trigger an author declared, it is what every workflow is — so a plan
   * with no triggers at all still has to have somewhere for its invocation to
   * land, or `emitWorkflowEvent` matches nothing and the run silently never
   * happens. `enabled` still gates them, because disabling a workflow has to
   * refuse a direct invocation too.
   */
  { key: "invoked", eventType: GRIDS_EVENT.invoked, enabled },
  { key: "launcher", eventType: GRIDS_EVENT.launcherPressed, enabled },
  ...plan.triggers.flatMap((trigger, index) => {
    const eventType =
      trigger.kind === "schedule" ? GRIDS_EVENT.scheduleTick : trigger.kind === "recordEvent" ? GRIDS_EVENT.recordChanged : null;
    return eventType ? [{ key: `${trigger.kind}:${index}`, eventType, config: trigger.config, enabled }] : [];
  }),
];

const hasRecordEventTrigger = (plan: WorkflowBoundPlan): boolean => plan.triggers.some((trigger) => trigger.kind === "recordEvent");

const recordEventTriggers = (plan: WorkflowBoundPlan) => plan.triggers.filter((trigger) => trigger.kind === "recordEvent");

const metadataEvent = async (
  type: "workflow.created" | "workflow.updated" | "workflow.deleted",
  workflow: Pick<GridsWorkflow, "id" | "baseId">,
  actorId: string | null,
): Promise<void> => {
  await Promise.all([
    emitMetadataEvent({ type, baseId: workflow.baseId, resource: { kind: "workflow", id: workflow.id }, actorId }),
    emitWorkflowRuntimeEvent(workflow.id),
  ]);
};

// ─── Writes ──────────────────────────────────────────────────────────────────

export const createWorkflow = async (
  baseId: string,
  input: CreateGridsWorkflowInput,
  actorId: string | null,
  locale?: string,
): Promise<Result<GridsWorkflow>> => {
  const plan = await compileAndBind(baseId, input.source);
  if (!plan.ok) return plan;
  const enabled = input.enabled ?? false;

  const created = await sql.begin(async (tx): Promise<Result<string>> => {
    await lockWorkflowCatalogMutation(baseId, tx);
    const available = await assertWorkflowEmailTemplatesAvailable(baseId, plan.data.plan, tx, locale);
    if (!available.ok) return fail(available.error);

    const workflow = await createKernelWorkflow(
      {
        appId: APP_ID,
        scopeId: baseId,
        // The kernel's key is scoped to (app, scope); the short id is already
        // unique per base and is what the URL uses, so they are the same thing.
        key: crypto.randomUUID(),
        name: input.name.trim(),
        ...(input.description ? { description: input.description } : {}),
        author: actorId ? { kind: "user", id: actorId } : { kind: "system" },
      },
      { db: tx },
    );

    await insertWithShortId(
      (shortId) =>
        tx.savepoint(async (sp) => {
          const [inserted] = await sp<DbRow[]>`
            INSERT INTO grids.workflow_profile (
              id, base_id, short_id, position, owner_user_id, enabled, record_event_active_since
            ) VALUES (
              ${workflow.id}::uuid, ${baseId}::uuid, ${shortId}, ${input.position ?? 0}, ${actorId}::uuid, ${enabled},
              ${enabled && hasRecordEventTrigger(plan.data.plan) ? sql`now()` : null}
            )
            RETURNING id
          `;
          if (!inserted) throw new Error("workflow profile insert failed");
          return inserted;
        }),
      "idx_grids_workflow_profile_short_id",
    );

    await publishWorkflowVersion(
      {
        workflowId: workflow.id,
        source: plan.data.source,
        plan: plan.data.plan,
        author: actorId ? { kind: "user", id: actorId } : { kind: "system" },
        activations: activationsFor(plan.data.plan, enabled),
      },
      { db: tx },
    );

    await logAudit(
      {
        baseId,
        userId: actorId,
        action: "workflow.created",
        diff: { workflow: { old: null, new: { id: workflow.id, name: input.name.trim(), enabled } } },
      },
      tx,
    );
    return ok(workflow.id);
  });
  if (!created.ok) return created;

  const workflow = await getWorkflow(created.data);
  if (!workflow) return fail({ ...err.notFound("workflow"), message: workflowServiceText(locale).workflowNotFound });
  await metadataEvent("workflow.created", workflow, actorId);
  return ok(workflow);
};

export const updateWorkflow = async (
  id: string,
  input: UpdateGridsWorkflowInput,
  actorId: string | null,
  expectedRevision: number,
  audit: { action?: "workflow.updated" | "workflow.revision.restored"; restoredRevision?: number } = {},
  locale?: string,
): Promise<Result<GridsWorkflow>> => {
  const existing = await getWorkflow(id);
  if (!existing) return fail({ ...err.notFound("workflow"), message: workflowServiceText(locale).workflowNotFound });
  if (existing.revision !== expectedRevision) return fail(revisionConflict(locale));

  const publishes = input.source !== undefined;
  const updated = await sql.begin(async (tx): Promise<Result<null>> => {
    await lockWorkflowCatalogMutation(existing.baseId, tx);
    const current = await getWorkflow(id, false, tx);
    if (!current) return fail({ ...err.notFound("workflow"), message: workflowServiceText(locale).workflowNotFound });
    if (current.revision !== expectedRevision) return fail(revisionConflict(locale));
    // Metadata changes do not publish a revision. Defaults must therefore come
    // from the locked current state, especially after a concurrent disable.
    const source = input.source ?? current.source;
    const enabled = input.enabled ?? current.enabled;
    const activating = !current.enabled && input.enabled === true;
    const compiled =
      input.source === undefined && !activating ? ok({ plan: current.plan, source }) : await compileAndBind(current.baseId, source, tx);
    if (!compiled.ok) return compiled;
    const recordEventsEnabled = enabled && hasRecordEventTrigger(compiled.data.plan);
    const recordEventActivationChanged =
      !current.enabled || JSON.stringify(recordEventTriggers(current.plan)) !== JSON.stringify(recordEventTriggers(compiled.data.plan));
    if (publishes || activating) {
      const available = await assertWorkflowEmailTemplatesAvailable(existing.baseId, compiled.data.plan, tx, locale);
      if (!available.ok) return fail(available.error);
    }

    const [row] = await tx<DbRow[]>`
      UPDATE grids.workflow_profile
      SET enabled = ${enabled},
          position = ${input.position ?? current.position},
          record_event_active_since = CASE
            WHEN ${recordEventsEnabled} = FALSE THEN NULL
            WHEN record_event_active_since IS NULL OR ${recordEventActivationChanged} THEN now()
            ELSE record_event_active_since
          END,
          updated_at = now()
      WHERE id = ${id}::uuid AND deleted_at IS NULL
      RETURNING id
    `;
    if (!row) return fail({ ...err.notFound("workflow"), message: workflowServiceText(locale).workflowNotFound });

    if (input.name !== undefined || input.description !== undefined) {
      await renameKernelWorkflow(
        id,
        {
          name: input.name?.trim() ?? current.name,
          description: input.description === undefined ? current.description : input.description,
        },
        { db: tx },
      );
    }

    if (publishes) {
      await publishWorkflowVersion(
        {
          workflowId: id,
          source: compiled.data.source,
          plan: compiled.data.plan,
          author: actorId ? { kind: "user", id: actorId } : { kind: "system" },
          activations: activationsFor(compiled.data.plan, enabled),
        },
        { db: tx },
      );
    } else if (input.enabled !== undefined) {
      // No new plan, but the dispatcher has to agree about whether triggers fire.
      await setWorkflowEnabled(id, enabled, { db: tx });
    }

    await logAudit(
      {
        baseId: existing.baseId,
        userId: actorId,
        action: audit.action ?? "workflow.updated",
        diff: {
          workflow: {
            old: { id: current.id, name: current.name, enabled: current.enabled, revision: current.revision },
            new: { id, name: input.name?.trim() ?? current.name, enabled },
          },
          ...(audit.restoredRevision === undefined ? {} : { restoredRevision: { old: null, new: audit.restoredRevision } }),
        },
      },
      tx,
    );
    return ok(null);
  });
  if (!updated.ok) return updated;

  const workflow = await getWorkflow(id);
  if (!workflow) return fail({ ...err.notFound("workflow"), message: workflowServiceText(locale).workflowNotFound });

  /*
   * A new plan may have changed the inputs a run option supplies, so every
   * launcher is switched off until someone looks at it. A metadata-only edit
   * leaves them alone — which it could not before, when renaming bumped the
   * revision and invalidated them for nothing.
   */
  if (publishes) {
    await sql`
      UPDATE grids.workflow_launchers
      SET enabled = FALSE,
          validated_revision = ${workflow.revision},
          diagnostics = ${[
            {
              code: "launcher.revalidate",
              message: workflowServiceText(locale).launcherChangedReview,
              severity: "warning",
              path: [],
            },
          ]}::jsonb,
          updated_at = now()
      WHERE workflow_id = ${id}::uuid AND deleted_at IS NULL
    `;
  }

  await metadataEvent("workflow.updated", workflow, actorId);
  return ok(workflow);
};

// ─── Versions ────────────────────────────────────────────────────────────────

export const listWorkflowRevisions = async (
  workflowId: string,
  beforeRevision: number | null = null,
  limit = 50,
): Promise<{ items: GridsWorkflowRevisionSummary[]; nextRevision: number | null }> => {
  const pageSize = Math.min(Math.max(limit, 1), 100);
  const rows = await sql<DbRow[]>`
    SELECT v.revision, v.created_at, v.created_by_id, w.name
    FROM workflows.version AS v
    JOIN workflows.workflow AS w ON w.id = v.workflow_id
    WHERE v.workflow_id = ${workflowId}::uuid
      AND (${beforeRevision}::int IS NULL OR v.revision < ${beforeRevision}::int)
    ORDER BY v.revision DESC
    LIMIT ${pageSize + 1}
  `;
  const items = rows.slice(0, pageSize).map((row) => ({
    workflowId,
    revision: Number(row.revision),
    // The name is the workflow's current one: versions record plans, not
    // metadata, so a rename does not fork the history.
    name: row.name as string,
    actorUserId: (row.created_by_id as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  }));
  return { items, nextRevision: rows.length > pageSize && items.length > 0 ? items[items.length - 1]!.revision : null };
};

export const getWorkflowRevision = async (workflowId: string, revision: number): Promise<GridsWorkflowRevision | null> => {
  const [row] = await sql<DbRow[]>`
    SELECT v.revision, v.source, v.plan, v.diagnostics, v.created_at, v.created_by_id, w.name, w.description, p.position
    FROM workflows.version AS v
    JOIN workflows.workflow AS w ON w.id = v.workflow_id
    JOIN grids.workflow_profile AS p ON p.id = v.workflow_id
    WHERE v.workflow_id = ${workflowId}::uuid AND v.revision = ${revision}
  `;
  if (!row) return null;
  const parsed = GridsWorkflowRevisionSchema.safeParse({
    workflowId,
    revision: row.revision,
    name: row.name,
    description: row.description ?? null,
    source: row.source,
    plan: row.plan,
    diagnostics: row.diagnostics,
    position: row.position,
    actorUserId: row.created_by_id ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  });
  if (!parsed.success) throw new Error("stored workflow revision is invalid");
  return parsed.data;
};

/**
 * Restores an old plan by publishing it again.
 *
 * Not by rewinding: versions are immutable, and a run pinned to the version
 * being restored has to keep executing what it started on. The restored plan
 * therefore becomes the newest revision.
 */
export const restoreWorkflowRevision = async (
  id: string,
  revision: number,
  actorId: string | null,
  expectedRevision: number,
  locale?: string,
): Promise<Result<GridsWorkflow>> => {
  const snapshot = await getWorkflowRevision(id, revision);
  if (!snapshot) return fail({ ...err.notFound("workflow revision"), message: workflowServiceText(locale).workflowVersionNotFound });
  return updateWorkflow(
    id,
    { source: snapshot.source },
    actorId,
    expectedRevision,
    { action: "workflow.revision.restored", restoredRevision: revision },
    locale,
  );
};

export const removeWorkflow = async (id: string, actorId: string | null, locale?: string): Promise<Result<void>> => {
  const existing = await getWorkflow(id);
  if (!existing) return fail({ ...err.notFound("workflow"), message: workflowServiceText(locale).workflowNotFound });
  await sql.begin(async (tx) => {
    const [row] = await tx<DbRow[]>`
      UPDATE grids.workflow_profile
      SET deleted_at = now(), enabled = FALSE, record_event_active_since = NULL, updated_at = now()
      WHERE id = ${id}::uuid AND deleted_at IS NULL
      RETURNING id
    `;
    if (!row) return;
    // Soft delete: the kernel rows stay so the run history a deleted workflow
    // produced is still readable. Its activations stop matching.
    await setWorkflowEnabled(id, false, { db: tx });
    await logAudit(
      {
        baseId: existing.baseId,
        userId: actorId,
        action: "workflow.deleted",
        diff: { workflow: { old: { id: existing.id, name: existing.name }, new: null } },
      },
      tx,
    );
  });
  await metadataEvent("workflow.deleted", existing, actorId);
  return ok();
};
