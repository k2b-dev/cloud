import { err, fail, isServiceError, ok, type Result } from "@k2b/stdlib";
import { audit } from "@k2b/cloud/services";
import type { WorkflowBoundPlan, WorkflowDiagnostic, WorkflowIr, WorkflowJsonValue } from "@k2b/cloud/workflows";
import { compileWorkflow } from "@k2b/cloud/workflows/language";
import {
  createWorkflow as createKernelWorkflow,
  publishWorkflowVersion,
  renameWorkflow,
  type WorkflowActivationInput,
} from "@k2b/cloud/workflows/store";
import { sql } from "bun";
import type {
  ActivateWorkflowInput,
  AutocompleteWorkflowInput,
  CreateWorkflowInput,
  CreateWorkflowVersionInput,
  DeactivateWorkflowInput,
  MailWorkflow,
  MailWorkflowActivation,
  MailWorkflowDetail,
  MailWorkflowVersion,
  RestoreWorkflowVersionInput,
  UpdateWorkflowMetadataInput,
  WorkflowAutocomplete,
  WorkflowEffectBudget,
  WorkflowValidation,
} from "../contracts";
import { buildMailWorkflowCompletions } from "../workflows/authoring";
import { bindMailWorkflow } from "../workflows/binder";
import { MAIL_WORKFLOW_APP_ID, MAIL_WORKFLOW_EVENT } from "../workflows/events";
import { mailWorkflows } from "../workflows/module";
import { validateMailWorkflowTemplates } from "../workflows/template-validation";
import { requireMailboxPermission } from "./access";
import { actorRefFromRequest, auditActorFromRequest, type MailRequestContext } from "./auth";
import { loadMailWorkflowCatalog } from "./workflow-catalog-service";
import type { SqlClient } from "./workflow-data";
import { snapshotMailboxWorkflowAuthorization } from "./workflow-runtime-context";

