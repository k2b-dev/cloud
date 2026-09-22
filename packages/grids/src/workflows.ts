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

import { get as settingsGet } from "@k2b/cloud/services/settings";
import { normalizeTimeZone } from "@k2b/cloud/shared";
import type { WorkflowActionContext, WorkflowActionResult, WorkflowJsonValue, WorkflowPlannedEffect } from "@k2b/cloud/workflows";
import { workflowAction } from "@k2b/cloud/workflows";
import type { DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import type { Document, RecordMutationAudit, Table } from "./contracts";
import { documentAllowsPublicLinks, documentMediaTypeAllowsPublicLinks } from "./document-sharing";
import { objectListRecordInputValues } from "./field-types/object-list";
import { logAudit, type SqlClient } from "./service/audit";
import { documentIssuanceService } from "./service/document-issuance";
import { summarizeDocument } from "./service/document-mappers";
import { documentServiceText } from "./service/document-messages";
import { DocumentQueryOutputSchema, documentQueryOutputMediaType } from "./service/document-query-output";
import {
  DocumentSourceVersionsInputSchema,
  DocumentSourceVersionsSchema,
  requireDocumentSourceVersions,
} from "./service/document-source-versions";
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
  assertRecordMutable,
  finalizeInTransaction as finalizeRecordInTransaction,
  getStatus as getRecordFinalizationStatus,
  inspect as inspectRecordFinalization,
  requestFinalizationInTransaction,
} from "./service/record-finalization";
import { publicIdsForRecords } from "./service/record-read";
import {
  createInTransaction as createRecordInTransaction,
  softDeleteInTransaction,
  updateInTransaction as updateRecordInTransaction,
} from "./service/record-write";
import { get as getTable } from "./service/tables";
import { documentBusinessSnapshot } from "./service/template-context";
import {
  actionError,
  actorId,
  canAccessWorkflowRunTable,
  canExecuteRun,
  createWorkflowCaptureTableAccess,
  createWorkflowEffectAccess,
  documentActorForScope,
  GridsWorkflowActionError,
  type GridsWorkflowActionScope,
  requireExecution,
  requireOk,
  requirePermission,
  requireTableAccess,
  type WorkflowEffectAccess,
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
import { loadWorkflowCatalog } from "./service/workflow-catalog";
import {
  captureWorkflowDocumentSource,
  captureWorkflowRecordSource,
  planWorkflowDocumentSource,
} from "./service/workflow-document-sources";
import { validateWorkflowDocument } from "./service/workflow-document-validation";
import { captureWorkflowDocumentValues } from "./service/workflow-document-values";
import { sendWorkflowEmail, type WorkflowEmailRecipient } from "./service/workflow-email-send";
import { preflightWorkflowHttp, requestWorkflowHttp } from "./service/workflow-http-client";
import { workflowQueryBinder } from "./service/workflow-query-binding";
import { captureWorkflowQueryData } from "./service/workflow-query-data";
import {
  findWorkflowDocumentDataForStep,
  persistWorkflowQueryDataInTransaction,
  WorkflowDocumentDataReferenceSchema,
  WorkflowQueryReferenceSchema,
} from "./service/workflow-query-store";
import { workflowInvocationLocale, workflowRuntimeText } from "./workflow-runtime-messages";
import { GRIDS_WORKFLOW_ACTION_METADATA } from "./workflows/action-metadata";
import { isCorrectionPrefillFieldType, MAX_ATOMIC_LOCK_RECORDS, MAX_CORRECTION_PREFILL_FIELDS } from "./workflows/contracts";
import { resolveWorkflowQueryParameters, WorkflowQueryParametersSchema } from "./workflows/query-parameters";

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

/** Relation reads inherit this effect's authority, including App-only access. */
const viewerForScope = (scope: GridsWorkflowActionScope, authorizeTable: (tableId: string) => Promise<boolean>) => ({
  userId: scope.principal.userId,
  userGroups: scope.principal.groupIds,
  serviceAccountId: scope.principal.serviceAccountId,
  authorizeTable,
});

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

const atomicLockReferences = async (ctx: WorkflowActionContext, references: readonly string[]): Promise<RuntimeRecord[]> => {
  const records = new Map<string, RuntimeRecord>();
  for (const [index, reference] of references.entries()) {
    const value = await ctx.resolveReference(reference, `locks.${index}`);
    if (value === null) throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).recordReferenceRequired({ path: reference }));
    const values = Array.isArray(value) ? value : [value];
    for (const record of values) {
      if (!isRuntimeRecord(record)) throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).atomicLocksInvalid);
      records.set(`${record.tableId}:${record.recordId}`, record);
      if (records.size > MAX_ATOMIC_LOCK_RECORDS) throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).atomicLocksInvalid);
    }
  }
  return [...records.values()];
};

