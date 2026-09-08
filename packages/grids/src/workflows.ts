/**
 * What Grids brings to the workflow kernel: domain actions, and nothing else.
 *
 * Each is one declaration. The config schema drives the language, the editor
 * form and the implementation's parameter type at once, so a change to either
 * side is a compile error rather than a production surprise — where before a
 * descriptor, a binder and an implementation could disagree and only fail at
 * run time.
 *
 * The effect class is the promise each action makes about a replay after a
 * crash. Record writes and link creation commit inside the journal's own
 * transaction, so a crash means they did not happen. Documents and email are
 * external but keyed, so a repeat under the same key is safe. An HTTP request
 * to somebody else's service is neither: nothing here can ask afterwards
 * whether it arrived, so an interrupted one waits for a human instead of being
 * sent twice.
 */

import type { DateContext } from "@k2b/stdlib";
import { get as settingsGet } from "@valentinkolb/cloud/services/settings";
import { normalizeTimeZone } from "@valentinkolb/cloud/shared";
import type { WorkflowActionContext, WorkflowActionResult, WorkflowJsonValue, WorkflowPlannedEffect } from "@valentinkolb/cloud/workflows";
import { workflowAction } from "@valentinkolb/cloud/workflows";
import { sql } from "bun";
import type { RecordMutationAudit, Table } from "./contracts";
import { logAudit, type SqlClient } from "./service/audit";
import type { DocumentIssuanceActor } from "./service/document-issuance";
import { summarizeDocument } from "./service/document-mappers";
import {
  createDocumentForRecord,
  createDocumentLink,
  getDocument,
  getStoredTemplate,
  getTemplate,
  publicDocumentLinkBaseUrl,
} from "./service/documents";
import { get as getEmailTemplate } from "./service/email-templates";
import { listByTable as listFields } from "./service/field-read";
import { assertMutationAllowed } from "./service/mutation-policy";
import {
  finalizeInTransaction as finalizeRecordInTransaction,
  getStatus as getRecordFinalizationStatus,
  inspect as inspectRecordFinalization,
  requestFinalizationInTransaction,
} from "./service/record-finalization";
import { createInTransaction as createRecordInTransaction, updateInTransaction as updateRecordInTransaction } from "./service/record-write";
import { get as getRecord } from "./service/records";
import { get as getTable } from "./service/tables";
import {
  actionError,
  actorId,
  canAccessWorkflowRunTable,
  canExecuteRun,
  GridsWorkflowActionError,
  type GridsWorkflowActionScope,
  requireExecution,
  requireOk,
  requirePermission,
  requireTableAccess,
  workflowAuditMeta,
  workflowRunScope,
} from "./service/workflow-action-scope";
import {
  type AtomicQueryPredicate,
  type AtomicRecordRef,
  atomicQueryMatches,
  lockAtomicRecords,
  requireWorkflowTable,
  resolveWorkflowRecordValues,
} from "./service/workflow-atomic-records";
import { sendWorkflowEmail, type WorkflowEmailRecipient } from "./service/workflow-email-send";
import { preflightWorkflowHttp, requestWorkflowHttp } from "./service/workflow-http-client";
import { workflowInvocationLocale, workflowRuntimeText } from "./workflow-runtime-messages";
import { GRIDS_WORKFLOW_ACTION_METADATA } from "./workflows/action-metadata";
import { isCorrectionPrefillFieldType, MAX_CORRECTION_PREFILL_FIELDS } from "./workflows/contracts";

// ─── Shared config fragments ─────────────────────────────────────────────────

// ─── Runtime values ──────────────────────────────────────────────────────────

/** What a `grids.record` reference resolves to while a plan runs. */
type RuntimeRecord = { kind: "record"; tableId: string; recordId: string; planned?: boolean };

const isRuntimeRecord = (value: WorkflowJsonValue | undefined): value is RuntimeRecord =>
  Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.kind === "record" &&
      typeof value.tableId === "string" &&
      typeof value.recordId === "string",
  );

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const invocationLocale = (ctx: WorkflowActionContext): string => {
  return workflowInvocationLocale(ctx.invocation.context);
};

const runtimeText = (ctx: WorkflowActionContext) => workflowRuntimeText(invocationLocale(ctx));

const dateContext = async (ctx: WorkflowActionContext): Promise<DateContext> => ({
  timeZone: normalizeTimeZone(String((await settingsGet<string>("app.timezone")) || "").trim(), "UTC"),
  locale: invocationLocale(ctx),
  firstDayOfWeek: 1,
});

const viewerForScope = (scope: GridsWorkflowActionScope) => ({
  userId: scope.principal.userId,
  userGroups: scope.principal.groupIds,
  serviceAccountId: scope.principal.serviceAccountId,
});

const documentActorForScope = (scope: GridsWorkflowActionScope): DocumentIssuanceActor => {
  const serviceAccountId = scope.principal.actorServiceAccountId ?? scope.principal.serviceAccountId;
  if (serviceAccountId) {
    return {
      kind: "service_account",
      serviceAccountId,
      delegatedUserId: scope.principal.userId,
      credentialId: scope.principal.credential?.id ?? null,
    };
  }
  return scope.principal.userId ? { kind: "user", userId: scope.principal.userId } : { kind: "system" };
};

/**
 * Domain refusals are results, not exceptions.
 *
 * "The template was deleted" is an answer about this step; letting it escape
 * would abandon the run to the job's retry loop, which cannot help. The code
 * travels with it so the run view can say which refusal it was.
 */
const attempt = async <T>(run: () => Promise<WorkflowActionResult<T>>): Promise<WorkflowActionResult<T>> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GridsWorkflowActionError) {
      return { state: "failed", message: error.message, code: error.code, retryable: error.retryable };
    }
    throw error;
  }
};

/** The same, for a dry run: what could not be determined is reported, not thrown. */
const planned = async (run: () => Promise<WorkflowPlannedEffect>): Promise<WorkflowPlannedEffect> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GridsWorkflowActionError) return { summary: error.message, issues: [error.message] };
    throw error;
  }
};

// ─── Resolving what a step names ─────────────────────────────────────────────