type DbWorkflow = {
  id: string;
  mailbox_id: string;
  name: string;
  description: string | null;
  priority: number;
  enabled: boolean;
  managed_by: ManagedWorkflowOwner | null;
  current_version_id: string;
  active_version_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type ManagedWorkflowOwner = "automatic_reply" | "incoming_automation";

export type DbWorkflowVersion = {
  id: string;
  workflow_id: string;
  mailbox_id: string;
  revision: number;
  source: string;
  source_hash: string;
  plan: WorkflowBoundPlan | string;
  diagnostics: WorkflowDiagnostic[] | string;
  effect_budget: WorkflowEffectBudget | string;
  language_id: string;
  language_version: number;
  manifest_hash: string;
  created_at: Date | string;
};

type DbActivation = {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  key: string;
  event_type: string;
  config: WorkflowJsonValue | string;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

const parseJson = <T>(value: T | string): T => (typeof value === "string" ? (JSON.parse(value) as T) : value);
const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

const WORKFLOW_SELECT = sql.unsafe(`
  workflow.id::text AS id,
  profile.mailbox_id::text AS mailbox_id,
  workflow.name,
  workflow.description,
  profile.priority,
  profile.enabled,
  profile.managed_by,
  latest.id::text AS current_version_id,
  workflow.active_version_id::text AS active_version_id,
  profile.created_at,
  profile.updated_at
`);
const WORKFLOW_FROM = sql.unsafe(`
  FROM mail.workflow_profile profile
  JOIN workflows.workflow workflow ON workflow.id = profile.id
  JOIN LATERAL (
    SELECT id
    FROM workflows.version
    WHERE workflow_id = workflow.id
    ORDER BY revision DESC
    LIMIT 1
  ) latest ON TRUE
`);

const VERSION_SELECT = sql.unsafe(`
  version.id::text AS id,
  version.workflow_id::text AS workflow_id,
  profile.mailbox_id::text AS mailbox_id,
  version.revision,
  version.source,
  version.source_hash,
  version.plan,
  version.diagnostics,
  version.effect_budget,
  version.language_id,
  version.language_version,
  version.manifest_hash,
  version.created_at
`);
const VERSION_FROM = sql.unsafe(`
  FROM workflows.version version
  JOIN mail.workflow_profile profile ON profile.id = version.workflow_id
`);

const mapWorkflow = (row: DbWorkflow): MailWorkflow => ({
  id: row.id,
  mailboxId: row.mailbox_id,
  name: row.name,
  description: row.description,
  priority: row.priority,
  currentVersionId: row.current_version_id,
  activeVersionId: row.active_version_id,
  enabled: row.enabled,
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const mapWorkflowVersion = (row: DbWorkflowVersion): MailWorkflowVersion => {
  const plan = parseJson(row.plan);
  return {
    id: row.id,
    identity: `${row.workflow_id}:r${row.revision}`,
    workflowId: row.workflow_id,
    mailboxId: row.mailbox_id,
    source: row.source,
    sourceHash: row.source_hash,
    boundPlan: plan,
    diagnostics: parseJson(row.diagnostics),
    effectBudget: parseJson(row.effect_budget),
    languageId: row.language_id,
    languageVersion: row.language_version,
    manifestHash: row.manifest_hash,
    createdAt: toIso(row.created_at),
  };
};

const mapActivation = (row: DbActivation): MailWorkflowActivation => ({
  id: row.id,
  workflowId: row.workflow_id,
  workflowVersionId: row.workflow_version_id,
  key: row.key,
  kind: row.event_type === MAIL_WORKFLOW_EVENT.schedule ? "schedule" : "messageReceived",
  config: (parseJson(row.config) ?? {}) as Record<string, WorkflowJsonValue>,
  enabled: row.enabled,
  diagnostics: [],
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const creator = (context: MailRequestContext): { kind: "user" | "service_account"; id: string } => {
  const actor = actorRefFromRequest(context);
  if (actor.kind === "user") return { kind: "user", id: actor.userId };
  if (actor.kind === "service_account") return { kind: "service_account", id: actor.serviceAccountId };
  throw new TypeError("Request actor cannot create Mail workflows");
};

export const validateMailWorkflowSource = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  source: string;
  db?: SqlClient;
}): Promise<WorkflowValidation> => {
  const compiled = await compileWorkflow(params.source, mailWorkflows);
  if (!compiled.ok) {
    return { valid: false, source: params.source, sourceHash: null, ir: null, boundPlan: null, diagnostics: compiled.diagnostics };
  }
  const templateDiagnostics = validateMailWorkflowTemplates(compiled.ir);
  if (templateDiagnostics.length > 0) {
    return {
      valid: false,
      source: params.source,
      sourceHash: compiled.ir.sourceHash,
      ir: compiled.ir,
      boundPlan: null,
      diagnostics: templateDiagnostics,
    };
  }
  const bound = await bindMailWorkflow(compiled.ir, await loadMailWorkflowCatalog(params));
  return bound.ok
    ? {
        valid: true,
        source: params.source,
        sourceHash: compiled.ir.sourceHash,
        ir: compiled.ir,
        boundPlan: bound.plan,
        diagnostics: [],
      }
    : {
        valid: false,
        source: params.source,
        sourceHash: compiled.ir.sourceHash,
        ir: compiled.ir,
        boundPlan: null,
        diagnostics: bound.diagnostics,
      };
};

export const validateWorkflow = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  source: string;
}): Promise<Result<WorkflowValidation>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "read");
  return allowed.ok ? ok(await validateMailWorkflowSource(params)) : allowed;
};

export const autocompleteWorkflow = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: AutocompleteWorkflowInput;
}): Promise<Result<WorkflowAutocomplete>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const catalog = await loadMailWorkflowCatalog(params);
  const compiled = await compileWorkflow(params.input.source, mailWorkflows);
  const bound = compiled.ok ? await bindMailWorkflow(compiled.ir, catalog) : null;
  const diagnostics = !compiled.ok ? compiled.diagnostics : bound && !bound.ok ? bound.diagnostics : [];
  return ok({
    diagnostics,
    items: buildMailWorkflowCompletions(params.input.source, params.input.caret, catalog),
  });
};