/**
 * Checks table access and confirms the record identity still exists.
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
  // This guard only needs identity. The owning action reads values in its
  // transaction; evaluating formulas and expanding relations here repeats work.
  const records = await publicIdsForRecords(reference.tableId, [reference.recordId]);
  if (!records.has(reference.recordId)) throw actionError("NOT_FOUND", runtimeText(ctx).recordUnavailable);
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

/** Copy trusted stored inputs, never computed columns or business identity. */
const recordCreationValues = async (
  ctx: WorkflowActionContext,
  scope: GridsWorkflowActionScope,
  tableId: string,
  config: { copyFrom?: string; copyFields?: string[]; values: Record<string, WorkflowJsonValue> },
  client: SqlClient = sql,
): Promise<Record<string, unknown>> => {
  const fields = await listFields(tableId, false, client);
  let copied: Record<string, unknown> = {};
  if (config.copyFrom !== undefined || config.copyFields !== undefined) {
    if (!config.copyFrom || !config.copyFields?.length || config.copyFields.length > MAX_CORRECTION_PREFILL_FIELDS)
      throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).copySourceInvalid);
    const source = await recordReference(ctx, config.copyFrom, "copyFrom");
    if (source.planned || source.tableId !== tableId) throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).copySourceInvalid);
    const ids = config.copyFields.map((_, index) => boundIdAt(ctx, ["copyFields", index]));
    if (new Set(ids).size !== ids.length) throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).copySourceInvalid);
    for (const id of ids) {
      const field = fields.find((field) => field.id === id);
      if (!field || !isCorrectionPrefillFieldType(field.type) || field.uniqueConstraint)
        throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).copySourceInvalid);
    }
    const [record] = await client<Array<{ data: Record<string, unknown> }>>`
      SELECT data FROM grids.records WHERE id = ${source.recordId}::uuid AND table_id = ${tableId}::uuid AND deleted_at IS NULL`;
    if (!record) throw actionError("NOT_FOUND", runtimeText(ctx).recordUnavailable);
    copied = objectListRecordInputValues(
      fields,
      Object.fromEntries(
        ids.map((id) => {
          const value = record.data[id] ?? null;
          return [
            id,
            fields.find((field) => field.id === id)!.type === "json" && typeof value === "string" ? JSON.stringify(value) : value,
          ];
        }),
      ),
    );
  }
  return resolveWorkflowRecordValues(scope, fields, { ...copied, ...fieldPayload(ctx, "values", config.values) }, client);
};

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
  return { ...objectListRecordInputValues(fields, values), [typeFieldId]: [typeValue], [originalFieldId]: originalRecordId };
};

const correctionCopyFieldIds = (ctx: WorkflowActionContext, copyFields: string[] | undefined): string[] =>
  (copyFields ?? []).map((_, index) => {
    const id = ctx.binding("copyFields", index);
    if (typeof id !== "string" || !id) {
      throw actionError("WORKFLOW_BINDING_MISSING", runtimeText(ctx).stableBindingMissing({ path: `copyFields.${index}` }));
    }
    return id;
  });

const correctionExplicitValues = async (
  ctx: WorkflowActionContext,
  scope: GridsWorkflowActionScope,
  tableId: string,
  values: Record<string, WorkflowJsonValue> | undefined,
  client: SqlClient,
) => {
  const payload = values === undefined ? {} : atomicFieldPayloadAt(ctx, ["values"], values);
  if (Object.keys(payload).length > MAX_CORRECTION_PREFILL_FIELDS)
    throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).correctionPrefillLimit({ count: MAX_CORRECTION_PREFILL_FIELDS }));
  if (boundId(ctx, "typeField") in payload || boundId(ctx, "originalField") in payload)
    throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).correctionPrefillReservedFields);
  return resolveWorkflowRecordValues(scope, await listFields(tableId, false, client), payload, client);
};

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

const workflowQueryInput = async (
  ctx: WorkflowActionContext,
  rawParameters: unknown,
  planning = false,
  options: { client?: SqlClient; bindingPath?: string; effectAccess?: WorkflowEffectAccess } = {},
) => {
  const client = options.client ?? sql;
  const scope = options.effectAccess?.scope ?? (await workflowRunScope(ctx, client));
  if (!options.effectAccess) await requireExecution(scope, client);
  const binding = ctx.binding(options.bindingPath ?? "$query");
  if (
    !binding ||
    typeof binding !== "object" ||
    Array.isArray(binding) ||
    typeof binding.source !== "string" ||
    typeof binding.schemaHash !== "string"
  ) {
    throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).queryBindingInvalid);
  }
  const parameters = WorkflowQueryParametersSchema.safeParse(rawParameters ?? {});
  if (!parameters.success) throw actionError("BAD_INPUT", runtimeText(ctx).queryParametersInvalid);
  const resolved = await resolveWorkflowQueryParameters(
    parameters.data,
    async (references) => {
      const idsByTable = new Map<string, Map<string, string>>();
      for (const tableId of new Set(references.map((reference) => reference.tableId))) {
        if (options.effectAccess) await options.effectAccess.requireTable(tableId);
        else {
          await requireWorkflowTable(client, scope.baseId, tableId);
          await requireTableAccess(scope, tableId, "read", client);
        }
        const ids = references
          .filter((reference) => reference.tableId === tableId && !(planning && "planned" in reference))
          .map((reference) => reference.recordId);
        idsByTable.set(tableId, await publicIdsForRecords(tableId, ids, client));
      }
      return references.map((reference) => {
        // Planned IDs remain type-checking placeholders, never SQL identities.
        if (planning && "planned" in reference) return "REC001";
        const id = idsByTable.get(reference.tableId)?.get(reference.recordId);
        if (!id) throw actionError("NOT_FOUND", runtimeText(ctx).recordUnavailable);
        return id;
      });
    },
    { allowPlannedRecords: planning },
  );
  if (!resolved.ok) throw actionError("BAD_INPUT", runtimeText(ctx).queryParametersInvalid);
  return {
    scope,
    binding: { source: binding.source, schemaHash: binding.schemaHash },
    values: resolved.values,
  };
};