const currentTable = async (ctx: WorkflowActionContext, scope: GridsWorkflowActionScope, tableId: string): Promise<Table> => {
  const table = await getTable(tableId);
  if (!table || table.baseId !== scope.baseId) throw actionError("NOT_FOUND", runtimeText(ctx).tableUnavailable);
  return table;
};

const recordReference = async (ctx: WorkflowActionContext, reference: string, key: string): Promise<RuntimeRecord> => {
  const value = await ctx.resolveReference(reference, key);
  if (!isRuntimeRecord(value)) throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).recordReferenceRequired({ path: key }));
  return value;
};

/**
 * Reads a record after checking the actor may, and confirms it still exists.
 *
 * A planned record has no row yet — a dry run of "create then update" is a
 * legitimate plan — so it validates access and stops there.
 */
const readableRecord = async (
  ctx: WorkflowActionContext,
  scope: GridsWorkflowActionScope,
  reference: RuntimeRecord,
  required: "read" | "write",
): Promise<void> => {
  await currentTable(ctx, scope, reference.tableId);
  await requireTableAccess(scope, reference.tableId, required);
  if (reference.planned) return;
  const record = await getRecord(reference.tableId, reference.recordId, {
    includeRelations: true,
    dateConfig: await dateContext(ctx),
  });
  if (!record) throw actionError("NOT_FOUND", runtimeText(ctx).recordUnavailable);
};

/**
 * Field values keyed by the field ids the compiler pinned.
 *
 * The source names a field the way a person wrote it; publishing resolved that
 * to an id. Passing the written name through would follow a rename onto a
 * different field, or onto none.
 */
const fieldPayloadAt = (
  ctx: WorkflowActionContext,
  path: Array<string | number>,
  values: Record<string, WorkflowJsonValue>,
): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(values)) {
    const fieldId = ctx.binding(...path, field);
    if (typeof fieldId !== "string" || !fieldId) {
      throw actionError("WORKFLOW_BINDING_MISSING", runtimeText(ctx).stableBindingMissing({ path: [...path, field].join(".") }));
    }
    payload[fieldId] = value;
  }
  return payload;
};

const atomicFieldPayloadAt = (
  ctx: WorkflowActionContext,
  path: Array<string | number>,
  values: Record<string, WorkflowJsonValue>,
): Record<string, unknown> => {
  const payload: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(values)) {
    const fieldId = ctx.binding(...path, field, "$target");
    if (typeof fieldId !== "string" || !fieldId) {
      throw actionError("WORKFLOW_BINDING_MISSING", runtimeText(ctx).stableTargetBindingMissing({ path: [...path, field].join(".") }));
    }
    payload[fieldId] = value;
  }
  return payload;
};

const fieldPayload = (
  ctx: WorkflowActionContext,
  key: "set" | "values",
  values: Record<string, WorkflowJsonValue>,
): Record<string, unknown> => fieldPayloadAt(ctx, [key], values);

const correctionDraftValues = async (
  ctx: WorkflowActionContext,
  client: SqlClient,
  tableId: string,
  typeFieldId: string,
  typeValue: string,
  originalFieldId: string,
  originalRecordId: string,
  copyFieldIds: string[],
): Promise<Record<string, unknown>> => {
  const fields = await listFields(tableId, false, client);
  const typeField = fields.find((field) => field.id === typeFieldId);
  const originalField = fields.find((field) => field.id === originalFieldId);
  const typeConfig = typeField?.config as { multiple?: unknown; options?: unknown } | undefined;
  const options = Array.isArray(typeConfig?.options) ? typeConfig.options : [];
  const typeValueExists = options.some(
    (option) => option && typeof option === "object" && !Array.isArray(option) && (option as { id?: unknown }).id === typeValue,
  );
  if (typeField?.type !== "select" || typeConfig?.multiple === true || !typeValueExists) {
    throw actionError("WORKFLOW_BINDING_INVALID", runtimeText(ctx).correctionTypeInvalid);
  }
  const relationConfig = originalField?.config as { targetTableId?: unknown; cardinality?: unknown } | undefined;
  if (
    originalField?.type !== "relation" ||
    relationConfig?.targetTableId !== tableId ||
    (relationConfig.cardinality ?? "multiple") !== "single"
  ) {
    throw actionError("WORKFLOW_BINDING_INVALID", runtimeText(ctx).originalRelationInvalid);
  }
  if (copyFieldIds.length > MAX_CORRECTION_PREFILL_FIELDS || new Set(copyFieldIds).size !== copyFieldIds.length) {
    throw actionError("WORKFLOW_BINDING_INVALID", runtimeText(ctx).correctionPrefillLimit({ count: MAX_CORRECTION_PREFILL_FIELDS }));
  }
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  for (const fieldId of copyFieldIds) {
    const field = fieldsById.get(fieldId);
    if (!field || !isCorrectionPrefillFieldType(field.type) || field.uniqueConstraint) {
      throw actionError("WORKFLOW_BINDING_INVALID", runtimeText(ctx).correctionPrefillFieldsInvalid);
    }
    if (fieldId === typeFieldId || fieldId === originalFieldId) {
      throw actionError("WORKFLOW_BINDING_INVALID", runtimeText(ctx).correctionPrefillReservedFields);
    }
  }
  const [original] = await client<Array<{ data: Record<string, unknown> }>>`
    SELECT data
    FROM grids.records
    WHERE id = ${originalRecordId}::uuid AND table_id = ${tableId}::uuid
      AND deleted_at IS NULL AND finalized_at IS NOT NULL
  `;
  if (!original) throw actionError("CONFLICT", runtimeText(ctx).originalUnavailable);
  const values = Object.fromEntries(
    copyFieldIds.map((fieldId) => {
      const field = fieldsById.get(fieldId)!;
      const value = original.data[fieldId];
      return [fieldId, field.type === "json" && typeof value === "string" ? JSON.stringify(value) : (value ?? null)];
    }),
  );
  return { ...values, [typeFieldId]: [typeValue], [originalFieldId]: originalRecordId };
};