export const workflowTriggerRegistrations = (plan: WorkflowBoundPlan, enabled = true): WorkflowActivationInput[] =>
  plan.triggers.map((trigger, index) => ({
    key: `${trigger.kind}:${index}`,
    eventType: trigger.kind === "schedule" ? MAIL_WORKFLOW_EVENT.schedule : MAIL_WORKFLOW_EVENT.messageReceived,
    config: { ...trigger.config, with: trigger.with },
    enabled,
  }));

export const workflowActivationError = (plan: WorkflowBoundPlan): string | null =>
  plan.triggers.length > 0 ? null : "An active workflow needs at least one trigger";

const loadActivations = async (workflowId: string, db: SqlClient = sql): Promise<MailWorkflowActivation[]> => {
  const rows = await db<DbActivation[]>`
    SELECT id::text, workflow_id::text, workflow_version_id::text, key, event_type, config,
           enabled, created_at, updated_at
    FROM workflows.activation
    WHERE workflow_id = ${workflowId}::uuid
    ORDER BY key, id
  `;
  return rows.map(mapActivation);
};

const loadWorkflowRow = async (mailboxId: string, workflowId: string, db: SqlClient = sql, lock = false): Promise<DbWorkflow | null> => {
  const [row] = await db<DbWorkflow[]>`
    SELECT ${WORKFLOW_SELECT}
    ${WORKFLOW_FROM}
    WHERE workflow.id = ${workflowId}::uuid AND profile.mailbox_id = ${mailboxId}::uuid
    ${lock ? sql`FOR UPDATE OF profile` : sql``}
  `;
  return row ?? null;
};

export const loadWorkflowVersion = async (params: {
  mailboxId: string;
  workflowId: string;
  versionId: string;
  db?: SqlClient;
  lock?: boolean;
}): Promise<DbWorkflowVersion | null> => {
  const db = params.db ?? sql;
  const [row] = await db<DbWorkflowVersion[]>`
    SELECT ${VERSION_SELECT}
    ${VERSION_FROM}
    WHERE version.id = ${params.versionId}::uuid
      AND version.workflow_id = ${params.workflowId}::uuid
      AND profile.mailbox_id = ${params.mailboxId}::uuid
    ${params.lock ? sql`FOR SHARE OF version` : sql``}
  `;
  return row ?? null;
};

const loadWorkflowDetail = async (mailboxId: string, workflowId: string, db: SqlClient = sql): Promise<MailWorkflowDetail | null> => {
  const workflow = await loadWorkflowRow(mailboxId, workflowId, db);
  if (!workflow) return null;
  const version = await loadWorkflowVersion({
    mailboxId,
    workflowId,
    versionId: workflow.current_version_id,
    db,
  });
  if (!version) throw new Error(`Mail workflow ${workflowId} has no current version`);
  return {
    ...mapWorkflow(workflow),
    currentVersion: mapWorkflowVersion(version),
    activations: await loadActivations(workflowId, db),
  };
};

const rejectManagedWorkflow = async (mailboxId: string, workflowId: string, db: SqlClient, conceal: boolean): Promise<Result<void>> => {
  const [profile] = await db<{ managed_by: ManagedWorkflowOwner | null }[]>`
    SELECT managed_by
    FROM mail.workflow_profile
    WHERE id = ${workflowId}::uuid AND mailbox_id = ${mailboxId}::uuid
  `;
  if (!profile?.managed_by) return ok();
  return conceal ? fail(err.notFound("Workflow")) : fail(err.conflict("Managed workflows must be changed from their guided Mail settings"));
};