const documentTemplate = async (ctx: WorkflowActionContext, resume = false) => {
  const template = await (resume ? getStoredTemplate : getTemplate)(boundId(ctx, "template"));
  if (!template || (!resume && !template.enabled)) throw actionError("NOT_FOUND", runtimeText(ctx).documentTemplateUnavailable);
  return template;
};

const atomicGqlCheckMatches = async (
  ctx: WorkflowActionContext,
  checkIndex: number,
  parameters: unknown,
  timeZone: string,
  client?: SqlClient,
  effectAccess?: WorkflowEffectAccess,
) => {
  const input = await workflowQueryInput(ctx, parameters, client === undefined, {
    client,
    effectAccess,
    bindingPath: `checks.${checkIndex}.query.$query`,
  });
  const result = requireOk(
    await captureWorkflowQueryData(
      {
        baseId: input.scope.baseId,
        binding: input.binding,
        values: input.values,
        timeZone,
        locale: invocationLocale(ctx),
        createTableAccess: (db) =>
          effectAccess ? Promise.resolve(effectAccess.canReadTable) : createWorkflowCaptureTableAccess(input.scope, db),
      },
      client,
    ),
  );
  return result.rowCount > 0;
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

type LinkableDocument = Pick<Document, "id" | "baseId" | "tableId" | "templateId" | "recordId">;

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
  if (!documentAllowsPublicLinks(document))
    throw actionError("BAD_INPUT", documentServiceText(invocationLocale(ctx)).publicLinksUnsupportedFormat);
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
    id.startsWith("dry-run:") &&
    referenceDocument.kind === "document" &&
    referenceDocument.baseId === scope.baseId &&
    (typeof referenceDocument.tableId === "string" || referenceDocument.tableId === null) &&
    (typeof referenceDocument.recordId === "string" || referenceDocument.recordId === null)
  ) {
    if (!documentMediaTypeAllowsPublicLinks(referenceDocument.primaryArtifactMimeType))
      throw actionError("BAD_INPUT", documentServiceText(invocationLocale(ctx)).publicLinksUnsupportedFormat);
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
  if (!documentAllowsPublicLinks(document))
    throw actionError("BAD_INPUT", documentServiceText(invocationLocale(ctx)).publicLinksUnsupportedFormat);
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

const workflowDocumentOutput = (document: Document) => {
  const summary = summarizeDocument(document);
  return {
    id: summary.id,
    shortId: summary.shortId,
    baseId: summary.baseId,
    tableId: summary.tableId,
    recordId: summary.recordId,
    templateId: summary.templateId,
    number: summary.documentNumber,
    business: documentBusinessSnapshot(document.renderData),
    filename: summary.filename,
    createdAt: summary.createdAt,
    tags: summary.tags,
    createdBy: summary.createdBy,
    primaryArtifactKey: summary.primaryArtifactKey,
    renderer: summary.profile ? { kind: "profile", ...summary.profile } : { kind: "html" },
    validationStatus: summary.validationStatus,
    artifacts: summary.artifacts.map(({ key, filename, mimeType, sizeBytes, sha256 }) => ({ key, filename, mimeType, sizeBytes, sha256 })),
  };
};

// ─── Actions ─────────────────────────────────────────────────────────────────

export const GRIDS_WORKFLOW_ACTIONS = {
  query: workflowAction.transactional({
    ...GRIDS_WORKFLOW_ACTION_METADATA.query,
    authorize: mayExecute,
    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        await ctx.heartbeat();
        const input = await workflowQueryInput(ctx, config.parameters);
        const captured = requireOk(
          await captureWorkflowQueryData({
            baseId: input.scope.baseId,
            binding: input.binding,
            values: input.values,
            timeZone: (await dateContext(ctx)).timeZone ?? "UTC",
            locale: invocationLocale(ctx),
            createTableAccess: (client) => createWorkflowCaptureTableAccess(input.scope, client),
          }),
        );
        // Reading and committing are separate transactions. Recheck current
        // credentials and all dependencies before the kernel journals success.
        await ctx.heartbeat();
        const currentScope = await workflowRunScope(ctx, tx);
        await requireExecution(currentScope, tx);
        for (const tableId of captured.payload.tableIds) await requireTableAccess(currentScope, tableId, "read", tx);
        const output = requireOk(
          await persistWorkflowQueryDataInTransaction(
            {
              baseId: currentScope.baseId,
              runId: ctx.runId,
              stepKey: ctx.stepKey,
              capture: captured,
              locale: invocationLocale(ctx),
            },
            tx,
          ),
        );
        return { state: "succeeded", output };
      }),
    plan: (ctx, config) =>
      planned(async () => {
        const input = await workflowQueryInput(ctx, config.parameters, true);
        const catalog = await loadWorkflowCatalog(input.scope.baseId);
        const visible = new Set<string>();
        for (const tableId of new Set([...catalog.tables.refs.values()].map((table) => table.id))) {
          if (await canAccessWorkflowRunTable(input.scope, tableId, "read")) visible.add(tableId);
        }
        catalog.tables.refs = new Map([...catalog.tables.refs].filter(([, table]) => visible.has(table.id)));
        const binding = requireOk(
          await workflowQueryBinder(input.scope.baseId, catalog, sql, invocationLocale(ctx))(input.binding.source, input.values),
        );
        if (binding.schemaHash !== input.binding.schemaHash)
          throw actionError("CONFLICT", documentServiceText(invocationLocale(ctx)).workflowQuerySchemaChanged);
        return {
          summary: runtimeText(ctx).captureQuery,
          output: { kind: "queryResult", id: `dry-run:${ctx.stepKey}`, planned: true },
        };
      }),
  }),
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
              dateConfig: await dateContext(ctx),
              locale: invocationLocale(ctx),
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
        const explicit = await correctionExplicitValues(ctx, scope, original.tableId, config.values, tx);
        const created = requireOk(
          await createRecordInTransaction(tx, original.tableId, { ...values, ...explicit }, actorId(scope), "workflow", {
            dateConfig: await dateContext(ctx),
            viewer: viewerForScope(scope, await createWorkflowCaptureTableAccess(scope, tx)),
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
        if (original.planned) {
          throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).existingFinalizedRecordRequired({ path: "original" }));
        }
        await currentTable(ctx, scope, original.tableId);
        await requireTableAccess(scope, original.tableId, "write");
        requireOk(await assertMutationAllowed(sql, original.tableId, "workflow", invocationLocale(ctx)));
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
        await correctionExplicitValues(ctx, scope, original.tableId, config.values, sql);
        return {
          summary: runtimeText(ctx).createFollowUpDraft,
          output: { kind: "record", tableId: original.tableId, recordId: `dry-run:${ctx.stepKey}`, planned: true },
        };
      }),
  }),

  deleteRecord: workflowAction.transactional({
    ...GRIDS_WORKFLOW_ACTION_METADATA.deleteRecord,
    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const record = await recordReference(ctx, config.record, "record");
        await currentTable(ctx, scope, record.tableId);
        await lockAtomicRecords(tx, [{ ...record, required: "write" }], async () => {
          await requireTableAccess(scope, record.tableId, "write", tx);
        });
        await ctx.heartbeat(tx);
        requireOk(
          await softDeleteInTransaction(
            tx,
            record.tableId,
            record.recordId,
            actorId(scope),
            "workflow",
            auditAnswerPayload(ctx, config.audit),
            invocationLocale(ctx),
          ),
        );
        await logAudit(
          {
            baseId: scope.baseId,
            tableId: record.tableId,
            recordId: record.recordId,
            userId: actorId(scope),
            action: "workflow.record.deleted",
            diff: { workflowRecordDeletion: { old: null, new: workflowAuditMeta(scope) } },
          },
          tx,
        );
        return { state: "succeeded", output: { kind: "record", tableId: record.tableId, recordId: record.recordId } };
      }),
    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const record = await recordReference(ctx, config.record, "record");
        await readableRecord(ctx, scope, record, "write");
        requireOk(await assertMutationAllowed(sql, record.tableId, "workflow", invocationLocale(ctx)));
        // Finalized rows never return to trash, including through workflow launchers.
        requireOk(await assertRecordMutable(sql, record.tableId, record.recordId, invocationLocale(ctx)));
        return { summary: runtimeText(ctx).deleteRecord, output: record as unknown as WorkflowJsonValue };
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
        await lockAtomicRecords(tx, [{ ...record, required: "write" }], async (target) => {
          await requireWorkflowTable(tx, scope.baseId, target.tableId);
          await requireTableAccess(scope, target.tableId, target.required, tx);
        });
        // Fence after potentially waiting for domain locks. The run-row lock
        // then protects finalization and its journal until this transaction ends.
        await ctx.heartbeat(tx);
        const dates = await dateContext(ctx);
        const finalized = requireOk(
          await finalizeRecordInTransaction(tx, {
            tableId: record.tableId,
            recordId: record.recordId,
            actorId: actorId(scope),
            origin: "workflow",
            dateConfig: dates,
            locale: dates.locale,
          }),
        );
        if (finalized.outboxId)
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
            viewer: viewerForScope(scope, await createWorkflowCaptureTableAccess(scope, tx)),
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
        const values = await recordCreationValues(ctx, scope, tableId, config, tx);
        const created = requireOk(
          await createRecordInTransaction(tx, tableId, values, actorId(scope), "workflow", {
            dateConfig: await dateContext(ctx),
            viewer: viewerForScope(scope, await createWorkflowCaptureTableAccess(scope, tx)),
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
        const values = await recordCreationValues(ctx, scope, tableId, config);
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
        const documentTargets: Array<{ templateId: string; tableId: string; recordId: string }> = [];
        for (let index = 0; index < (config.validateDocuments?.length ?? 0); index += 1) {
          const target = config.validateDocuments![index]!;
          const record = await recordReference(ctx, target.record, `validateDocuments.${index}.record`);
          if (record.planned)
            throw actionError(
              "WORKFLOW_VALUE_INVALID",
              runtimeText(ctx).existingRecordRequired({ path: `validateDocuments.${index}.record` }),
            );
          documentTargets.push({
            templateId: boundIdAt(ctx, ["validateDocuments", index, "template"]),
            tableId: record.tableId,
            recordId: record.recordId,
          });
          locks.push({ tableId: record.tableId, recordId: record.recordId, required: "read" });
        }
        for (const record of await atomicLockReferences(ctx, config.locks)) {
          if (record.planned) {
            throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).existingRecordRequired({ path: "locks" }));
          }
          locks.push({ tableId: record.tableId, recordId: record.recordId, required: "read" });
        }
        for (let index = 0; index < config.changes.length; index += 1) {
          const change = config.changes[index]!;
          if ("createRecord" in change) continue;
          const kind = "updateRecord" in change ? "updateRecord" : "deleteRecord" in change ? "deleteRecord" : "finalizeRecord";
          const reference =
            "updateRecord" in change
              ? change.updateRecord.record
              : "deleteRecord" in change
                ? change.deleteRecord.record
                : change.finalizeRecord.record;
          const record = await recordReference(ctx, reference, `changes.${index}.${kind}.record`);
          if (record.planned)
            throw actionError(
              "WORKFLOW_VALUE_INVALID",
              runtimeText(ctx).existingRecordRequired({ path: `changes.${index}.${kind}.record` }),
            );
          locks.push({ tableId: record.tableId, recordId: record.recordId, required: "write" });
        }
        if (new Set(locks.map((record) => `${record.tableId}:${record.recordId}`)).size > MAX_ATOMIC_LOCK_RECORDS)
          throw actionError("WORKFLOW_VALUE_INVALID", runtimeText(ctx).atomicLocksInvalid);

        const createTableIds: string[] = [];
        for (let index = 0; index < config.changes.length; index += 1) {
          if (!("createRecord" in config.changes[index]!)) continue;
          const tableId = boundIdAt(ctx, ["changes", index, "createRecord", "table"]);
          await requireWorkflowTable(tx, scope.baseId, tableId);
          createTableIds.push(tableId);
        }
        await lockAtomicRecords(tx, locks, (record) => requireWorkflowTable(tx, scope.baseId, record.tableId), createTableIds);
        // A worker can lose its lease while waiting above. Fence before checks
        // or writes; this transaction retains the run-row lock through commit.
        await ctx.heartbeat(tx);

        // Lock waiting can outlive an App grant or publication. Authorize once
        // here; subsequent checks and postconditions share this exact effect.
        const effectAccess = await createWorkflowEffectAccess(scope, tx);

        for (let checkIndex = 0; checkIndex < config.checks.length; checkIndex += 1) {
          const check = config.checks[checkIndex]!;
          if ("query" in check) {
            const matches = await atomicGqlCheckMatches(ctx, checkIndex, check.query.parameters, dates.timeZone ?? "UTC", tx, effectAccess);
            if ((check.assert === "empty" && matches) || (check.assert === "notEmpty" && !matches)) {
              throw actionError("ATOMIC_CHECK_FAILED", check.message?.trim() || runtimeText(ctx).atomicCheckFailed);
            }
            continue;
          }
          const tableId = boundIdAt(ctx, ["checks", checkIndex, "table"]);
          await effectAccess.requireTable(tableId);
          const predicates: AtomicQueryPredicate[] = check.where.map((predicate, predicateIndex) => ({
            fieldId: boundIdAt(ctx, ["checks", checkIndex, "where", predicateIndex, "field"]),
            op: predicate.op,
            ...(predicate.value === undefined ? {} : { value: predicate.value }),
            ...(predicate.caseInsensitive === undefined ? {} : { caseInsensitive: predicate.caseInsensitive }),
          }));
          const matches = await atomicQueryMatches({
            scope,
            client: tx,
            tableId,
            predicates,
            timeZone: dates.timeZone ?? "UTC",
            effectAccess,
          });
          const passed = check.assert === "empty" ? !matches : matches;
          if (!passed) throw actionError("ATOMIC_CHECK_FAILED", check.message?.trim() || runtimeText(ctx).atomicCheckFailed);
        }

        const created: RuntimeRecord[] = [];
        const updated: RuntimeRecord[] = [];
        for (let changeIndex = 0; changeIndex < config.changes.length; changeIndex += 1) {
          const change = config.changes[changeIndex]!;
          if ("deleteRecord" in change) {
            const record = await recordReference(ctx, change.deleteRecord.record, `changes.${changeIndex}.deleteRecord.record`);
            await effectAccess.requireTable(record.tableId);
            requireOk(
              await softDeleteInTransaction(
                tx,
                record.tableId,
                record.recordId,
                actorId(scope),
                "workflow",
                auditAnswerPayload(ctx, change.deleteRecord.audit),
                invocationLocale(ctx),
              ),
            );
            await logAudit(
              {
                baseId: scope.baseId,
                tableId: record.tableId,
                recordId: record.recordId,
                userId: actorId(scope),
                action: "workflow.record.deleted",
                diff: { workflowRecordDeletion: { old: null, new: workflowAuditMeta(scope) } },
              },
              tx,
            );
            continue;
          }
          if ("finalizeRecord" in change) {
            const record = await recordReference(ctx, change.finalizeRecord.record, `changes.${changeIndex}.finalizeRecord.record`);
            await effectAccess.requireTable(record.tableId);
            const finalized = requireOk(
              await finalizeRecordInTransaction(tx, {
                tableId: record.tableId,
                recordId: record.recordId,
                actorId: actorId(scope),
                origin: "workflow",
                dateConfig: dates,
                locale: dates.locale,
              }),
            );
            if (finalized.outboxId)
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
            continue;
          }
          if ("createRecord" in change) {
            const tableId = boundIdAt(ctx, ["changes", changeIndex, "createRecord", "table"]);
            await effectAccess.requireTable(tableId);
            const values = await resolveWorkflowRecordValues(
              scope,
              await listFields(tableId, false, tx),
              atomicFieldPayloadAt(ctx, ["changes", changeIndex, "createRecord", "values"], change.createRecord.values),
              tx,
              effectAccess,
            );
            const result = requireOk(
              await createRecordInTransaction(tx, tableId, values, actorId(scope), "workflow", {
                dateConfig: dates,
                viewer: viewerForScope(scope, effectAccess.canReadTable),
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
            if (change.createRecord.finalize) {
              const finalized = requireOk(
                await finalizeRecordInTransaction(tx, {
                  tableId,
                  recordId: result.record.id,
                  actorId: actorId(scope),
                  origin: "workflow",
                  dateConfig: dates,
                  locale: dates.locale,
                }),
              );
              if (finalized.outboxId)
                await logAudit(
                  {
                    baseId: scope.baseId,
                    tableId,
                    recordId: result.record.id,
                    userId: actorId(scope),
                    action: "workflow.record.finalized",
                    diff: { workflowRecordFinalization: { old: null, new: workflowAuditMeta(scope) } },
                  },
                  tx,
                );
            }
            continue;
          }

          const record = await recordReference(ctx, change.updateRecord.record, `changes.${changeIndex}.updateRecord.record`);
          await effectAccess.requireTable(record.tableId);
          const values = await resolveWorkflowRecordValues(
            scope,
            await listFields(record.tableId, false, tx),
            atomicFieldPayloadAt(ctx, ["changes", changeIndex, "updateRecord", "set"], change.updateRecord.set),
            tx,
            effectAccess,
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
                viewer: viewerForScope(scope, effectAccess.canReadTable),
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

        for (const target of documentTargets) await validateWorkflowDocument(tx, scope, target, dates, effectAccess, ctx.stepKey);
        return { state: "succeeded", output: { created, updated } as unknown as WorkflowJsonValue };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const dates = await dateContext(ctx);
        const issues: string[] = [];

        for (let index = 0; index < (config.validateDocuments?.length ?? 0); index += 1) {
          const target = config.validateDocuments![index]!;
          const record = await recordReference(ctx, target.record, `validateDocuments.${index}.record`);
          await readableRecord(ctx, scope, record, "read");
          await requirePermission(scope, "write");
          const template = await getTemplate(boundIdAt(ctx, ["validateDocuments", index, "template"]));
          if (!template || template.tableId !== record.tableId || !template.enabled || template.renderer.kind !== "profile")
            throw actionError("DOCUMENT_PROFILE_REQUIRED", documentServiceText(dates.locale).profileRequired);
        }

        for (const record of await atomicLockReferences(ctx, config.locks)) {
          await readableRecord(ctx, scope, record, "read");
        }
        for (let checkIndex = 0; checkIndex < config.checks.length; checkIndex += 1) {
          const check = config.checks[checkIndex]!;
          if ("query" in check) {
            const matches = await atomicGqlCheckMatches(ctx, checkIndex, check.query.parameters, dates.timeZone ?? "UTC");
            if ((check.assert === "empty" && matches) || (check.assert === "notEmpty" && !matches)) {
              issues.push(check.message?.trim() || runtimeText(ctx).checkDoesNotPass({ index: checkIndex + 1 }));
            }
            continue;
          }
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
          } else if ("deleteRecord" in change) {
            const record = await recordReference(ctx, change.deleteRecord.record, `changes.${changeIndex}.deleteRecord.record`);
            await readableRecord(ctx, scope, record, "write");
            requireOk(await assertMutationAllowed(sql, record.tableId, "workflow", invocationLocale(ctx)));
            requireOk(await assertRecordMutable(sql, record.tableId, record.recordId, invocationLocale(ctx)));
            auditAnswerPayload(ctx, change.deleteRecord.audit);
          } else if ("finalizeRecord" in change) {
            const record = await recordReference(ctx, change.finalizeRecord.record, `changes.${changeIndex}.finalizeRecord.record`);
            await readableRecord(ctx, scope, record, "write");
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
        if (config.data !== undefined) {
          if (!config.output || config.template !== undefined || config.record !== undefined)
            throw actionError("BAD_INPUT", documentServiceText(invocationLocale(ctx)).requestInvalidJson);
          const data =
            typeof config.data === "string"
              ? await ctx.resolveReference(config.data, "data")
              : await sql.begin(async (tx) => {
                  await ctx.heartbeat(tx);
                  const current = await workflowRunScope(ctx, tx);
                  await requireExecution(current, tx);
                  await requirePermission(current, "write", tx);
                  const input = { baseId: scope.baseId, runId: scope.runId, stepKey: ctx.stepKey, locale: invocationLocale(ctx) };
                  const saved = requireOk(await findWorkflowDocumentDataForStep(input, tx));
                  if (saved) return saved.reference;
                  const source = config.data;
                  if (!source || typeof source !== "object")
                    throw actionError("BAD_INPUT", documentServiceText(input.locale).tableOutputDataInvalid);
                  const capture = requireOk(
                    "documents" in source
                      ? await captureWorkflowDocumentSource(
                          { source, baseId: scope.baseId, capturedAt: new Date().toISOString(), locale: input.locale },
                          tx,
                        )
                      : "snapshots" in source
                        ? await captureWorkflowRecordSource(
                            {
                              source,
                              baseId: scope.baseId,
                              capturedAt: new Date().toISOString(),
                              locale: input.locale,
                              canReadTable: ({ tableId }, client) => canAccessWorkflowRunTable(current, tableId, "read", client),
                            },
                            tx,
                          )
                        : captureWorkflowDocumentValues(source, new Date().toISOString(), input.locale),
                  );
                  return requireOk(await persistWorkflowQueryDataInTransaction({ ...input, capture }, tx));
                });
          const reference = WorkflowDocumentDataReferenceSchema.safeParse(data);
          if (!reference.success) throw actionError("BAD_INPUT", documentServiceText(invocationLocale(ctx)).requestInvalidJson);
          const associatedData =
            config.associatedData === undefined
              ? undefined
              : WorkflowDocumentDataReferenceSchema.safeParse(await ctx.resolveReference(config.associatedData, "associatedData"));
          if (associatedData && !associatedData.success)
            throw actionError("BAD_INPUT", documentServiceText(invocationLocale(ctx)).associatedDataInvalid);
          const output = DocumentQueryOutputSchema.safeParse(config.output);
          if (!output.success) throw actionError("BAD_INPUT", documentServiceText(invocationLocale(ctx)).tableOutputInvalid);
          const document = requireOk(
            await documentIssuanceService.issueQueryDocument({
              baseId: scope.baseId,
              runId: scope.runId,
              stepKey: ctx.stepKey,
              data: reference.data,
              ...(associatedData?.success ? { associatedData: associatedData.data } : {}),
              output: output.data,
              ...(config.sourceVersions === undefined
                ? {}
                : { sourceVersions: DocumentSourceVersionsInputSchema.parse(config.sourceVersions) }),
              filename: typeof config.filename === "string" ? config.filename : null,
              tags: documentTags(config.tags),
              actor: documentActorForScope(scope),
              idempotencyKey: ctx.effectKey,
              locale: invocationLocale(ctx),
              authorize: async (tableIds, client) => {
                await ctx.heartbeat(client);
                const current = await workflowRunScope(ctx, client);
                await requireExecution(current, client);
                await requirePermission(current, "write", client);
                for (const tableId of tableIds) await requireTableAccess(current, tableId, "read", client);
              },
            }),
          );
          if ("kind" in document)
            return {
              state: "waiting",
              dependency: {
                kind: "grids.document-confirmation",
                key: document.receiptId,
                data: { receiptId: document.receiptId, sha256: document.sha256 },
              },
            };
          return { state: "succeeded", output: workflowDocumentOutput(document) };
        }
        if (
          !config.record ||
          !config.template ||
          config.output !== undefined ||
          config.sourceVersions !== undefined ||
          config.associatedData !== undefined
        )
          throw actionError("BAD_INPUT", documentServiceText(invocationLocale(ctx)).requestInvalidJson);
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
            canReadTable: async ({ tableId }, client) => {
              await ctx.heartbeat(client);
              const current = await workflowRunScope(ctx, client);
              await requireExecution(current, client);
              await requirePermission(current, "write", client);
              return canAccessWorkflowRunTable(current, tableId, "read", client);
            },
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
        return {
          state: "succeeded",
          output: workflowDocumentOutput(document),
        };
      }),

    cost: () => ({ documents: 1 }),
    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        if (config.data !== undefined) {
          if (!config.output || config.template !== undefined || config.record !== undefined)
            throw actionError("BAD_INPUT", documentServiceText(invocationLocale(ctx)).requestInvalidJson);
          await requirePermission(scope, "write");
          const reference = typeof config.data === "string" ? await ctx.resolveReference(config.data, "data") : null;
          if (config.associatedData !== undefined) {
            const associated = await ctx.resolveReference(config.associatedData, "associatedData");
            const planned =
              associated &&
              typeof associated === "object" &&
              !Array.isArray(associated) &&
              associated.kind === "queryResult" &&
              associated.planned === true;
            if (!planned && !WorkflowQueryReferenceSchema.safeParse(associated).success)
              throw actionError("BAD_INPUT", documentServiceText(invocationLocale(ctx)).requestInvalidJson);
          }
          let plannedDocuments = 0;
          if (typeof config.data !== "string") {
            if ("documents" in config.data) {
              plannedDocuments = requireOk(
                await planWorkflowDocumentSource({ source: config.data, baseId: scope.baseId, locale: invocationLocale(ctx) }, sql),
              ).plannedDocuments;
            } else if ("snapshots" in config.data) {
              requireOk(
                await captureWorkflowRecordSource(
                  {
                    source: config.data,
                    baseId: scope.baseId,
                    capturedAt: new Date().toISOString(),
                    locale: invocationLocale(ctx),
                    canReadTable: ({ tableId }, client) => canAccessWorkflowRunTable(scope, tableId, "read", client),
                  },
                  sql,
                ),
              );
            } else requireOk(captureWorkflowDocumentValues(config.data, new Date().toISOString(), invocationLocale(ctx)));
          }
          const plannedQuery =
            reference &&
            typeof reference === "object" &&
            !Array.isArray(reference) &&
            reference.kind === "queryResult" &&
            reference.planned === true &&
            typeof reference.id === "string" &&
            reference.id.startsWith("dry-run:");
          if (typeof config.data === "string" && !plannedQuery && !WorkflowDocumentDataReferenceSchema.safeParse(reference).success)
            throw actionError("BAD_INPUT", documentServiceText(invocationLocale(ctx)).requestInvalidJson);
          if (config.sourceVersions !== undefined) {
            if (config.output.kind !== "datev-csv" && config.output.kind !== "sepa-xml")
              throw actionError("BAD_INPUT", documentServiceText(invocationLocale(ctx)).requestInvalidJson);
            if (config.sourceVersions !== "data")
              await sql.begin(async (tx) => {
                await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
                return requireDocumentSourceVersions(
                  {
                    baseId: scope.baseId,
                    sourceVersions: DocumentSourceVersionsSchema.parse(config.sourceVersions),
                    lock: false,
                    locale: invocationLocale(ctx),
                    authorize: async (tableIds, client) => {
                      for (const tableId of tableIds) await requireTableAccess(scope, tableId, "read", client);
                    },
                  },
                  tx,
                );
              });
          }
          return {
            summary:
              runtimeText(ctx).generateDocument({ name: config.output.kind.toUpperCase() }) +
              (plannedDocuments ? ` ${runtimeText(ctx).plannedDocumentData}` : "") +
              (config.sourceVersions === "data" ? ` ${runtimeText(ctx).plannedSourceVersions}` : ""),
            output: {
              kind: "document",
              id: `dry-run:${ctx.stepKey}`,
              shortId: `dry-run:${ctx.stepKey}`,
              baseId: scope.baseId,
              tableId: null,
              templateId: null,
              recordId: null,
              primaryArtifactMimeType: documentQueryOutputMediaType(config.output.kind),
              planned: true,
            },
          };
        }
        if (
          !config.record ||
          !config.template ||
          config.output !== undefined ||
          config.sourceVersions !== undefined ||
          config.associatedData !== undefined
        )
          throw actionError("BAD_INPUT", documentServiceText(invocationLocale(ctx)).requestInvalidJson);
        const template = await documentTemplate(ctx);
        const renderer = template.renderer;
        await currentTable(ctx, scope, template.tableId);
        const record = await documentRecord(ctx, scope, template.tableId, config.record, "read");
        await requirePermission(scope, "write");
        return {
          summary: runtimeText(ctx).generateDocument({ name: template.name }),
          output: {
            kind: "document",
            id: `dry-run:${ctx.stepKey}`,
            shortId: `dry-run:${ctx.stepKey}`,
            baseId: scope.baseId,
            tableId: template.tableId,
            templateId: template.id,
            recordId: record.recordId,
            primaryArtifactMimeType:
              renderer.kind === "html"
                ? "application/pdf"
                : (documentIssuanceService.profiles().find((profile) => profile.id === renderer.id && profile.version === renderer.version)
                    ?.primaryArtifact.mediaType ?? null),
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
        if (document.tableId) await currentTable(ctx, scope, document.tableId);
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
        if (document.tableId) await currentTable(ctx, scope, document.tableId);
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

    cost: (_ctx, config) => ({ emails: config.to.length }),
    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const { template, recipients } = await emailInput(ctx, scope, config);
        return {
          summary: runtimeText(ctx).sendEmail({ name: template.name, count: recipients.length }),
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

    cost: () => ({ httpRequests: 1 }),
    plan: (ctx, config) =>
      planned(async () => {
        await requireExecution(await workflowRunScope(ctx));
        const request = httpInput(ctx, config);
        requireOk(await preflightWorkflowHttp({ ...request, locale: invocationLocale(ctx) }));
        return {
          summary: `${request.method} ${new URL(request.url).host}`,
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
