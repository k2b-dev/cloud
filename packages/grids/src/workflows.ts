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
import { summarizeDocumentRun } from "./service/document-mappers";
import { createDocumentLink, createRunForRecord, getDocumentRun, getTemplate, publicDocumentLinkBaseUrl } from "./service/documents";
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
  canExecuteRun,
  GridsWorkflowActionError,
  type GridsWorkflowActionScope,
  requireExecution,
  requireOk,
  requirePermission,
  requireRecordAccess,
  workflowAuditMeta,
  workflowRunScope,
} from "./service/workflow-action-scope";
import {
  type AtomicQueryPredicate,
  type AtomicRecordRef,
  atomicQueryMatches,
  lockAtomicRecords,
  requireAtomicTable,
} from "./service/workflow-atomic-records";
import { sendWorkflowEmail, type WorkflowEmailRecipient } from "./service/workflow-email-send";
import { preflightWorkflowHttp, requestWorkflowHttp } from "./service/workflow-http-client";

// ─── Shared config fragments ─────────────────────────────────────────────────

const saveAs = {
  kind: "string",
  format: "identifier",
  maxLength: 120,
  optional: true,
  description: "Name used to reference this action output in later steps.",
} as const;

const auditAnswers = {
  kind: "record",
  values: { kind: "value", description: "Answer value or select-option UUID." },
  optional: true,
  description: "Audit answers keyed by the table audit-question UUID.",
} as const;

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

const dateContext = async (): Promise<DateContext> => ({
  timeZone: normalizeTimeZone(String((await settingsGet<string>("app.timezone")) || "").trim(), "UTC"),
  locale: "en",
  firstDayOfWeek: 1,
});