const publish = async (params: {
  db: SqlClient;
  workflowId: string;
  validation: WorkflowValidation & { boundPlan: WorkflowBoundPlan; sourceHash: string };
  effectBudget: WorkflowEffectBudget;
  actor: ReturnType<typeof creator>;
  authorization: WorkflowJsonValue;
  enabled: boolean;
}) =>
  publishWorkflowVersion(
    {
      workflowId: params.workflowId,
      source: params.validation.source,
      plan: params.validation.boundPlan,
      diagnostics: params.validation.diagnostics,
      effectBudget: params.effectBudget,
      authorization: params.authorization,
      activations: workflowTriggerRegistrations(params.validation.boundPlan, params.enabled),
      activate: true,
      author: params.actor,
    },
    { db: params.db },
  );

const requireValid = (
  validation: WorkflowValidation,
): validation is WorkflowValidation & { ir: WorkflowIr; boundPlan: WorkflowBoundPlan; sourceHash: string } =>
  validation.valid && validation.ir !== null && validation.boundPlan !== null && validation.sourceHash !== null;

const recordWorkflowResult = <T>(params: {
  action: string;
  context: MailRequestContext;
  mailboxId: string;
  workflowId: string;
  versionId?: string | null;
  sourceHash?: string | null;
  result: Result<T>;
  db?: SqlClient;
}): Promise<Result<T>> =>
  audit.recordResult({
    action: params.action,
    actor: auditActorFromRequest(params.context),
    target: { type: "workflow", id: params.workflowId },
    requestId: params.context.requestId,
    metadata: {
      mailboxId: params.mailboxId,
      versionId: params.versionId ?? null,
      sourceHash: params.sourceHash ?? null,
    },
    result: params.result,
    db: params.db,
  });

export const replaceManagedWorkflowInTransaction = async (params: {
  db: SqlClient;
  context: MailRequestContext;
  mailboxId: string;
  workflowId: string | null;
  name: string;
  description: string;
  priority: number;
  managedBy: ManagedWorkflowOwner;
  source: string;
  effectBudget: WorkflowEffectBudget;
  enabled: boolean;
}): Promise<Result<MailWorkflowDetail>> => {
  const validation = await validateMailWorkflowSource(params);
  if (!requireValid(validation)) return fail(err.badInput(validation.diagnostics[0]?.message ?? "Managed workflow source is invalid"));
  const actor = creator(params.context);
  let workflowId = params.workflowId;
  if (workflowId) {
    const workflow = await loadWorkflowRow(params.mailboxId, workflowId, params.db, true);
    if (!workflow) return fail(err.notFound("Workflow"));
    if (workflow.managed_by !== params.managedBy) return fail(err.conflict("Workflow manager changed"));
    await renameWorkflow(workflowId, { name: params.name, description: params.description }, { db: params.db });
  } else {
    const workflow = await createKernelWorkflow(
      {
        appId: MAIL_WORKFLOW_APP_ID,
        scopeId: params.mailboxId,
        key: crypto.randomUUID(),
        name: params.name,
        description: params.description,
        author: actor,
      },
      { db: params.db },
    );
    workflowId = workflow.id;
    await params.db`
      INSERT INTO mail.workflow_profile (id, mailbox_id, priority, enabled, managed_by)
      VALUES (
        ${workflowId}::uuid,
        ${params.mailboxId}::uuid,
        ${params.priority},
        ${params.enabled},
        ${params.managedBy}
      )
    `;
  }
  await params.db`
    UPDATE mail.workflow_profile
    SET priority = ${params.priority}, enabled = ${params.enabled}
    WHERE id = ${workflowId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
  `;
  await publish({
    db: params.db,
    workflowId,
    validation,
    effectBudget: params.effectBudget,
    actor,
    authorization: snapshotMailboxWorkflowAuthorization(params.context, params.mailboxId),
    enabled: params.enabled,
  });
  const detail = await loadWorkflowDetail(params.mailboxId, workflowId, params.db);
  return detail ? ok(detail) : fail(err.internal("Managed workflow could not be reloaded"));
};