const correctionCopyFieldIds = (ctx: WorkflowActionContext, copyFields: string[] | undefined): string[] =>
  (copyFields ?? []).map((_, index) => {
    const id = ctx.binding("copyFields", index);
    if (typeof id !== "string" || !id) {
      throw actionError("WORKFLOW_BINDING_MISSING", runtimeText(ctx).stableBindingMissing({ path: `copyFields.${index}` }));
    }
    return id;
  });

const auditAnswerPayload = (
  ctx: WorkflowActionContext,
  answers: Record<string, WorkflowJsonValue> | undefined,
): RecordMutationAudit | undefined => {
  if (answers === undefined) return undefined;
  const resolved: Record<string, string> = {};
  for (const [questionId, value] of Object.entries(answers)) {
    if (typeof value !== "string") {
      throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).auditTextRequired({ path: `audit.${questionId}` }));
    }
    resolved[questionId] = value;
  }
  return { answers: resolved };
};

const boundId = (ctx: WorkflowActionContext, key: string): string => {
  const id = ctx.binding(key);
  if (typeof id !== "string" || !id) {
    throw actionError("WORKFLOW_BINDING_MISSING", runtimeText(ctx).stableBindingMissing({ path: key }));
  }
  return id;
};

const boundIdAt = (ctx: WorkflowActionContext, path: Array<string | number>): string => {
  const id = ctx.binding(...path);
  if (typeof id !== "string" || !id) {
    throw actionError("WORKFLOW_BINDING_MISSING", runtimeText(ctx).stableBindingMissing({ path: path.join(".") }));
  }
  return id;
};

// ─── Helpers that more than one action needs ─────────────────────────────────

/**
 * Whether this run may still execute, as the boolean the kernel asks for.
 *
 * Only the run-level question, deliberately: an `authorize` hook cannot report
 * why it said no, so anything that could fail for a reason other than access —
 * a deleted template, an unresolvable reference — belongs in `run`, where the
 * refusal keeps its own code.
 */
const mayExecute = async (ctx: WorkflowActionContext): Promise<boolean> => {
  try {
    return await canExecuteRun(await workflowRunScope(ctx));
  } catch (error) {
    if (error instanceof GridsWorkflowActionError) return false;
    throw error;
  }
};

/**
 * The transaction a transactional action commits in.
 *
 * Always present for that class — the kernel opens it — but the context type
 * cannot say so, and doing the work on the ambient connection would silently
 * void the class's whole promise.
 */
const transaction = (ctx: WorkflowActionContext): SqlClient => {
  if (!ctx.tx) throw actionError("WORKFLOW_EFFECT_INVALID", runtimeText(ctx).transactionMissing);
  return ctx.tx;
};

const documentTemplate = async (ctx: WorkflowActionContext, resume = false) => {
  const template = await (resume ? getStoredTemplate : getTemplate)(boundId(ctx, "template"));
  if (!template || (!resume && !template.enabled)) throw actionError("NOT_FOUND", runtimeText(ctx).documentTemplateUnavailable);
  return template;
};

const documentRecord = async (
  ctx: WorkflowActionContext,
  scope: GridsWorkflowActionScope,
  tableId: string,
  reference: string,
  required: "read" | "write",
): Promise<RuntimeRecord> => {
  const record = await recordReference(ctx, reference, "record");
  if (record.tableId !== tableId) throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).documentRecordWrongTable);
  await readableRecord(ctx, scope, record, required);
  return record;
};

const documentTags = (tags: WorkflowJsonValue[] | undefined): string[] =>
  (tags ?? []).flatMap((tag) => (typeof tag === "string" && tag.trim() ? [tag.trim()] : []));

const linkExpiry = (value: string | undefined): "1d" | "7d" | "30d" | "90d" =>
  value === "1d" || value === "7d" || value === "30d" || value === "90d" ? value : "30d";

type LinkableDocument = { id: string; baseId: string; tableId: string; templateId: string | null; recordId: string };

const documentReferenceId = (
  ctx: WorkflowActionContext,
  value: WorkflowJsonValue | undefined,
): { id: string; document: Record<string, WorkflowJsonValue> } => {
  const document = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!document || typeof document.id !== "string") {
    throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).documentReferenceRequired);
  }
  return { id: document.id, document };
};

/** The document a link is created for. It has to exist: the link points at it. */
const documentToLink = async (ctx: WorkflowActionContext, scope: GridsWorkflowActionScope, reference: string) => {
  const { id } = documentReferenceId(ctx, await ctx.resolveReference(reference, "document"));
  const document = await getDocument(id);
  if (!document || document.baseId !== scope.baseId) throw actionError("NOT_FOUND", runtimeText(ctx).generatedDocumentUnavailable);
  return document;
};

/**
 * The same for a dry run, which accepts the placeholder an earlier
 * `generateDocument` planned — so "generate then link" stays a plannable pair
 * rather than dead-ending at the first step that has not really run.
 */
const plannedDocumentToLink = async (
  ctx: WorkflowActionContext,
  scope: GridsWorkflowActionScope,
  reference: string,
): Promise<LinkableDocument> => {
  const { id, document: referenceDocument } = documentReferenceId(ctx, await ctx.resolveReference(reference, "document"));
  if (
    referenceDocument.planned === true &&
    typeof referenceDocument.tableId === "string" &&
    typeof referenceDocument.recordId === "string"
  ) {
    return {
      id,
      baseId: scope.baseId,
      tableId: referenceDocument.tableId,
      templateId: typeof referenceDocument.templateId === "string" ? referenceDocument.templateId : null,
      recordId: referenceDocument.recordId,
    };
  }
  const document = await getDocument(id);
  if (!document || document.baseId !== scope.baseId) throw actionError("NOT_FOUND", runtimeText(ctx).generatedDocumentUnavailable);
  return document;
};