const viewerForScope = (scope: GridsWorkflowActionScope) => ({
  userId: scope.principal.userId,
  userGroups: scope.principal.groupIds,
  serviceAccountId: scope.principal.serviceAccountId,
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

const currentTable = async (scope: GridsWorkflowActionScope, tableId: string): Promise<Table> => {
  const table = await getTable(tableId);
  if (!table || table.baseId !== scope.baseId) throw actionError("NOT_FOUND", "Workflow table is no longer available");
  return table;
};

const recordReference = async (ctx: WorkflowActionContext, reference: string, key: string): Promise<RuntimeRecord> => {
  const value = await ctx.resolveReference(reference, key);
  if (!isRuntimeRecord(value)) throw actionError("WORKFLOW_VALUE_INVALID", `${key} must resolve to a record`);
  return value;
};

/**
 * Reads a record after checking the actor may, and confirms it still exists.
 *
 * A planned record has no row yet — a dry run of "create then update" is a
 * legitimate plan — so it validates access and stops there.
 */
const readableRecord = async (scope: GridsWorkflowActionScope, reference: RuntimeRecord, required: "read" | "write"): Promise<void> => {
  await currentTable(scope, reference.tableId);
  const recordAccess = await requireRecordAccess(scope, reference.tableId, required);
  if (reference.planned) return;
  const record = await getRecord(reference.tableId, reference.recordId, {
    includeRelations: true,
    dateConfig: await dateContext(),
    recordAccess,
  });
  if (!record) throw actionError("NOT_FOUND", "Workflow record is no longer available");
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
      throw actionError("WORKFLOW_BINDING_MISSING", `${[...path, field].join(".")} has no stable binding`);
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
      throw actionError("WORKFLOW_BINDING_MISSING", `${[...path, field].join(".")} has no stable target binding`);
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
  client: SqlClient,
  tableId: string,
  typeFieldId: string,
  typeValue: string,
  originalFieldId: string,
  originalRecordId: string,
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
    throw actionError("WORKFLOW_BINDING_INVALID", "Correction type must use a current single-select option on the original Table");
  }
  const relationConfig = originalField?.config as { targetTableId?: unknown; cardinality?: unknown } | undefined;
  if (
    originalField?.type !== "relation" ||
    relationConfig?.targetTableId !== tableId ||
    (relationConfig.cardinality ?? "multiple") !== "single"
  ) {
    throw actionError("WORKFLOW_BINDING_INVALID", "Original Record must use a current single self-relation on the original Table");
  }
  return { [typeFieldId]: [typeValue], [originalFieldId]: originalRecordId };
};

const auditAnswerPayload = (answers: Record<string, WorkflowJsonValue> | undefined): RecordMutationAudit | undefined => {
  if (answers === undefined) return undefined;
  const resolved: Record<string, string> = {};
  for (const [questionId, value] of Object.entries(answers)) {
    if (typeof value !== "string") throw actionError("WORKFLOW_VALUE_INVALID", `audit.${questionId} must resolve to text`);
    resolved[questionId] = value;
  }
  return { answers: resolved };
};

const boundId = (ctx: WorkflowActionContext, key: string): string => {
  const id = ctx.binding(key);
  if (typeof id !== "string" || !id) throw actionError("WORKFLOW_BINDING_MISSING", `${key} has no stable binding`);
  return id;
};

const boundIdAt = (ctx: WorkflowActionContext, path: Array<string | number>): string => {
  const id = ctx.binding(...path);
  if (typeof id !== "string" || !id) {
    throw actionError("WORKFLOW_BINDING_MISSING", `${path.join(".")} has no stable binding`);
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
  if (!ctx.tx) throw actionError("WORKFLOW_EFFECT_INVALID", "Transactional workflow action ran without its transaction");
  return ctx.tx;
};

const documentTemplate = async (ctx: WorkflowActionContext) => {
  const template = await getTemplate(boundId(ctx, "template"));
  if (!template || !template.enabled) throw actionError("NOT_FOUND", "Document template is no longer available");
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
  if (record.tableId !== tableId) throw actionError("WORKFLOW_VALUE_INVALID", "Document record does not belong to the template table");
  await readableRecord(scope, record, required);
  return record;
};

const documentTags = (tags: WorkflowJsonValue[] | undefined): string[] =>
  (tags ?? []).flatMap((tag) => (typeof tag === "string" && tag.trim() ? [tag.trim()] : []));

const linkExpiry = (value: string | undefined): "1d" | "7d" | "30d" | "90d" =>
  value === "1d" || value === "7d" || value === "30d" || value === "90d" ? value : "30d";

type LinkableDocument = { id: string; baseId: string; tableId: string; templateId: string | null; recordId: string };

const documentReferenceId = (value: WorkflowJsonValue | undefined): { id: string; document: Record<string, WorkflowJsonValue> } => {
  const document = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!document || typeof document.id !== "string") {
    throw actionError("WORKFLOW_VALUE_INVALID", "createDocumentLink.document must resolve to a document");
  }
  return { id: document.id, document };
};

/** The document a link is created for. It has to exist: the link points at it. */
const documentToLink = async (ctx: WorkflowActionContext, scope: GridsWorkflowActionScope, reference: string) => {
  const { id } = documentReferenceId(await ctx.resolveReference(reference, "document"));
  const run = await getDocumentRun(id);
  if (!run || run.baseId !== scope.baseId) throw actionError("NOT_FOUND", "Generated document is no longer available");
  return run;
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
  const { id, document } = documentReferenceId(await ctx.resolveReference(reference, "document"));
  if (document.planned === true && typeof document.tableId === "string" && typeof document.recordId === "string") {
    return {
      id,
      baseId: scope.baseId,
      tableId: document.tableId,
      templateId: typeof document.templateId === "string" ? document.templateId : null,
      recordId: document.recordId,
    };
  }
  const run = await getDocumentRun(id);
  if (!run || run.baseId !== scope.baseId) throw actionError("NOT_FOUND", "Generated document is no longer available");
  return run;
};

const emailInput = async (
  ctx: WorkflowActionContext,
  scope: GridsWorkflowActionScope,
  config: { template: string; to: Array<{ email?: WorkflowJsonValue } | { user?: WorkflowJsonValue }> },
) => {
  const template = await getEmailTemplate(boundId(ctx, "template"));
  if (!template || template.baseId !== scope.baseId || !template.enabled) {
    throw actionError("NOT_FOUND", "Email template is no longer available");
  }
  const recipients: WorkflowEmailRecipient[] = [];
  for (const item of config.to) {
    const kind = "email" in item ? "email" : "user";
    const raw = kind === "email" ? (item as { email?: WorkflowJsonValue }).email : (item as { user?: WorkflowJsonValue }).user;
    if (typeof raw !== "string" || !raw.trim()) throw actionError("WORKFLOW_VALUE_INVALID", `sendEmail.${kind} must resolve to text`);
    const value = raw.trim();
    if (kind === "email" && !EMAIL_RE.test(value)) {
      throw actionError("WORKFLOW_VALUE_INVALID", "sendEmail.email must resolve to an email address");
    }
    if (kind === "user" && !UUID_RE.test(value)) {
      throw actionError("WORKFLOW_VALUE_INVALID", "sendEmail.user must resolve to a Cloud user id");
    }
    recipients.push({ kind, value });
  }
  return { template, recipients };
};

const httpInput = (config: {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  json?: WorkflowJsonValue;
  timeoutMs?: number;
}) => {
  try {
    new URL(config.url);
  } catch {
    throw actionError("WORKFLOW_ACTION_INVALID", "httpRequest.url must be an absolute URL");
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
    label: "Close record",
    description: "Finalizes directly or requests Four-eyes Finalization, according to the Table's current mode.",
    outputType: "grids.record",
    config: {
      kind: "object",
      properties: {
        record: { kind: "string", minLength: 1, maxLength: 500, description: "Record input or output reference." },
        expectedMode: {
          kind: "string",
          minLength: 1,
          maxLength: 500,
          optional: true,
          description: "Optional text reference that pins the previewed Direct or Four-eyes mode.",
        },
        expectedPolicyRevision: {
          kind: "string",
          minLength: 1,
          maxLength: 500,
          optional: true,
          description: "Optional number reference that pins the previewed Finalization policy revision.",
        },
      },
    },

    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const record = await recordReference(ctx, config.record, "record");
        await currentTable(scope, record.tableId);
        const recordAccess = await requireRecordAccess(scope, record.tableId, "write", tx);
        requireOk(await assertMutationAllowed(tx, record.tableId, "workflow"));
        const status = requireOk(await getRecordFinalizationStatus(record.tableId, tx));
        if (!status.enabled) throw actionError("BAD_INPUT", "Finalization is not enabled for this Table");
        const expectedPolicyRevision = config.expectedPolicyRevision
          ? await ctx.resolveReference(config.expectedPolicyRevision, "expectedPolicyRevision")
          : undefined;
        if (
          expectedPolicyRevision !== undefined &&
          (typeof expectedPolicyRevision !== "number" || !Number.isSafeInteger(expectedPolicyRevision) || expectedPolicyRevision < 1)
        ) {
          throw actionError("WORKFLOW_VALUE_INVALID", "expectedPolicyRevision must resolve to a positive integer");
        }
        if (config.expectedMode) {
          const expectedMode = await ctx.resolveReference(config.expectedMode, "expectedMode");
          if (expectedMode !== "direct" && expectedMode !== "fourEyes") {
            throw actionError("WORKFLOW_VALUE_INVALID", "expectedMode must resolve to direct or fourEyes");
          }
          if (status.mode !== expectedMode) {
            throw actionError("CONFLICT", "The Table Finalization mode changed after Close selection was previewed");
          }
        }

        if (status.mode === "fourEyes") {
          requireOk(
            await requestFinalizationInTransaction(tx, {
              tableId: record.tableId,
              recordId: record.recordId,
              actorId: actorId(scope),
              recordAccess,
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
              recordAccess,
              dateConfig: await dateContext(),
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
          message: status.mode === "fourEyes" ? "Finalization requested" : "Record finalized",
        };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const record = await recordReference(ctx, config.record, "record");
        await readableRecord(scope, record, "write");
        requireOk(await assertMutationAllowed(sql, record.tableId, "workflow"));
        const readiness = requireOk(
          await inspectRecordFinalization({
            tableId: record.tableId,
            recordId: record.recordId,
            actorId: actorId(scope),
            recordAccess: await requireRecordAccess(scope, record.tableId, "write"),
          }),
        );
        if (!readiness.enabled) throw actionError("BAD_INPUT", "Finalization is not enabled for this Table");
        if (config.expectedPolicyRevision) {
          const expectedPolicyRevision = await ctx.resolveReference(config.expectedPolicyRevision, "expectedPolicyRevision");
          if (typeof expectedPolicyRevision !== "number" || !Number.isSafeInteger(expectedPolicyRevision) || expectedPolicyRevision < 1) {
            throw actionError("WORKFLOW_VALUE_INVALID", "expectedPolicyRevision must resolve to a positive integer");
          }
          if (readiness.policyRevision !== expectedPolicyRevision) {
            throw actionError("CONFLICT", "The Table Finalization policy changed after Close selection was previewed");
          }
        }
        if (config.expectedMode) {
          const expectedMode = await ctx.resolveReference(config.expectedMode, "expectedMode");
          if (expectedMode !== "direct" && expectedMode !== "fourEyes") {
            throw actionError("WORKFLOW_VALUE_INVALID", "expectedMode must resolve to direct or fourEyes");
          }
          if (readiness.mode !== expectedMode) {
            throw actionError("CONFLICT", "The Table Finalization mode changed after Close selection was previewed");
          }
        }
        if (readiness.finalized) throw actionError("CONFLICT", "Record is already finalized");
        if (readiness.missing.length > 0) {
          throw actionError("BAD_INPUT", `Record is not ready to finalize: ${readiness.missing.map((item) => item.fieldName).join(", ")}`);
        }
        return {
          summary: readiness.mode === "fourEyes" ? "Request Four-eyes Finalization" : "Finalize one record permanently",
          output: record as unknown as WorkflowJsonValue,
        };
      }),
  }),

  createCorrectionDraft: workflowAction.transactional({
    label: "Create correction draft",
    description: "Creates one Draft linked to an unchanged finalized Record in the same Table.",
    outputType: "grids.record",
    config: {
      kind: "object",
      properties: {
        original: { kind: "string", minLength: 1, maxLength: 500, description: "Finalized original Record reference." },
        typeField: { kind: "string", minLength: 1, maxLength: 200, description: "Single-select field used for the correction type." },
        typeValue: { kind: "string", minLength: 1, maxLength: 200, description: "Existing select-option ID for a correction." },
        originalField: {
          kind: "string",
          minLength: 1,
          maxLength: 200,
          description: "Single self-relation that links the correction to its original Record.",
        },
      },
    },

    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const original = await recordReference(ctx, config.original, "original");
        if (original.planned) throw actionError("WORKFLOW_VALUE_INVALID", "original must reference an existing finalized Record");
        await currentTable(scope, original.tableId);
        const recordAccess = await requireRecordAccess(scope, original.tableId, "write", tx);
        const readiness = requireOk(
          await inspectRecordFinalization({
            tableId: original.tableId,
            recordId: original.recordId,
            actorId: actorId(scope),
            recordAccess,
            client: tx,
          }),
        );
        if (!readiness.finalized) throw actionError("CONFLICT", "Only a finalized Record can be corrected");
        const values = await correctionDraftValues(
          tx,
          original.tableId,
          boundId(ctx, "typeField"),
          config.typeValue,
          boundId(ctx, "originalField"),
          original.recordId,
        );
        const created = requireOk(
          await createRecordInTransaction(tx, original.tableId, values, actorId(scope), "workflow", {
            dateConfig: await dateContext(),
            recordAccess,
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
          message: "Correction Draft created",
        };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const original = await recordReference(ctx, config.original, "original");
        await readableRecord(scope, original, "write");
        requireOk(await assertMutationAllowed(sql, original.tableId, "workflow"));
        const recordAccess = await requireRecordAccess(scope, original.tableId, "write");
        const readiness = requireOk(
          await inspectRecordFinalization({
            tableId: original.tableId,
            recordId: original.recordId,
            actorId: actorId(scope),
            recordAccess,
          }),
        );
        if (!readiness.finalized) throw actionError("CONFLICT", "Only a finalized Record can be corrected");
        await correctionDraftValues(
          sql,
          original.tableId,
          boundId(ctx, "typeField"),
          config.typeValue,
          boundId(ctx, "originalField"),
          original.recordId,
        );
        return {
          summary: "Create one correction Draft linked to the finalized original Record",
          output: { kind: "record", tableId: original.tableId, recordId: `dry-run:${ctx.stepKey}`, planned: true },
        };
      }),
  }),

  finalizeRecord: workflowAction.transactional({
    label: "Finalize record",
    description: "Validates and permanently locks one record after a current permission check.",
    outputType: "grids.record",
    config: {
      kind: "object",
      properties: {
        record: { kind: "string", minLength: 1, maxLength: 500, description: "Record input or output reference." },
      },
    },

    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const record = await recordReference(ctx, config.record, "record");
        await currentTable(scope, record.tableId);
        const recordAccess = await requireRecordAccess(scope, record.tableId, "write", tx);
        const finalized = requireOk(
          await finalizeRecordInTransaction(tx, {
            tableId: record.tableId,
            recordId: record.recordId,
            actorId: actorId(scope),
            origin: "workflow",
            recordAccess,
            dateConfig: await dateContext(),
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
        await readableRecord(scope, record, "write");
        return { summary: "Finalize one record permanently", output: record as unknown as WorkflowJsonValue };
      }),
  }),

  updateRecord: workflowAction.transactional({
    label: "Update record",
    description: "Updates fields on one record after a current permission check.",
    outputType: "grids.record",
    config: {
      kind: "object",
      properties: {
        record: { kind: "string", minLength: 1, maxLength: 500, description: "Record input or output reference." },
        set: {
          kind: "record",
          minProperties: 1,
          values: { kind: "value", description: "Fields and values to update." },
          description: "Fields and values to update.",
        },
        audit: auditAnswers,
      },
    },

    run: (ctx, config) =>
      attempt(async () => {
        // Every check is on the transaction's own handle. Access can be revoked
        // between the run being queued and this step running, and a check on
        // another connection is checking a world this write will not see.
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const record = await recordReference(ctx, config.record, "record");
        await currentTable(scope, record.tableId);
        const recordAccess = await requireRecordAccess(scope, record.tableId, "write", tx);
        const values = fieldPayload(ctx, "set", config.set);
        const audit = auditAnswerPayload(config.audit);
        const updated = requireOk(
          await updateRecordInTransaction(tx, record.tableId, record.recordId, values, actorId(scope), "workflow", undefined, {
            dateConfig: await dateContext(),
            recordAccess,
            viewer: viewerForScope(scope),
            ...(audit ? { audit } : {}),
          }),
        );
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
        await readableRecord(scope, record, "write");
        const values = fieldPayload(ctx, "set", config.set);
        auditAnswerPayload(config.audit);
        return {
          summary: `Update ${Object.keys(values).length} field(s) on one record`,
          output: record as unknown as WorkflowJsonValue,
        };
      }),
  }),

  createRecord: workflowAction.transactional({
    label: "Create record",
    description: "Creates one record in a table after a current permission check.",
    outputType: "grids.record",
    config: {
      kind: "object",
      properties: {
        table: { kind: "string", minLength: 1, maxLength: 200, description: "Target table name or ID." },
        values: {
          kind: "record",
          minProperties: 1,
          values: { kind: "value", description: "Initial field values." },
          description: "Initial field values.",
        },
        saveAs,
      },
    },

    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const tableId = boundId(ctx, "table");
        await currentTable(scope, tableId);
        const recordAccess = await requireRecordAccess(scope, tableId, "write", tx);
        const values = fieldPayload(ctx, "values", config.values);
        const created = requireOk(
          await createRecordInTransaction(tx, tableId, values, actorId(scope), "workflow", {
            dateConfig: await dateContext(),
            recordAccess,
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
        await currentTable(scope, tableId);
        await requireRecordAccess(scope, tableId, "write");
        const values = fieldPayload(ctx, "values", config.values);
        return {
          summary: `Create one record with ${Object.keys(values).length} field(s)`,
          // Marked planned: a later step that cannot tell this from a real
          // record would act on a row that does not exist.
          output: { kind: "record", tableId, recordId: `dry-run:${ctx.stepKey}`, planned: true },
        };
      }),
  }),

  atomicRecords: workflowAction.transactional({
    label: "Atomic record change",
    description: "Locks records, checks current Grids data, and commits bounded record changes together or not at all.",
    config: {
      kind: "object",
      properties: {
        locks: {
          kind: "array",
          minItems: 1,
          maxItems: 100,
          items: { kind: "string", minLength: 1, maxLength: 500, description: "Record reference used to coordinate concurrent runs." },
          description: "Records locked in stable order before checks run.",
        },
        checks: {
          kind: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            kind: "object",
            properties: {
              table: { kind: "string", minLength: 1, maxLength: 200, description: "Table queried by this check." },
              where: {
                kind: "array",
                minItems: 1,
                maxItems: 20,
                items: {
                  kind: "object",
                  properties: {
                    field: { kind: "string", minLength: 1, maxLength: 200, description: "Field name or ID." },
                    op: { kind: "string", minLength: 1, maxLength: 80, description: "Grids filter operator." },
                    value: { kind: "value", optional: true, description: "Filter value." },
                    caseInsensitive: { kind: "boolean", optional: true, description: "Use case-insensitive text comparison." },
                  },
                },
                description: "Bound predicates combined with AND.",
              },
              assert: {
                kind: "string",
                enum: ["empty", "notEmpty"],
                description: "Whether the query must match no records or at least one record.",
              },
              message: {
                kind: "string",
                minLength: 1,
                maxLength: 500,
                optional: true,
                description: "Failure shown when the assertion is false.",
              },
            },
          },
          description: "Current-state assertions evaluated while coordination records are locked.",
        },
        changes: {
          kind: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            kind: "union",
            variants: [
              {
                kind: "object",
                properties: {
                  createRecord: {
                    kind: "object",
                    properties: {
                      table: { kind: "string", minLength: 1, maxLength: 200, description: "Target table name or ID." },
                      values: {
                        kind: "record",
                        minProperties: 1,
                        values: { kind: "value", description: "Initial field values." },
                        description: "Initial field values.",
                      },
                    },
                  },
                },
              },
              {
                kind: "object",
                properties: {
                  updateRecord: {
                    kind: "object",
                    properties: {
                      record: { kind: "string", minLength: 1, maxLength: 500, description: "Record input or output reference." },
                      set: {
                        kind: "record",
                        minProperties: 1,
                        values: { kind: "value", description: "Fields and values to update." },
                        description: "Fields and values to update.",
                      },
                      ifVersion: {
                        kind: "number",
                        integer: true,
                        minimum: 1,
                        optional: true,
                        description: "Optional optimistic record version.",
                      },
                      audit: auditAnswers,
                    },
                  },
                },
              },
            ],
          },
          description: "Record creates and updates committed in order.",
        },
      },
    },

    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const dates = await dateContext();

        const locks: AtomicRecordRef[] = [];
        for (let index = 0; index < config.locks.length; index += 1) {
          const record = await recordReference(ctx, config.locks[index]!, `locks.${index}`);
          if (record.planned) throw actionError("WORKFLOW_VALUE_INVALID", `locks.${index} must reference an existing record`);
          locks.push({ tableId: record.tableId, recordId: record.recordId, required: "read" });
        }
        for (let index = 0; index < config.changes.length; index += 1) {
          const change = config.changes[index]!;
          if (!("updateRecord" in change)) continue;
          const record = await recordReference(ctx, change.updateRecord.record, `changes.${index}.updateRecord.record`);
          if (record.planned)
            throw actionError("WORKFLOW_VALUE_INVALID", `changes.${index}.updateRecord.record must reference an existing record`);
          locks.push({ tableId: record.tableId, recordId: record.recordId, required: "write" });
        }

        const accessCache = new Map<string, Awaited<ReturnType<typeof requireRecordAccess>>>();
        const accessFor = async (tableId: string, required: "read" | "write") => {
          const key = `${tableId}:${required}`;
          const cached = accessCache.get(key);
          if (cached) return cached;
          await requireAtomicTable(tx, scope.baseId, tableId);
          const access = await requireRecordAccess(scope, tableId, required, tx);
          accessCache.set(key, access);
          return access;
        };
        await lockAtomicRecords(tx, locks, (record) => accessFor(record.tableId, record.required));

        for (let checkIndex = 0; checkIndex < config.checks.length; checkIndex += 1) {
          const check = config.checks[checkIndex]!;
          const tableId = boundIdAt(ctx, ["checks", checkIndex, "table"]);
          const access = await accessFor(tableId, "read");
          const predicates: AtomicQueryPredicate[] = check.where.map((predicate, predicateIndex) => ({
            fieldId: boundIdAt(ctx, ["checks", checkIndex, "where", predicateIndex, "field"]),
            op: predicate.op,
            ...(predicate.value === undefined ? {} : { value: predicate.value }),
            ...(predicate.caseInsensitive === undefined ? {} : { caseInsensitive: predicate.caseInsensitive }),
          }));
          const matches = await atomicQueryMatches({ client: tx, tableId, predicates, access, timeZone: dates.timeZone ?? "UTC" });
          const passed = check.assert === "empty" ? !matches : matches;
          if (!passed) throw actionError("ATOMIC_CHECK_FAILED", check.message?.trim() || "Atomic record check failed");
        }

        const created: RuntimeRecord[] = [];
        const updated: RuntimeRecord[] = [];
        for (let changeIndex = 0; changeIndex < config.changes.length; changeIndex += 1) {
          const change = config.changes[changeIndex]!;
          if ("createRecord" in change) {
            const tableId = boundIdAt(ctx, ["changes", changeIndex, "createRecord", "table"]);
            const access = await accessFor(tableId, "write");
            const values = atomicFieldPayloadAt(ctx, ["changes", changeIndex, "createRecord", "values"], change.createRecord.values);
            const result = requireOk(
              await createRecordInTransaction(tx, tableId, values, actorId(scope), "workflow", {
                dateConfig: dates,
                recordAccess: access,
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
          const access = await accessFor(record.tableId, "write");
          const values = atomicFieldPayloadAt(ctx, ["changes", changeIndex, "updateRecord", "set"], change.updateRecord.set);
          const audit = auditAnswerPayload(change.updateRecord.audit);
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
                recordAccess: access,
                viewer: viewerForScope(scope),
                ...(audit ? { audit } : {}),
              },
            ),
          );
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
          updated.push({ kind: "record", tableId: record.tableId, recordId: result.record.id });
        }

        return { state: "succeeded", output: { created, updated } as unknown as WorkflowJsonValue };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const dates = await dateContext();
        const issues: string[] = [];

        for (let index = 0; index < config.locks.length; index += 1) {
          const record = await recordReference(ctx, config.locks[index]!, `locks.${index}`);
          await readableRecord(scope, record, "read");
        }
        for (let checkIndex = 0; checkIndex < config.checks.length; checkIndex += 1) {
          const check = config.checks[checkIndex]!;
          const tableId = boundIdAt(ctx, ["checks", checkIndex, "table"]);
          await currentTable(scope, tableId);
          const access = await requireRecordAccess(scope, tableId, "read");
          const predicates: AtomicQueryPredicate[] = check.where.map((predicate, predicateIndex) => ({
            fieldId: boundIdAt(ctx, ["checks", checkIndex, "where", predicateIndex, "field"]),
            op: predicate.op,
            ...(predicate.value === undefined ? {} : { value: predicate.value }),
            ...(predicate.caseInsensitive === undefined ? {} : { caseInsensitive: predicate.caseInsensitive }),
          }));
          const matches = await atomicQueryMatches({ tableId, predicates, access, timeZone: dates.timeZone ?? "UTC" });
          if ((check.assert === "empty" && matches) || (check.assert === "notEmpty" && !matches)) {
            issues.push(check.message?.trim() || `Check ${checkIndex + 1} does not currently pass.`);
          }
        }
        for (let changeIndex = 0; changeIndex < config.changes.length; changeIndex += 1) {
          const change = config.changes[changeIndex]!;
          if ("createRecord" in change) {
            const tableId = boundIdAt(ctx, ["changes", changeIndex, "createRecord", "table"]);
            await currentTable(scope, tableId);
            await requireRecordAccess(scope, tableId, "write");
            atomicFieldPayloadAt(ctx, ["changes", changeIndex, "createRecord", "values"], change.createRecord.values);
          } else {
            const record = await recordReference(ctx, change.updateRecord.record, `changes.${changeIndex}.updateRecord.record`);
            await readableRecord(scope, record, "write");
            atomicFieldPayloadAt(ctx, ["changes", changeIndex, "updateRecord", "set"], change.updateRecord.set);
            auditAnswerPayload(change.updateRecord.audit);
          }
        }
        return {
          summary: `Run ${config.checks.length} check(s), then commit ${config.changes.length} record change(s) atomically. Record state can change before execution; checks run again while locks are held.`,
          issues,
        };
      }),
  }),

  generateDocument: workflowAction.idempotent({
    label: "Generate document",
    description: "Creates a frozen document snapshot from a configured template.",
    outputType: "grids.document",
    config: {
      kind: "object",
      properties: {
        template: { kind: "string", minLength: 1, maxLength: 200, description: "Document template name or ID." },
        record: { kind: "string", minLength: 1, maxLength: 500, description: "Record input or output reference." },
        filename: { kind: "value", optional: true, description: "Optional filename override." },
        tags: { kind: "array", items: { kind: "value", description: "Tag value." }, maxItems: 20, optional: true },
        saveAs,
      },
    },

    authorize: mayExecute,

    run: (ctx, config) =>
      attempt(async () => {
        await ctx.heartbeat();
        const scope = await workflowRunScope(ctx);
        const template = await documentTemplate(ctx);
        const table = await currentTable(scope, template.tableId);
        const record = await documentRecord(ctx, scope, table.id, config.record, "read");
        await requirePermission(scope, "write");
        const recordAccess = await requireRecordAccess(scope, table.id, "read");
        const run = requireOk(
          await createRunForRecord({
            template,
            table,
            recordId: record.recordId,
            actorId: actorId(scope),
            recordAccess,
            resolveRecordAccess: ({ tableId }) => requireRecordAccess(scope, tableId, "read").catch(() => null),
            viewer: {
              userId: scope.principal.userId,
              userGroups: scope.principal.groupIds,
              serviceAccountId: scope.principal.serviceAccountId,
            },
            dateConfig: await dateContext(),
            filename: typeof config.filename === "string" ? config.filename : null,
            tags: documentTags(config.tags),
            workflowRunId: scope.runId,
            workflowStepKey: ctx.stepKey,
          }),
        );
        await logAudit({
          baseId: scope.baseId,
          tableId: run.tableId,
          recordId: run.recordId,
          userId: actorId(scope),
          action: "workflow.document.generated",
          diff: {
            workflowDocumentGenerate: {
              old: null,
              new: {
                ...workflowAuditMeta(scope),
                templateId: template.id,
                documentRunId: run.id,
                documentNumber: run.documentNumber,
                filename: run.filename,
              },
            },
          },
        });
        // Only the summary. The document run already carries the rendered
        // record content, so copying it into the step outcome would duplicate
        // a potentially large immutable payload.
        return { state: "succeeded", output: summarizeDocumentRun(run) as unknown as WorkflowJsonValue };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const template = await documentTemplate(ctx);
        await currentTable(scope, template.tableId);
        const record = await documentRecord(ctx, scope, template.tableId, config.record, "read");
        await requirePermission(scope, "write");
        return {
          summary: `Generate "${template.name}" for one record`,
          consumes: { documents: 1 },
          output: {
            kind: "documentRun",
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
    label: "Create document link",
    description: "Creates a revocable public download link for a generated document.",
    outputType: "grids.documentLink",
    config: {
      kind: "object",
      properties: {
        document: { kind: "string", minLength: 1, maxLength: 500, description: "Document output reference." },
        expiresIn: { kind: "string", enum: ["1d", "7d", "30d", "90d"], optional: true, description: "How long the link stays valid." },
        comment: { kind: "value", optional: true, description: "Optional link comment." },
        saveAs,
      },
    },

    run: (ctx, config) =>
      attempt(async () => {
        const tx = transaction(ctx);
        const scope = await workflowRunScope(ctx, tx);
        await requireExecution(scope, tx);
        const run = await documentToLink(ctx, scope, config.document);
        await currentTable(scope, run.tableId);
        await requirePermission(scope, "write", tx);
        const expiresIn = linkExpiry(config.expiresIn);
        const baseUrl = await publicDocumentLinkBaseUrl();
        const created = requireOk(
          await createDocumentLink({
            run,
            input: { expiresIn, comment: typeof config.comment === "string" ? config.comment : null },
            actorId: actorId(scope),
            client: tx,
          }),
        );
        await logAudit(
          {
            baseId: scope.baseId,
            tableId: run.tableId,
            recordId: run.recordId,
            userId: actorId(scope),
            action: "workflow.document_link.created",
            diff: {
              workflowDocumentLinkCreate: {
                old: null,
                new: {
                  ...workflowAuditMeta(scope),
                  documentRunId: run.id,
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
            documentRunId: run.id,
            url: `${baseUrl}${encodeURIComponent(created.token)}`,
            expiresAt: created.link.expiresAt,
          },
        };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        const scope = await workflowRunScope(ctx);
        await requireExecution(scope);
        const run = await plannedDocumentToLink(ctx, scope, config.document);
        await currentTable(scope, run.tableId);
        await requirePermission(scope, "write");
        const expiresIn = linkExpiry(config.expiresIn);
        return {
          summary: `Create a ${expiresIn} download link for one document`,
          output: {
            kind: "documentLink",
            id: `dry-run:${ctx.stepKey}`,
            documentRunId: run.id,
            url: `https://example.invalid/grids-document-link/${encodeURIComponent(ctx.stepKey)}`,
            expiresIn,
            planned: true,
          },
        };
      }),
  }),

  sendEmail: workflowAction.idempotent({
    label: "Send email",
    description: "Renders a Grids email template and delivers it to each recipient exactly once.",
    outputType: "grids.emailDelivery",
    config: {
      kind: "object",
      properties: {
        template: { kind: "string", minLength: 1, maxLength: 200, description: "Email template name or ID." },
        to: {
          kind: "array",
          minItems: 1,
          maxItems: 50,
          description: "Recipients, by address or by Cloud user.",
          items: {
            kind: "union",
            variants: [
              { kind: "object", properties: { email: { kind: "value", description: "Email address." } } },
              { kind: "object", properties: { user: { kind: "value", description: "User ID." } } },
            ],
          },
        },
        data: { kind: "record", values: { kind: "value", description: "Template value." }, optional: true, maxProperties: 200 },
        saveAs,
      },
    },

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
          summary: `Send "${template.name}" to ${recipients.length} recipient(s)`,
          consumes: { emails: recipients.length },
        };
      }),
  }),

  httpRequest: workflowAction.ambiguous({
    label: "HTTP request",
    description: "Sends an explicit JSON HTTP request. Ambiguous remote outcomes are never retried blindly.",
    outputType: "core.value",
    config: {
      kind: "object",
      properties: {
        method: { kind: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], optional: true, description: "HTTP method." },
        url: { kind: "string", format: "uri", maxLength: 4_000, description: "HTTP or HTTPS URL." },
        headers: {
          kind: "record",
          values: { kind: "string", minLength: 1, maxLength: 1_000, description: "Header value." },
          optional: true,
          maxProperties: 100,
        },
        json: { kind: "value", optional: true, description: "JSON request payload." },
        timeoutMs: { kind: "number", integer: true, minimum: 1_000, maximum: 60_000, optional: true, description: "Request timeout." },
        saveAs,
      },
    },

    authorize: mayExecute,

    run: (ctx, config) =>
      attempt(async () => {
        await ctx.heartbeat();
        const scope = await workflowRunScope(ctx);
        const request = httpInput(config);
        const response = await requestWorkflowHttp({ ...request, idempotencyKey: ctx.effectKey });
        // The request left the process and no complete answer came back. It may
        // have been acted on; repeating it is how a webhook fires twice.
        if (!response.ok && response.error.code === "WORKFLOW_HTTP_OUTCOME_UNKNOWN") {
          return { state: "ambiguous", message: response.error.message, code: response.error.code };
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
        if (!result.ok) throw actionError("WORKFLOW_HTTP_FAILED", `httpRequest returned HTTP ${result.status}`);
        return { state: "succeeded", output: { status: result.status, ok: result.ok, body: result.body } };
      }),

    plan: (ctx, config) =>
      planned(async () => {
        await requireExecution(await workflowRunScope(ctx));
        const request = httpInput(config);
        requireOk(await preflightWorkflowHttp(request));
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
    reconcile: async () => ({
      state: "unknown",
      code: "WORKFLOW_HTTP_OUTCOME_UNKNOWN",
      message: "A previous HTTP attempt may have reached the remote service; it is not repeated automatically.",
    }),
  }),
};