export const setManagedWorkflowEnabledInTransaction = async (params: {
  db: SqlClient;
  context: MailRequestContext;
  mailboxId: string;
  workflowId: string;
  enabled: boolean;
}): Promise<Result<MailWorkflowDetail>> => {
  const workflow = await loadWorkflowRow(params.mailboxId, params.workflowId, params.db, true);
  if (!workflow) return fail(err.notFound("Workflow"));
  await params.db`
    UPDATE mail.workflow_profile SET enabled = ${params.enabled}
    WHERE id = ${params.workflowId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
  `;
  await params.db`
    UPDATE workflows.activation SET enabled = ${params.enabled}, updated_at = now()
    WHERE workflow_id = ${params.workflowId}::uuid
  `;
  const detail = await loadWorkflowDetail(params.mailboxId, params.workflowId, params.db);
  return detail ? ok(detail) : fail(err.internal("Managed workflow could not be reloaded"));
};

export const listWorkflows = async (context: MailRequestContext, mailboxId: string): Promise<Result<MailWorkflow[]>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const rows = await sql<DbWorkflow[]>`
    SELECT ${WORKFLOW_SELECT}
    ${WORKFLOW_FROM}
    WHERE profile.mailbox_id = ${mailboxId}::uuid
      AND profile.managed_by IS NULL
    ORDER BY profile.priority, lower(workflow.name), workflow.id
    LIMIT 200
  `;
  return ok(rows.map(mapWorkflow));
};

export const getWorkflow = async (
  context: MailRequestContext,
  mailboxId: string,
  workflowId: string,
): Promise<Result<MailWorkflowDetail>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const visible = await rejectManagedWorkflow(mailboxId, workflowId, sql, true);
  if (!visible.ok) return visible;
  const workflow = await loadWorkflowDetail(mailboxId, workflowId);
  return workflow ? ok(workflow) : fail(err.notFound("Workflow"));
};

export const listWorkflowVersions = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  workflowId: string;
}): Promise<Result<MailWorkflowVersion[]>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const visible = await rejectManagedWorkflow(params.mailboxId, params.workflowId, sql, true);
  if (!visible.ok) return visible;
  const rows = await sql<DbWorkflowVersion[]>`
    SELECT ${VERSION_SELECT}
    ${VERSION_FROM}
    WHERE profile.mailbox_id = ${params.mailboxId}::uuid
      AND version.workflow_id = ${params.workflowId}::uuid
    ORDER BY version.revision DESC
    LIMIT 200
  `;
  return rows.length ? ok(rows.map(mapWorkflowVersion)) : fail(err.notFound("Workflow"));
};

export const getWorkflowVersion = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  workflowId: string;
  versionId: string;
}): Promise<Result<MailWorkflowVersion>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const visible = await rejectManagedWorkflow(params.mailboxId, params.workflowId, sql, true);
  if (!visible.ok) return visible;
  const version = await loadWorkflowVersion(params);
  return version ? ok(mapWorkflowVersion(version)) : fail(err.notFound("Workflow version"));
};

export const createWorkflow = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: CreateWorkflowInput;
}): Promise<Result<MailWorkflowDetail>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!allowed.ok) return allowed;
  try {
    return await sql.begin(async (tx) => {
      const currentPermission = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!currentPermission.ok) return currentPermission;
      const validation = await validateMailWorkflowSource({ ...params, source: params.input.source, db: tx });
      if (!requireValid(validation)) return fail(err.badInput(validation.diagnostics[0]?.message ?? "Workflow source is invalid"));
      const actor = creator(params.context);
      const workflow = await createKernelWorkflow(
        {
          appId: MAIL_WORKFLOW_APP_ID,
          scopeId: params.mailboxId,
          key: crypto.randomUUID(),
          name: params.input.name,
          description: params.input.description ?? undefined,
          author: actor,
        },
        { db: tx },
      );
      await tx`
        INSERT INTO mail.workflow_profile (id, mailbox_id, priority, enabled)
        VALUES (${workflow.id}::uuid, ${params.mailboxId}::uuid, ${params.input.priority}, false)
      `;
      const version = await publishWorkflowVersion(
        {
          workflowId: workflow.id,
          source: validation.source,
          plan: validation.boundPlan,
          diagnostics: validation.diagnostics,
          effectBudget: params.input.effectBudget,
          activations: [],
          activate: false,
          author: actor,
        },
        { db: tx },
      );
      await audit.record(
        {
          action: "mail.workflow.create",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "workflow", id: workflow.id },
          requestId: params.context.requestId,
          metadata: { mailboxId: params.mailboxId, versionId: version.id, sourceHash: validation.sourceHash },
        },
        tx,
      );
      const detail = await loadWorkflowDetail(params.mailboxId, workflow.id, tx);
      if (!detail) throw new Error("Created workflow could not be reloaded");
      return ok(detail);
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return fail(err.conflict("Workflow name"));
    return isServiceError(error) ? fail(error) : fail(err.internal("Failed to create workflow"));
  }
};