const emailInput = async (
  ctx: WorkflowActionContext,
  scope: GridsWorkflowActionScope,
  config: { template: string; to: Array<{ email?: WorkflowJsonValue } | { user?: WorkflowJsonValue }> },
) => {
  const template = await getEmailTemplate(boundId(ctx, "template"));
  if (!template || template.baseId !== scope.baseId || !template.enabled) {
    throw actionError("NOT_FOUND", runtimeText(ctx).emailTemplateUnavailable);
  }
  const recipients: WorkflowEmailRecipient[] = [];
  for (const item of config.to) {
    const kind = "email" in item ? "email" : "user";
    const raw = kind === "email" ? (item as { email?: WorkflowJsonValue }).email : (item as { user?: WorkflowJsonValue }).user;
    if (typeof raw !== "string" || !raw.trim()) {
      throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).emailTextRequired({ path: `sendEmail.${kind}` }));
    }
    const value = raw.trim();
    if (kind === "email" && !EMAIL_RE.test(value)) {
      throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).emailAddressRequired);
    }
    if (kind === "user" && !UUID_RE.test(value)) {
      throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).cloudUserIdRequired);
    }
    recipients.push({ kind, value });
  }
  return { template, recipients };
};

const httpInput = (
  ctx: WorkflowActionContext,
  config: {
    url: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers?: Record<string, string>;
    json?: WorkflowJsonValue;
    timeoutMs?: number;
  },
) => {
  try {
    new URL(config.url);
  } catch {
    throw actionError("WORKFLOW_ACTION_INVALID", runtimeText(ctx).absoluteUrlRequired);
  }
  return {
    url: config.url,
    method: config.method ?? "POST",
    ...(config.headers ? { headers: config.headers } : {}),
    ...(config.json === undefined ? {} : { body: JSON.stringify(config.json) }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  };
};

// ─── Actions ─────────────────────────────────────────────────────────────────

export const GRIDS_WORKFLOW_ACTIONS = {
  closeRecord: workflowAction.transactional({
    ...GRIDS_WORKFLOW_ACTION_METADATA.closeRecord,

    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const record = await recordReference(ctx, config.record, "record");
        await currentTable(ctx, scope, record.tableId);
        await requireTableAccess(scope, record.tableId, "write", tx);
        requireOk(await assertMutationAllowed(tx, record.tableId, "workflow", invocationLocale(ctx)));
        const status = requireOk(await getRecordFinalizationStatus(record.tableId, tx));
        if (!status.enabled) throw actionError("BAD_INPUT", runtimeText(ctx).finalizationDisabled);
        const expectedPolicyRevision = config.expectedPolicyRevision
          ? await ctx.resolveReference(config.expectedPolicyRevision, "expectedPolicyRevision")
          : undefined;
        if (
          expectedPolicyRevision !== undefined &&
          (typeof expectedPolicyRevision !== "number" || !Number.isSafeInteger(expectedPolicyRevision) || expectedPolicyRevision < 1)
        ) {
          throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).positivePolicyRevisionRequired);
        }
        if (config.expectedMode) {
          const expectedMode = await ctx.resolveReference(config.expectedMode, "expectedMode");
          if (expectedMode !== "direct" && expectedMode !== "fourEyes") {
            throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).finalizationModeRequired);
          }
          if (status.mode !== expectedMode) {
            throw actionError("CONFLICT", runtimeText(ctx).finalizationModeChanged);
          }
        }

        if (status.mode === "fourEyes") {
          requireOk(
            await requestFinalizationInTransaction(tx, {
              tableId: record.tableId,
              recordId: record.recordId,
              actorId: actorId(scope),
              expectedPolicyRevision,
            }),
          );
          await logAudit(
            {
              baseId: scope.baseId,
              tableId: record.tableId,
              recordId: record.recordId,
              userId: actorId(scope),
              action: "workflow.record.finalization.requested",
              diff: { workflowRecordFinalizationRequest: { old: null, new: workflowAuditMeta(scope) } },
            },
            tx,
          );
        } else {
          requireOk(
            await finalizeRecordInTransaction(tx, {
              tableId: record.tableId,
              recordId: record.recordId,
              actorId: actorId(scope),
              origin: "workflow",
              dateConfig: await dateContext(ctx),
              expectedPolicyRevision,
            }),
          );
          await logAudit(
            {
              baseId: scope.baseId,
              tableId: record.tableId,
              recordId: record.recordId,
              userId: actorId(scope),
              action: "workflow.record.finalized",
              diff: { workflowRecordFinalization: { old: null, new: workflowAuditMeta(scope) } },
            },
            tx,
          );
        }
        return {
          state: "succeeded",
          output: { kind: "record", tableId: record.tableId, recordId: record.recordId } as WorkflowJsonValue,
          message: status.mode === "fourEyes" ? runtimeText(ctx).finalizationRequested : runtimeText(ctx).recordFinalized,
        };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const record = await recordReference(ctx, config.record, "record");
        await readableRecord(ctx, scope, record, "write");
        requireOk(await assertMutationAllowed(sql, record.tableId, "workflow", invocationLocale(ctx)));
        const readiness = requireOk(
          await inspectRecordFinalization({
            tableId: record.tableId,
            recordId: record.recordId,
            actorId: actorId(scope),
          }),
        );
        if (!readiness.enabled) throw actionError("BAD_INPUT", runtimeText(ctx).finalizationDisabled);
        if (config.expectedPolicyRevision) {
          const expectedPolicyRevision = await ctx.resolveReference(config.expectedPolicyRevision, "expectedPolicyRevision");
          if (typeof expectedPolicyRevision !== "number" || !Number.isSafeInteger(expectedPolicyRevision) || expectedPolicyRevision < 1) {
            throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).positivePolicyRevisionRequired);
          }
          if (readiness.policyRevision !== expectedPolicyRevision) {
            throw actionError("CONFLICT", runtimeText(ctx).finalizationPolicyChanged);
          }
        }
        if (config.expectedMode) {
          const expectedMode = await ctx.resolveReference(config.expectedMode, "expectedMode");
          if (expectedMode !== "direct" && expectedMode !== "fourEyes") {
            throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).finalizationModeRequired);
          }
          if (readiness.mode !== expectedMode) {
            throw actionError("CONFLICT", runtimeText(ctx).finalizationModeChanged);
          }
        }
        if (readiness.finalized) throw actionError("CONFLICT", runtimeText(ctx).recordAlreadyFinalized);
        if (readiness.missing.length > 0) {
          throw actionError(
            "BAD_INPUT",
            runtimeText(ctx).recordNotReady({ fields: readiness.missing.map((item) => item.fieldName).join(", ") }),
          );
        }
        return {
          summary: readiness.mode === "fourEyes" ? runtimeText(ctx).requestFourEyesFinalization : runtimeText(ctx).finalizeRecord,
          output: record as unknown as WorkflowJsonValue,
        };
      }),
  }),

  createCorrectionDraft: workflowAction.transactional({
    ...GRIDS_WORKFLOW_ACTION_METADATA.createCorrectionDraft,

    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const original = await recordReference(ctx, config.original, "original");
        if (original.planned) {
          throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).existingFinalizedRecordRequired({ path: "original" }));
        }
        await currentTable(ctx, scope, original.tableId);
        await requireTableAccess(scope, original.tableId, "write", tx);
        const readiness = requireOk(
          await inspectRecordFinalization({
            tableId: original.tableId,
            recordId: original.recordId,
            actorId: actorId(scope),
            client: tx,
          }),
        );
        if (!readiness.finalized) throw actionError("CONFLICT", runtimeText(ctx).finalizedRecordRequired);
        const values = await correctionDraftValues(
          ctx,
          tx,
          original.tableId,
          boundId(ctx, "typeField"),
          config.typeValue,
          boundId(ctx, "originalField"),
          original.recordId,
          correctionCopyFieldIds(ctx, config.copyFields),
        );
        const created = requireOk(
          await createRecordInTransaction(tx, original.tableId, values, actorId(scope), "workflow", {
            dateConfig: await dateContext(ctx),
            viewer: viewerForScope(scope),
          }),
        );
        await logAudit(
          {
            baseId: scope.baseId,
            tableId: original.tableId,
            recordId: created.record.id,
            userId: actorId(scope),
            action: "workflow.record.created",
            diff: { workflowCorrectionDraft: { old: null, new: workflowAuditMeta(scope) } },
          },
          tx,
        );
        return {
          state: "succeeded",
          output: { kind: "record", tableId: created.record.tableId, recordId: created.record.id } as WorkflowJsonValue,
          message: runtimeText(ctx).followUpDraftCreated,
        };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const original = await recordReference(ctx, config.original, "original");
        await readableRecord(ctx, scope, original, "write");
        requireOk(await assertMutationAllowed(sql, original.tableId, "workflow", invocationLocale(ctx)));
        await requireTableAccess(scope, original.tableId, "write");
        const readiness = requireOk(
          await inspectRecordFinalization({
            tableId: original.tableId,
            recordId: original.recordId,
            actorId: actorId(scope),
          }),
        );
        if (!readiness.finalized) throw actionError("CONFLICT", runtimeText(ctx).finalizedRecordRequired);
        await correctionDraftValues(
          ctx,
          sql,
          original.tableId,
          boundId(ctx, "typeField"),
          config.typeValue,
          boundId(ctx, "originalField"),
          original.recordId,
          correctionCopyFieldIds(ctx, config.copyFields),
        );
        return {
          summary: runtimeText(ctx).createFollowUpDraft,
          output: { kind: "record", tableId: original.tableId, recordId: `dry-run:${ctx.stepKey}`, planned: true },
        };
      }),
  }),

  finalizeRecord: workflowAction.transactional({
    ...GRIDS_WORKFLOW_ACTION_METADATA.finalizeRecord,

    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const record = await recordReference(ctx, config.record, "record");
        await currentTable(ctx, scope, record.tableId);
        await requireTableAccess(scope, record.tableId, "write", tx);
        const finalized = requireOk(
          await finalizeRecordInTransaction(tx, {
            tableId: record.tableId,
            recordId: record.recordId,
            actorId: actorId(scope),
            origin: "workflow",
            dateConfig: await dateContext(ctx),
          }),
        );
        await logAudit(
          {
            baseId: scope.baseId,
            tableId: record.tableId,
            recordId: record.recordId,
            userId: actorId(scope),
            action: "workflow.record.finalized",
            diff: { workflowRecordFinalization: { old: null, new: workflowAuditMeta(scope) } },
          },
          tx,
        );
        return {
          state: "succeeded",
          output: { kind: "record", tableId: finalized.record.tableId, recordId: finalized.record.id } as WorkflowJsonValue,
        };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const record = await recordReference(ctx, config.record, "record");
        await readableRecord(ctx, scope, record, "write");
        return { summary: runtimeText(ctx).finalizeRecord, output: record as unknown as WorkflowJsonValue };
      }),
  }),

  updateRecord: workflowAction.transactional({
    ...GRIDS_WORKFLOW_ACTION_METADATA.updateRecord,

    run: (ctx, config) =>
      attempt(async () => {
        // Every check is on the transaction's own handle. Access can be revoked
        // between the run being queued and this step running, and a check on
        // another connection is checking a world this write will not see.
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const record = await recordReference(ctx, config.record, "record");
        await currentTable(ctx, scope, record.tableId);
        await requireTableAccess(scope, record.tableId, "write", tx);
        const values = await resolveWorkflowRecordValues(
          scope,
          await listFields(record.tableId, false, tx),
          fieldPayload(ctx, "set", config.set),
          tx,
        );
        const audit = auditAnswerPayload(ctx, config.audit);
        const updated = requireOk(
          await updateRecordInTransaction(tx, record.tableId, record.recordId, values, actorId(scope), "workflow", undefined, {
            dateConfig: await dateContext(ctx),
            viewer: viewerForScope(scope),
            ...(audit ? { audit } : {}),
          }),
        );
        if (updated.outboxId) {
          await logAudit(
            {
              baseId: scope.baseId,
              tableId: record.tableId,
              recordId: record.recordId,
              userId: actorId(scope),
              action: "workflow.record.updated",
              diff: { workflowRecordUpdate: { old: null, new: { ...workflowAuditMeta(scope), fields: Object.keys(values) } } },
            },
            tx,
          );
        }
        return {
          state: "succeeded",
          output: { kind: "record", tableId: updated.record.tableId, recordId: updated.record.id } as WorkflowJsonValue,
        };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const record = await recordReference(ctx, config.record, "record");
        await readableRecord(ctx, scope, record, "write");
        const values = await resolveWorkflowRecordValues(scope, await listFields(record.tableId), fieldPayload(ctx, "set", config.set));
        auditAnswerPayload(ctx, config.audit);
        return {
          summary: runtimeText(ctx).updateFields({ count: Object.keys(values).length }),
          output: record as unknown as WorkflowJsonValue,
        };
      }),
  }),

  createRecord: workflowAction.transactional({
    ...GRIDS_WORKFLOW_ACTION_METADATA.createRecord,

    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const tableId = boundId(ctx, "table");
        await currentTable(ctx, scope, tableId);
        await requireTableAccess(scope, tableId, "write", tx);
        const values = await resolveWorkflowRecordValues(
          scope,
          await listFields(tableId, false, tx),
          fieldPayload(ctx, "values", config.values),
          tx,
        );
        const created = requireOk(
          await createRecordInTransaction(tx, tableId, values, actorId(scope), "workflow", {
            dateConfig: await dateContext(ctx),
            viewer: viewerForScope(scope),
          }),
        );
        await logAudit(
          {
            baseId: scope.baseId,
            tableId,
            recordId: created.record.id,
            userId: actorId(scope),
            action: "workflow.record.created",
            diff: { workflowRecordCreate: { old: null, new: { ...workflowAuditMeta(scope), fields: Object.keys(values) } } },
          },
          tx,
        );
        return {
          state: "succeeded",
          output: { kind: "record", tableId: created.record.tableId, recordId: created.record.id } as WorkflowJsonValue,
        };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const tableId = boundId(ctx, "table");
        await currentTable(ctx, scope, tableId);
        await requireTableAccess(scope, tableId, "write");
        const values = await resolveWorkflowRecordValues(scope, await listFields(tableId), fieldPayload(ctx, "values", config.values));
        return {
          summary: runtimeText(ctx).createRecordWithFields({ count: Object.keys(values).length }),
          // Marked planned: a later step that cannot tell this from a real
          // record would act on a row that does not exist.
          output: { kind: "record", tableId, recordId: `dry-run:${ctx.stepKey}`, planned: true },
        };
      }),
  }),

  atomicRecords: workflowAction.transactional({
    ...GRIDS_WORKFLOW_ACTION_METADATA.atomicRecords,

    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const dates = await dateContext(ctx);

        const locks: AtomicRecordRef[] = [];
        for (let index = 0; index < config.locks.length; index += 1) {
          const record = await recordReference(ctx, config.locks[index]!, `locks.${index}`);
          if (record.planned) {
            throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).existingRecordRequired({ path: `locks.${index}` }));
          }
          locks.push({ tableId: record.tableId, recordId: record.recordId, required: "read" });
        }
        for (let index = 0; index < config.changes.length; index += 1) {
          const change = config.changes[index]!;
          if (!("updateRecord" in change)) continue;
          const record = await recordReference(ctx, change.updateRecord.record, `changes.${index}.updateRecord.record`);
          if (record.planned)
            throw actionError(
              "WORKFLOW_VALUE_INVALID",
              runtimeText(ctx).existingRecordRequired({ path: `changes.${index}.updateRecord.record` }),
            );
          locks.push({ tableId: record.tableId, recordId: record.recordId, required: "write" });
        }

        const authorizedTables = new Set<string>();
        const accessFor = async (tableId: string, required: "read" | "write") => {
          const key = `${tableId}:${required}`;
          if (authorizedTables.has(key)) return;
          await requireWorkflowTable(tx, scope.baseId, tableId);
          await requireTableAccess(scope, tableId, required, tx);
          authorizedTables.add(key);
        };
        await lockAtomicRecords(tx, locks, (record) => accessFor(record.tableId, record.required));

        for (let checkIndex = 0; checkIndex < config.checks.length; checkIndex += 1) {
          const check = config.checks[checkIndex]!;
          const tableId = boundIdAt(ctx, ["checks", checkIndex, "table"]);
          await accessFor(tableId, "read");
          const predicates: AtomicQueryPredicate[] = check.where.map((predicate, predicateIndex) => ({
            fieldId: boundIdAt(ctx, ["checks", checkIndex, "where", predicateIndex, "field"]),
            op: predicate.op,
            ...(predicate.value === undefined ? {} : { value: predicate.value }),
            ...(predicate.caseInsensitive === undefined ? {} : { caseInsensitive: predicate.caseInsensitive }),
          }));
          const matches = await atomicQueryMatches({ scope, client: tx, tableId, predicates, timeZone: dates.timeZone ?? "UTC" });
          const passed = check.assert === "empty" ? !matches : matches;
          if (!passed) throw actionError("ATOMIC_CHECK_FAILED", check.message?.trim() || runtimeText(ctx).atomicCheckFailed);
        }

        const created: RuntimeRecord[] = [];
        const updated: RuntimeRecord[] = [];
        for (let changeIndex = 0; changeIndex < config.changes.length; changeIndex += 1) {
          const change = config.changes[changeIndex]!;
          if ("createRecord" in change) {
            const tableId = boundIdAt(ctx, ["changes", changeIndex, "createRecord", "table"]);
            await accessFor(tableId, "write");
            const values = await resolveWorkflowRecordValues(
              scope,
              await listFields(tableId, false, tx),
              atomicFieldPayloadAt(ctx, ["changes", changeIndex, "createRecord", "values"], change.createRecord.values),
              tx,
            );
            const result = requireOk(
              await createRecordInTransaction(tx, tableId, values, actorId(scope), "workflow", {
                dateConfig: dates,
                viewer: viewerForScope(scope),
              }),
            );
            await logAudit(
              {
                baseId: scope.baseId,
                tableId,
                recordId: result.record.id,
                userId: actorId(scope),
                action: "workflow.record.created",
                diff: { workflowRecordCreate: { old: null, new: { ...workflowAuditMeta(scope), fields: Object.keys(values) } } },
              },
              tx,
            );
            created.push({ kind: "record", tableId, recordId: result.record.id });
            continue;
          }

          const record = await recordReference(ctx, change.updateRecord.record, `changes.${changeIndex}.updateRecord.record`);
          await accessFor(record.tableId, "write");
          const values = await resolveWorkflowRecordValues(
            scope,
            await listFields(record.tableId, false, tx),
            atomicFieldPayloadAt(ctx, ["changes", changeIndex, "updateRecord", "set"], change.updateRecord.set),
            tx,
          );
          const audit = auditAnswerPayload(ctx, change.updateRecord.audit);
          const result = requireOk(
            await updateRecordInTransaction(
              tx,
              record.tableId,
              record.recordId,
              values,
              actorId(scope),
              "workflow",
              change.updateRecord.ifVersion,
              {
                dateConfig: dates,
                viewer: viewerForScope(scope),
                ...(audit ? { audit } : {}),
              },
            ),
          );
          if (result.outboxId) {
            await logAudit(
              {
                baseId: scope.baseId,
                tableId: record.tableId,
                recordId: record.recordId,
                userId: actorId(scope),
                action: "workflow.record.updated",
                diff: { workflowRecordUpdate: { old: null, new: { ...workflowAuditMeta(scope), fields: Object.keys(values) } } },
              },
              tx,
            );
          }
          updated.push({ kind: "record", tableId: record.tableId, recordId: result.record.id });
        }

        return { state: "succeeded", output: { created, updated } as unknown as WorkflowJsonValue };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const dates = await dateContext(ctx);
        const issues: string[] = [];

        for (let index = 0; index < config.locks.length; index += 1) {
          const record = await recordReference(ctx, config.locks[index]!, `locks.${index}`);
          await readableRecord(ctx, scope, record, "read");
        }
        for (let checkIndex = 0; checkIndex < config.checks.length; checkIndex += 1) {
          const check = config.checks[checkIndex]!;
          const tableId = boundIdAt(ctx, ["checks", checkIndex, "table"]);
          await currentTable(ctx, scope, tableId);
          await requireTableAccess(scope, tableId, "read");
          const predicates: AtomicQueryPredicate[] = check.where.map((predicate, predicateIndex) => ({
            fieldId: boundIdAt(ctx, ["checks", checkIndex, "where", predicateIndex, "field"]),
            op: predicate.op,
            ...(predicate.value === undefined ? {} : { value: predicate.value }),
            ...(predicate.caseInsensitive === undefined ? {} : { caseInsensitive: predicate.caseInsensitive }),
          }));
          const matches = await atomicQueryMatches({ scope, tableId, predicates, timeZone: dates.timeZone ?? "UTC" });
          if ((check.assert === "empty" && matches) || (check.assert === "notEmpty" && !matches)) {
            issues.push(check.message?.trim() || runtimeText(ctx).checkDoesNotPass({ index: checkIndex + 1 }));
          }
        }
        for (let changeIndex = 0; changeIndex < config.changes.length; changeIndex += 1) {
          const change = config.changes[changeIndex]!;
          if ("createRecord" in change) {
            const tableId = boundIdAt(ctx, ["changes", changeIndex, "createRecord", "table"]);
            await currentTable(ctx, scope, tableId);
            await requireTableAccess(scope, tableId, "write");
            await resolveWorkflowRecordValues(
              scope,
              await listFields(tableId),
              atomicFieldPayloadAt(ctx, ["changes", changeIndex, "createRecord", "values"], change.createRecord.values),
            );
          } else {
            const record = await recordReference(ctx, change.updateRecord.record, `changes.${changeIndex}.updateRecord.record`);
            await readableRecord(ctx, scope, record, "write");
            await resolveWorkflowRecordValues(
              scope,
              await listFields(record.tableId),
              atomicFieldPayloadAt(ctx, ["changes", changeIndex, "updateRecord", "set"], change.updateRecord.set),
            );
            auditAnswerPayload(ctx, change.updateRecord.audit);
          }
        }
        return {
          summary: runtimeText(ctx).atomicPlan({ checks: config.checks.length, changes: config.changes.length }),
          issues,
        };
      }),
  }),

  generateDocument: workflowAction.idempotent({
    ...GRIDS_WORKFLOW_ACTION_METADATA.generateDocument,

    authorize: mayExecute,

    run: (ctx, config) =>
      attempt(async () => {
        await ctx.heartbeat();
        const scope = await workflowRunScope(ctx);
        const template = await documentTemplate(ctx, true);
        const table = await currentTable(ctx, scope, template.tableId);
        const record = await documentRecord(ctx, scope, table.id, config.record, "read");
        await requirePermission(scope, "write");
        await requireTableAccess(scope, table.id, "read");
        const document = requireOk(
          await createDocumentForRecord({
            template,
            table,
            recordId: record.recordId,
            actor: documentActorForScope(scope),
            idempotencyKey: ctx.effectKey,
            canReadTable: ({ tableId }, client) => canAccessWorkflowRunTable(scope, tableId, "read", client),
            viewer: {
              userId: scope.principal.userId,
              userGroups: scope.principal.groupIds,
              serviceAccountId: scope.principal.serviceAccountId,
            },
            dateConfig: await dateContext(ctx),
            filename: typeof config.filename === "string" ? config.filename : null,
            tags: documentTags(config.tags),
            workflowRunId: scope.runId,
            workflowStepKey: ctx.stepKey,
          }),
        );
        // Only the summary. The Document already carries the rendered
        // record content, so copying it into the step outcome would duplicate
        // a potentially large immutable payload.
        const summary = summarizeDocument(document);
        return {
          state: "succeeded",
          output: {
            id: summary.id,
            baseId: summary.baseId,
            tableId: summary.tableId,
            recordId: summary.recordId,
            templateId: summary.templateId,
            number: summary.documentNumber,
            filename: summary.filename,
            createdAt: summary.createdAt,
            tags: summary.tags,
            createdBy: summary.createdBy,
            renderer: summary.profile ? { kind: "profile", ...summary.profile } : { kind: "html" },
            validationStatus: summary.validationStatus,
            artifacts: summary.artifacts.map(({ key, filename, mimeType, sizeBytes, sha256 }) => ({
              key,
              filename,
              mimeType,
              sizeBytes,
              sha256,
            })),
          } as WorkflowJsonValue,
        };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const template = await documentTemplate(ctx);
        await currentTable(ctx, scope, template.tableId);
        const record = await documentRecord(ctx, scope, template.tableId, config.record, "read");
        await requirePermission(scope, "write");
        return {
          summary: runtimeText(ctx).generateDocument({ name: template.name }),
          consumes: { documents: 1 },
          output: {
            kind: "document",
            id: `dry-run:${ctx.stepKey}`,
            baseId: scope.baseId,
            tableId: template.tableId,
            templateId: template.id,
            recordId: record.recordId,
            planned: true,
          },
        };
      }),
  }),

  createDocumentLink: workflowAction.transactional({
    ...GRIDS_WORKFLOW_ACTION_METADATA.createDocumentLink,

    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const document = await documentToLink(ctx, scope, config.document);
        await currentTable(ctx, scope, document.tableId);
        await requirePermission(scope, "write", tx);
        const expiresIn = linkExpiry(config.expiresIn);
        const baseUrl = await publicDocumentLinkBaseUrl();
        const created = requireOk(
          await createDocumentLink({
            document,
            input: { expiresIn, comment: typeof config.comment === "string" ? config.comment : null },
            actorId: actorId(scope),
            client: tx,
          }),
        );
        await logAudit(
          {
            baseId: scope.baseId,
            tableId: document.tableId,
            recordId: document.recordId,
            userId: actorId(scope),
            action: "workflow.document_link.created",
            diff: {
              workflowDocumentLinkCreate: {
                old: null,
                new: {
                  ...workflowAuditMeta(scope),
                  documentId: document.id,
                  documentLinkId: created.link.id,
                  expiresAt: created.link.expiresAt,
                },
              },
            },
          },
          tx,
        );
        return {
          state: "succeeded",
          output: {
            kind: "documentLink",
            id: created.link.id,
            documentId: document.id,
            url: `${baseUrl}${encodeURIComponent(created.token)}`,
            expiresAt: created.link.expiresAt,
          },
        };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const document = await plannedDocumentToLink(ctx, scope, config.document);
        await currentTable(ctx, scope, document.tableId);
        await requirePermission(scope, "write");
        const expiresIn = linkExpiry(config.expiresIn);
        return {
          summary: runtimeText(ctx).createDocumentLink({ expiresIn }),
          output: {
            kind: "documentLink",
            id: `dry-run:${ctx.stepKey}`,
            documentId: document.id,
            url: `https://example.invalid/grids-document-link/${encodeURIComponent(ctx.stepKey)}`,
            expiresIn,
            planned: true,
          },
        };
      }),
  }),

  sendEmail: workflowAction.idempotent({
    ...GRIDS_WORKFLOW_ACTION_METADATA.sendEmail,

    authorize: mayExecute,

    run: (ctx, config) =>
      attempt(async () => {
        await ctx.heartbeat();
        const scope = await workflowRunScope(ctx);
        const { template, recipients } = await emailInput(ctx, scope, config);
        const output = await sendWorkflowEmail({
          scope,
          template,
          recipients,
          locale: invocationLocale(ctx),
          data: config.data ?? {},
          occurredAt: ctx.invocation.occurredAt,
          effectKey: ctx.effectKey,
          // Per-recipient delivery hangs off the run and the step, so a replay
          // finds the recipients already served and does not serve them again.
          workflowStepKey: ctx.stepKey,
        });
        return { state: "succeeded", output };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const { template, recipients } = await emailInput(ctx, scope, config);
        return {
          summary: runtimeText(ctx).sendEmail({ name: template.name, count: recipients.length }),
          consumes: { emails: recipients.length },
        };
      }),
  }),

  httpRequest: workflowAction.ambiguous({
    ...GRIDS_WORKFLOW_ACTION_METADATA.httpRequest,

    authorize: mayExecute,

    run: (ctx, config) =>
      attempt(async () => {
        await ctx.heartbeat();
        const scope = await workflowRunScope(ctx);
        const request = httpInput(ctx, config);
        const response = await requestWorkflowHttp({ ...request, idempotencyKey: ctx.effectKey, locale: invocationLocale(ctx) });
        // The request left the process and no complete answer came back. It may
        // have been acted on; repeating it is how a webhook fires twice.
        if (!response.ok && response.error.code === "WORKFLOW_HTTP_OUTCOME_UNKNOWN") {
          return { state: "ambiguous", message: runtimeText(ctx).httpOutcomeUnknown, code: response.error.code };
        }
        const result = requireOk(response);
        await logAudit({
          baseId: scope.baseId,
          userId: actorId(scope),
          action: result.ok ? "workflow.http.sent" : "workflow.http.failed",
          diff: {
            httpRequest: {
              old: null,
              new: { ...workflowAuditMeta(scope), method: request.method, host: result.host, status: result.status },
            },
          },
        });
        if (!result.ok) throw actionError("WORKFLOW_HTTP_FAILED", runtimeText(ctx).httpFailed({ status: result.status }));
        return { state: "succeeded", output: { status: result.status, ok: result.ok, body: result.body } };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        await requireExecution(await workflowRunScope(ctx));
        const request = httpInput(ctx, config);
        requireOk(await preflightWorkflowHttp({ ...request, locale: invocationLocale(ctx) }));
        return {
          summary: `${request.method} ${new URL(request.url).host}`,
          consumes: { httpRequests: 1 },
        };
      }),

    /*
     * Nothing here can ask the remote service what happened, and guessing is
     * exactly the failure this class exists to prevent. So an interrupted
     * request is handed to a human rather than repeated.
     */
    reconcile: async (ctx) => ({
      state: "unknown",
      code: "WORKFLOW_HTTP_OUTCOME_UNKNOWN",
      message: runtimeText(ctx).httpOutcomeUnknown,
    }),
  }),
};