export const createWorkflowVersion = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  workflowId: string;
  input: CreateWorkflowVersionInput;
}): Promise<Result<MailWorkflowDetail>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!allowed.ok) return allowed;
  try {
    return await sql.begin(async (tx) => {
      const currentPermission = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!currentPermission.ok) return currentPermission;
      if (!(await loadWorkflowRow(params.mailboxId, params.workflowId, tx, true))) return fail(err.notFound("Workflow"));
      const editable = await rejectManagedWorkflow(params.mailboxId, params.workflowId, tx, false);
      if (!editable.ok) return editable;
      const validation = await validateMailWorkflowSource({ ...params, source: params.input.source, db: tx });
      if (!requireValid(validation)) return fail(err.badInput(validation.diagnostics[0]?.message ?? "Workflow source is invalid"));
      const version = await publishWorkflowVersion(
        {
          workflowId: params.workflowId,
          source: validation.source,
          plan: validation.boundPlan,
          diagnostics: validation.diagnostics,
          effectBudget: params.input.effectBudget,
          activations: [],
          activate: false,
          author: creator(params.context),
        },
        { db: tx },
      );
      await audit.record(
        {
          action: "mail.workflow.version.create",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "workflow", id: params.workflowId },
          requestId: params.context.requestId,
          metadata: { mailboxId: params.mailboxId, versionId: version.id, sourceHash: validation.sourceHash },
        },
        tx,
      );
      const detail = await loadWorkflowDetail(params.mailboxId, params.workflowId, tx);
      if (!detail) throw new Error("Versioned workflow could not be reloaded");
      return ok(detail);
    });
  } catch (error) {
    return isServiceError(error) ? fail(error) : fail(err.internal("Failed to create workflow version"));
  }
};

export const updateWorkflowMetadata = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  workflowId: string;
  input: UpdateWorkflowMetadataInput;
}): Promise<Result<MailWorkflowDetail>> => {
  const auditBase = {
    action: "mail.workflow.metadata.update",
    context: params.context,
    mailboxId: params.mailboxId,
    workflowId: params.workflowId,
  };
  try {
    return await sql.begin(async (tx) => {
      const finish = <T>(result: Result<T>) => recordWorkflowResult({ ...auditBase, result, db: tx });
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!allowed.ok) return finish(allowed);
      const workflow = await loadWorkflowRow(params.mailboxId, params.workflowId, tx, true);
      if (!workflow) return finish(fail(err.notFound("Workflow")));
      const editable = await rejectManagedWorkflow(params.mailboxId, params.workflowId, tx, false);
      if (!editable.ok) return finish(editable);
      if (toIso(workflow.updated_at) !== params.input.expectedUpdatedAt) {
        return finish(fail(err.conflict("Workflow metadata changed before update")));
      }
      await renameWorkflow(
        params.workflowId,
        {
          name: params.input.name ?? workflow.name,
          description: params.input.description === undefined ? workflow.description : params.input.description,
        },
        { db: tx },
      );
      await tx`
        UPDATE mail.workflow_profile
        SET priority = ${params.input.priority ?? workflow.priority}, updated_at = now()
        WHERE id = ${params.workflowId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
      `;
      const detail = await loadWorkflowDetail(params.mailboxId, params.workflowId, tx);
      return finish(detail ? ok(detail) : fail(err.internal("Updated workflow could not be reloaded")));
    });
  } catch (error) {
    const result =
      (error as { code?: string }).code === "23505" ? fail(err.conflict("Workflow name")) : fail(err.internal("Failed to update workflow"));
    return recordWorkflowResult({ ...auditBase, result });
  }
};

export const restoreWorkflowVersion = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  workflowId: string;
  versionId: string;
  input: RestoreWorkflowVersionInput;
}): Promise<Result<MailWorkflowDetail>> => {
  const auditBase = {
    action: "mail.workflow.version.restore",
    context: params.context,
    mailboxId: params.mailboxId,
    workflowId: params.workflowId,
    versionId: params.versionId,
  };
  try {
    return await sql.begin(async (tx) => {
      let sourceHash: string | null = null;
      const finish = <T>(result: Result<T>) => recordWorkflowResult({ ...auditBase, sourceHash, result, db: tx });
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!allowed.ok) return finish(allowed);
      const workflow = await loadWorkflowRow(params.mailboxId, params.workflowId, tx, true);
      if (!workflow) return finish(fail(err.notFound("Workflow")));
      const editable = await rejectManagedWorkflow(params.mailboxId, params.workflowId, tx, false);
      if (!editable.ok) return finish(editable);
      if (workflow.current_version_id !== params.input.expectedCurrentVersionId) {
        return finish(fail(err.conflict("Workflow version changed before restore")));
      }
      const historical = await loadWorkflowVersion({ ...params, db: tx, lock: true });
      if (!historical) return finish(fail(err.notFound("Workflow version")));
      sourceHash = historical.source_hash;
      const validation = await validateMailWorkflowSource({ ...params, source: historical.source, db: tx });
      if (!requireValid(validation)) {
        return finish(fail(err.badInput(validation.diagnostics[0]?.message ?? "Historical workflow source is no longer valid")));
      }
      const version = await publishWorkflowVersion(
        {
          workflowId: params.workflowId,
          source: historical.source,
          plan: validation.boundPlan,
          diagnostics: validation.diagnostics,
          effectBudget: parseJson(historical.effect_budget),
          activations: [],
          activate: false,
          author: creator(params.context),
        },
        { db: tx },
      );
      sourceHash = version.sourceHash;
      const detail = await loadWorkflowDetail(params.mailboxId, params.workflowId, tx);
      return finish(detail ? ok(detail) : fail(err.internal("Restored workflow could not be reloaded")));
    });
  } catch {
    const result = fail(err.internal("Failed to restore workflow version"));
    return recordWorkflowResult({ ...auditBase, result });
  }
};

const activateVersion = async (params: {
  db: SqlClient;
  context: MailRequestContext;
  mailboxId: string;
  workflowId: string;
  version: DbWorkflowVersion;
  enabled: boolean;
}): Promise<void> => {
  const plan = parseJson(params.version.plan);
  const snapshot = snapshotMailboxWorkflowAuthorization(params.context, params.mailboxId);
  await params.db`DELETE FROM workflows.activation WHERE workflow_id = ${params.workflowId}::uuid`;
  for (const activation of workflowTriggerRegistrations(plan, params.enabled)) {
    await params.db`
      INSERT INTO workflows.activation (
        workflow_id, workflow_version_id, key, event_type, config, authorization_snapshot, enabled
      ) VALUES (
        ${params.workflowId}::uuid, ${params.version.id}::uuid, ${activation.key}, ${activation.eventType},
        ${activation.config ?? {}}::jsonb, ${snapshot}::jsonb, ${params.enabled}
      )
    `;
  }
  await params.db`
    UPDATE workflows.workflow
    SET active_version_id = ${params.version.id}::uuid, updated_at = now()
    WHERE id = ${params.workflowId}::uuid
  `;
  await params.db`
    UPDATE mail.workflow_profile SET enabled = ${params.enabled}
    WHERE id = ${params.workflowId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
  `;
};

export const activateWorkflow = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  workflowId: string;
  input: ActivateWorkflowInput;
}): Promise<Result<MailWorkflowDetail>> => {
  const auditBase = {
    action: "mail.workflow.activate",
    context: params.context,
    mailboxId: params.mailboxId,
    workflowId: params.workflowId,
    versionId: params.input.expectedVersionId,
  };
  try {
    return await sql.begin(async (tx) => {
      let sourceHash: string | null = null;
      const finish = <T>(result: Result<T>) => recordWorkflowResult({ ...auditBase, sourceHash, result, db: tx });
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!allowed.ok) return finish(allowed);
      const workflow = await loadWorkflowRow(params.mailboxId, params.workflowId, tx, true);
      if (!workflow) return finish(fail(err.notFound("Workflow")));
      const editable = await rejectManagedWorkflow(params.mailboxId, params.workflowId, tx, false);
      if (!editable.ok) return finish(editable);
      if (workflow.current_version_id !== params.input.expectedVersionId) {
        return finish(fail(err.conflict("Workflow version changed before activation")));
      }
      const version = await loadWorkflowVersion({ ...params, versionId: params.input.expectedVersionId, db: tx });
      if (!version) return finish(fail(err.notFound("Workflow version")));
      sourceHash = version.source_hash;
      const activationError = workflowActivationError(parseJson(version.plan));
      if (activationError) return finish(fail(err.badInput(activationError)));
      await activateVersion({ ...params, db: tx, version, enabled: true });
      const detail = await loadWorkflowDetail(params.mailboxId, params.workflowId, tx);
      return finish(detail ? ok(detail) : fail(err.internal("Activated workflow could not be reloaded")));
    });
  } catch {
    const result = fail(err.internal("Failed to activate workflow"));
    return recordWorkflowResult({ ...auditBase, result });
  }
};

export const deactivateWorkflow = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  workflowId: string;
  input: DeactivateWorkflowInput;
}): Promise<Result<MailWorkflowDetail>> => {
  const auditBase = {
    action: "mail.workflow.deactivate",
    context: params.context,
    mailboxId: params.mailboxId,
    workflowId: params.workflowId,
    versionId: params.input.expectedVersionId,
  };
  try {
    return await sql.begin(async (tx) => {
      let sourceHash: string | null = null;
      const finish = <T>(result: Result<T>) => recordWorkflowResult({ ...auditBase, sourceHash, result, db: tx });
      const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!allowed.ok) return finish(allowed);
      const workflow = await loadWorkflowRow(params.mailboxId, params.workflowId, tx, true);
      if (!workflow) return finish(fail(err.notFound("Workflow")));
      const editable = await rejectManagedWorkflow(params.mailboxId, params.workflowId, tx, false);
      if (!editable.ok) return finish(editable);
      if (workflow.active_version_id !== params.input.expectedVersionId) {
        return finish(fail(err.conflict("Workflow activation changed before deactivation")));
      }
      const version = await loadWorkflowVersion({ ...params, versionId: params.input.expectedVersionId, db: tx });
      if (!version) return finish(fail(err.notFound("Workflow version")));
      sourceHash = version.source_hash;
      await tx`UPDATE workflows.activation SET enabled = false, updated_at = now() WHERE workflow_id = ${params.workflowId}::uuid`;
      await tx`
        UPDATE mail.workflow_profile SET enabled = false
        WHERE id = ${params.workflowId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
      `;
      const detail = await loadWorkflowDetail(params.mailboxId, params.workflowId, tx);
      return finish(detail ? ok(detail) : fail(err.internal("Deactivated workflow could not be reloaded")));
    });
  } catch {
    const result = fail(err.internal("Failed to deactivate workflow"));
    return recordWorkflowResult({ ...auditBase, result });
  }
};
