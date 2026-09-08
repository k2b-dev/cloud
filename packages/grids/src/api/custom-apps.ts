import { Buffer } from "node:buffer";
import { type AuthContext, auth, getDateConfig, getLocale, respond } from "@valentinkolb/cloud/server";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { type Field, type GridRecord, ShortIdSchema } from "../contracts";
import { customAppPageRecordFieldIds } from "../custom-apps/conditions";
import { CUSTOM_APP_REFERENCE, CustomAppDefinitionInputSchema } from "../custom-apps/contracts";
import { customAppDiagnostic } from "../custom-apps/diagnostics";
import { customAppFileTokenMatchesContext, verifyCustomAppFileToken } from "../custom-apps/file-token";
import { projectCustomAppRecord } from "../custom-apps/record-projection";
import { customAppRecordsDisplayFieldHash, isSafeInlineCardImageMimeType } from "../custom-apps/records-display-capability";
import {
  customAppActionStatusUrl,
  customAppFormSuccessHref,
  customAppScannerRunUrl,
  customAppSidebarFormSuccessHref,
} from "../custom-apps/routing";
import { resolveCustomAppValueBinding } from "../custom-apps/value-bindings";
import { isRecordWritableFieldType } from "../field-types";
import { toWorkflowRunEventSummary } from "../lib/workflow-run-events";
import { gridsService } from "../service";
import { resolvePublishedCustomAppForm } from "../service/custom-app-published-form";
import { buildCustomAppRecordLabelCache } from "../service/custom-app-record-relations";
import { executePublishedCustomAppRecords } from "../service/custom-app-records-query";
import type { CustomApp, CustomAppDraftSave, CustomAppSummary } from "../service/custom-apps";
import { getMaxFileSizeBytes } from "../service/file-limits";
import { type PublicResourceType, projectPublicId, projectPublicIds, resolvePublicId, resolvePublicIds } from "../service/public-resources";
import type { RecordComment } from "../service/record-comments";
import type { GridFile } from "../service/types";
import { getWorkflowRunScope } from "../service/workflow-runs";
import { resolvePublishedCustomAppGlobalRuntime, resolvePublishedCustomAppRuntime } from "./custom-app-published-runtime";
import { encodeHeaderValue, pdfResponse } from "./download-response";
import { FormSubmitSchema, parseFormSubmission } from "./form-api-shared";
import { apiMessages } from "./messages";
import { accessActorUser, currentActorUserId, currentWorkflowPrincipal, gateAt, gridsAccessContext } from "./permissions";
import { internalIdParam, requirePublicIdParam } from "./route-params";
import { v } from "./validator";
import { ScannerLauncherRequestSchema } from "./workflow-api-shared";

const DefinitionBaseSchema = z.object({ baseId: ShortIdSchema });
const CustomAppCreateSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();
const RecordCommentBodySchema = z.object({ body: z.string().max(10_000) }).strict();
const CustomAppRecordUpdateSchema = z
  .object({
    values: z.record(ShortIdSchema, z.unknown()),
    audit: z
      .object({
        // Audit question IDs are definition-local identifiers, not public Grids resources.
        answers: z.record(z.string().uuid(), z.string().max(10_000)).default({}),
      })
      .strict()
      .optional(),
  })
  .strict();
const CustomAppActionInvocationSchema = z.object({ operationId: z.string().uuid() }).strict();
const CustomAppRowActionInvocationSchema = z
  .object({
    operationId: z.string().uuid(),
    rowId: ShortIdSchema,
    search: z.string().max(200).optional(),
    cursor: z.string().max(16_384).optional(),
  })
  .strict();
const CustomAppRecordsQuerySchema = z
  .object({ q: z.string().max(200).optional(), cursor: z.string().max(16_384).optional() })
  .passthrough();
const RecordCommentListQuerySchema = z
  .object({
    cursor: z.string().max(2_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .passthrough();

const requiredPublicId = async (type: PublicResourceType, internalId: string): Promise<string> => {
  const publicId = await projectPublicId(type, internalId);
  if (!publicId) throw new Error(`Missing public id for Grids ${type} ${internalId}`);
  return publicId;
};

const requiredProjected = (ids: ReadonlyMap<string, string>, internalId: string, type: PublicResourceType): string => {
  const publicId = ids.get(internalId);
  if (!publicId) throw new Error(`Missing public id for Grids ${type} ${internalId}`);
  return publicId;
};

const resolveFieldValues = async (values: Readonly<Record<string, unknown>>): Promise<Record<string, unknown> | null> => {
  const fieldIds = Object.keys(values);
  if (fieldIds.some((fieldId) => !ShortIdSchema.safeParse(fieldId).success)) return null;
  const resolved = await resolvePublicIds("field", fieldIds);
  if (resolved.size !== fieldIds.length) return null;
  return Object.fromEntries(Object.entries(values).map(([fieldId, value]) => [resolved.get(fieldId)!, value]));
};

const resolveFormSubmission = async (submitted: Record<string, unknown>) => {
  const parsed = parseFormSubmission(submitted);
  if (!parsed) return null;
  const fieldIds = [
    ...Object.keys(parsed.data),
    ...Object.keys(parsed.inlineCreates),
    ...Object.values(parsed.inlineCreates).flatMap((drafts) => drafts.flatMap((draft) => Object.keys(draft.data))),
  ];
  if (fieldIds.some((fieldId) => !ShortIdSchema.safeParse(fieldId).success)) return null;
  const resolved = await resolvePublicIds("field", fieldIds);
  if (resolved.size !== new Set(fieldIds).size) return null;
  return {
    data: Object.fromEntries(Object.entries(parsed.data).map(([id, value]) => [resolved.get(id)!, value])),
    inlineCreates: Object.fromEntries(
      Object.entries(parsed.inlineCreates).map(([id, drafts]) => [
        resolved.get(id)!,
        drafts.map((draft) => ({
          ...draft,
          data: Object.fromEntries(Object.entries(draft.data).map(([draftId, value]) => [resolved.get(draftId)!, value])),
        })),
      ]),
    ),
  };
};

const collectUuidValues = (value: unknown, output: Set<string>): void => {
  if (typeof value === "string") {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) output.add(value);
    return;
  }
  if (Array.isArray(value)) for (const item of value) collectUuidValues(item, output);
};

const projectRecordValues = (
  values: Readonly<Record<string, unknown>>,
  fieldIds: ReadonlyMap<string, string>,
  recordIds: ReadonlyMap<string, string>,
  relationFieldIds: ReadonlySet<string>,
): Record<string, unknown> => {
  const projectValue = (value: unknown): unknown => {
    if (typeof value === "string") return recordIds.get(value) ?? value;
    if (Array.isArray(value)) return value.map(projectValue);
    return value;
  };
  return Object.fromEntries(
    Object.entries(values).map(([fieldId, value]) => [
      fieldIds.get(fieldId) ?? fieldId,
      relationFieldIds.has(fieldId) ? projectValue(value) : value,
    ]),
  );
};

const projectField = (field: Field, tableIds: ReadonlyMap<string, string>, fieldIds: ReadonlyMap<string, string>) => {
  const config = { ...field.config };
  if (typeof config.targetTableId === "string") config.targetTableId = requiredProjected(tableIds, config.targetTableId, "table");
  if (typeof config.displayFieldId === "string") config.displayFieldId = requiredProjected(fieldIds, config.displayFieldId, "field");
  if (typeof config.relationFieldId === "string") config.relationFieldId = requiredProjected(fieldIds, config.relationFieldId, "field");
  if (typeof config.targetFieldId === "string") config.targetFieldId = requiredProjected(fieldIds, config.targetFieldId, "field");
  if (Array.isArray(config.labelFieldIds))
    config.labelFieldIds = config.labelFieldIds.map((id) => (typeof id === "string" ? requiredProjected(fieldIds, id, "field") : id));
  return {
    id: field.shortId,
    tableId: requiredProjected(tableIds, field.tableId, "table"),
    name: field.name,
    description: field.description,
    icon: field.icon,
    type: field.type,
    config,
    position: field.position,
    required: field.required,
    presentable: field.presentable,
    hideInTable: field.hideInTable,
    defaultValue: field.defaultValue,
    indexed: field.indexed,
    uniqueConstraint: field.uniqueConstraint,
    deletedAt: field.deletedAt,
    createdAt: field.createdAt,
    updatedAt: field.updatedAt,
  };
};

const projectGridRecord = async (record: GridRecord, fields: readonly Field[]) => {
  const relationFieldIds = new Set(fields.filter((field) => field.type === "relation").map((field) => field.id));
  const recordValueIds = new Set<string>();
  for (const [fieldId, value] of Object.entries(record.data)) if (relationFieldIds.has(fieldId)) collectUuidValues(value, recordValueIds);
  const [recordIds, tableIds, fieldIds] = await Promise.all([
    projectPublicIds("record", [record.id, ...recordValueIds]),
    projectPublicIds("table", [record.tableId]),
    projectPublicIds("field", Object.keys(record.data)),
  ]);
  return {
    id: requiredProjected(recordIds, record.id, "record"),
    tableId: requiredProjected(tableIds, record.tableId, "table"),
    data: projectRecordValues(record.data, fieldIds, recordIds, relationFieldIds),
    version: record.version,
    ...(record.finalizedAt ? { finalizedAt: record.finalizedAt, finalizedBy: record.finalizedBy ?? null } : {}),
    deletedAt: record.deletedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
};

const projectGridFile = async (file: GridFile) => {
  const [recordId, fieldId] = await Promise.all([requiredPublicId("record", file.recordId), requiredPublicId("field", file.fieldId)]);
  return {
    id: file.shortId,
    recordId,
    fieldId,
    position: file.position,
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    createdBy: file.createdBy,
    createdAt: file.createdAt,
  };
};

const projectComment = (comment: RecordComment) => ({
  id: comment.shortId,
  authorUserId: comment.authorUserId,
  authorDisplayName: comment.authorDisplayName,
  authorAvatarHash: comment.authorAvatarHash,
  body: comment.body,
  deletedAt: comment.deletedAt,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
});

const rewriteCommentCursor = async (cursor: string | null | undefined, direction: "resolve" | "project"): Promise<string | null> => {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return null;
    const commentId = direction === "resolve" ? await resolvePublicId("comment", parsed[1]) : await projectPublicId("comment", parsed[1]);
    return commentId ? Buffer.from(JSON.stringify([parsed[0], commentId]), "utf8").toString("base64url") : null;
  } catch {
    return null;
  }
};

const capabilityResourceType = (key: string): PublicResourceType | null => {
  switch (key) {
    case "tableId":
    case "tableIds":
    case "primaryTableId":
    case "targetTableId":
      return "table";
    case "fieldId":
    case "fieldIds":
    case "imageFieldId":
    case "dateFieldId":
    case "editableFieldIds":
    case "labelFieldIds":
    case "userInputFieldIds":
    case "fixedFieldIds":
      return "field";
    case "viewId":
      return "view";
    case "formId":
      return "form";
    case "templateIds":
      return "documentTemplate";
    case "launcherId":
      return "workflowLauncher";
    case "workflowId":
      return "workflow";
    default:
      return null;
  }
};

const collectCapabilityIds = (value: unknown, ids: Map<PublicResourceType, Set<string>>): void => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const type = capabilityResourceType(key);
    if (type) {
      const values = Array.isArray(entry) ? entry : [entry];
      for (const id of values) if (typeof id === "string") ids.get(type)!.add(id);
    }
    if (Array.isArray(entry)) for (const item of entry) collectCapabilityIds(item, ids);
    else collectCapabilityIds(entry, ids);
  }
};

const projectCapabilityIds = (value: unknown, maps: Map<PublicResourceType, Map<string, string>>): void => {
  if (Array.isArray(value)) {
    for (const item of value) projectCapabilityIds(item, maps);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const type = capabilityResourceType(key);
    if (type && typeof entry === "string") {
      Object.assign(value, { [key]: requiredProjected(maps.get(type)!, entry, type) });
      continue;
    }
    if (type && Array.isArray(entry)) {
      Object.assign(value, {
        [key]: entry.map((id) => (typeof id === "string" ? requiredProjected(maps.get(type)!, id, type) : id)),
      });
      continue;
    }
    projectCapabilityIds(entry, maps);
  }
};

const projectCapabilities = async (capabilities: CustomApp["draftCapabilities"]) => {
  if (!capabilities) return null;
  const projected = structuredClone(capabilities);
  const ids = new Map<PublicResourceType, Set<string>>(
    (["table", "field", "view", "form", "documentTemplate", "workflowLauncher", "workflow"] as const).map((type) => [type, new Set()]),
  );
  collectCapabilityIds(capabilities, ids);
  const maps = new Map<PublicResourceType, Map<string, string>>();
  for (const [type, values] of ids) maps.set(type, await projectPublicIds(type, [...values]));
  projectCapabilityIds(projected, maps);
  return projected;
};

export const projectCustomApp = async (app: CustomApp) => {
  const baseId = await requiredPublicId("base", app.baseId);
  const draftCapabilities = await projectCapabilities(app.draftCapabilities);
  const publishedCapabilities = await projectCapabilities(app.publishedCapabilities);
  return {
    id: app.shortId,
    baseId,
    name: app.name,
    icon: app.icon,
    draftDefinition: app.draftDefinition,
    draftDiagnostics: app.draftDiagnostics,
    draftCapabilities,
    publishedDefinition: app.publishedDefinition,
    publishedDiagnostics: app.publishedDiagnostics,
    publishedCapabilities,
    publishedAt: app.publishedAt,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    draftValid: app.draftValid,
    publishedValid: app.publishedValid,
    hasUnpublishedChanges: app.hasUnpublishedChanges,
  };
};

export const projectCustomAppSummaries = async (apps: readonly CustomAppSummary[]) => {
  const bases = await projectPublicIds(
    "base",
    apps.map((app) => app.baseId),
  );
  return apps.map(({ id: _id, shortId, baseId, ...app }) => ({
    ...app,
    id: shortId,
    baseId: requiredProjected(bases, baseId, "base"),
  }));
};

const projectDraftSave = async (saved: CustomAppDraftSave) => ({ ...saved, app: await projectCustomApp(saved.app) });

const projectRecordParams = async (params: Readonly<Record<string, string>>): Promise<Record<string, string>> => {
  const recordIds = await projectPublicIds("record", Object.values(params));
  return Object.fromEntries(Object.entries(params).map(([key, id]) => [key, requiredProjected(recordIds, id, "record")]));
};

const projectWorkflowInvocation = async <T extends { runId: string; workflowId: string; status: string }>(data: T) => ({
  runId: await requiredPublicId("workflowRun", data.runId),
  workflowId: await requiredPublicId("workflow", data.workflowId),
  revision: "revision" in data ? data.revision : undefined,
  mode: "mode" in data ? data.mode : undefined,
  channel: "channel" in data ? data.channel : undefined,
  created: "created" in data ? data.created : undefined,
  status: data.status,
});

const projectWorkflowRunSummary = async (run: Parameters<typeof toWorkflowRunEventSummary>[0]) => {
  const summary = toWorkflowRunEventSummary(run);
  const [id, workflowId, launcherId, baseId] = await Promise.all([
    requiredPublicId("workflowRun", summary.id),
    summary.workflowId ? requiredPublicId("workflow", summary.workflowId) : null,
    summary.launcherId ? requiredPublicId("workflowLauncher", summary.launcherId) : null,
    requiredPublicId("base", summary.baseId),
  ]);
  return {
    id,
    workflowId,
    launcherId,
    baseId,
    workflowRevision: summary.workflowRevision,
    mode: summary.mode,
    channel: summary.channel,
    status: summary.status,
    error: summary.error,
    resultMessage: summary.resultMessage,
    createdAt: summary.createdAt,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    operatorMessage: summary.operatorMessage,
  };
};

const projectPublishedRecords = async (published: NonNullable<Awaited<ReturnType<typeof executePublishedCustomAppRecords>>>) => {
  const tableInternalIds = new Set([published.primaryTableId]);
  const fieldInternalIds = new Set<string>();
  const recordInternalIds = new Set<string>();
  const fileInternalIds = new Set<string>();
  const addField = (field: Field) => {
    fieldInternalIds.add(field.id);
    tableInternalIds.add(field.tableId);
    const targetTableId = field.config.targetTableId;
    if (typeof targetTableId === "string") tableInternalIds.add(targetTableId);
    const displayFieldId = field.config.displayFieldId;
    if (typeof displayFieldId === "string") fieldInternalIds.add(displayFieldId);
    const relationFieldId = field.config.relationFieldId;
    if (typeof relationFieldId === "string") fieldInternalIds.add(relationFieldId);
    const targetFieldId = field.config.targetFieldId;
    if (typeof targetFieldId === "string") fieldInternalIds.add(targetFieldId);
    const labelFieldIds = field.config.labelFieldIds;
    if (Array.isArray(labelFieldIds)) for (const id of labelFieldIds) if (typeof id === "string") fieldInternalIds.add(id);
  };
  if (published.response.ok) {
    for (const column of published.response.columns) {
      if (column.tableId) tableInternalIds.add(column.tableId);
      if (column.fieldId) fieldInternalIds.add(column.fieldId);
    }
    for (const row of published.response.rows) {
      if (row.recordId) recordInternalIds.add(row.recordId);
      if (row.tableId) tableInternalIds.add(row.tableId);
    }
  }
  for (const field of published.presentation?.fields ?? []) addField(field);
  for (const field of published.cards?.fields ?? []) addField(field);
  const relationFieldIds = new Set(
    [...(published.presentation?.fields ?? []), ...(published.cards?.fields ?? [])]
      .filter((field) => field.type === "relation")
      .map((field) => field.id),
  );
  const relationValueKeys = new Set(relationFieldIds);
  if (published.response.ok)
    for (const column of published.response.columns)
      if (column.fieldId && relationFieldIds.has(column.fieldId)) relationValueKeys.add(column.key);
  if (published.response.ok)
    for (const row of published.response.rows)
      for (const [fieldId, value] of Object.entries(row.values))
        if (relationValueKeys.has(fieldId)) collectUuidValues(value, recordInternalIds);
  for (const record of published.cards?.records ?? []) {
    recordInternalIds.add(record.id);
    tableInternalIds.add(record.tableId);
    Object.keys(record.data).forEach((id) => fieldInternalIds.add(id));
    for (const [fieldId, value] of Object.entries(record.data))
      if (relationFieldIds.has(fieldId)) collectUuidValues(value, recordInternalIds);
  }
  for (const [recordId, params] of Object.entries(published.rowNavigationParams ?? {})) {
    recordInternalIds.add(recordId);
    for (const value of Object.values(params)) recordInternalIds.add(value);
  }
  for (const recordId of Object.keys(published.cards?.relationLabels ?? {})) recordInternalIds.add(recordId);
  for (const [recordId, byField] of Object.entries(published.cards?.filePreviews ?? {})) {
    recordInternalIds.add(recordId);
    for (const [fieldId, preview] of Object.entries(byField)) {
      fieldInternalIds.add(fieldId);
      fieldInternalIds.add(preview.fieldId);
      recordInternalIds.add(preview.recordId);
      fileInternalIds.add(preview.fileId);
    }
  }
  const cardConfig = published.cards?.displayConfig.cards;
  for (const fieldId of cardConfig?.fieldIds ?? []) fieldInternalIds.add(fieldId);
  if (cardConfig?.imageFieldId) fieldInternalIds.add(cardConfig.imageFieldId);
  const calendarConfig = published.cards?.displayConfig.calendar;
  if (calendarConfig?.dateFieldId) fieldInternalIds.add(calendarConfig.dateFieldId);
  const [tableIds, fieldIds, recordIds, fileIds] = await Promise.all([
    projectPublicIds("table", [...tableInternalIds]),
    projectPublicIds("field", [...fieldInternalIds]),
    projectPublicIds("record", [...recordInternalIds]),
    projectPublicIds("file", [...fileInternalIds]),
  ]);
  const response = published.response.ok
    ? {
        ...published.response,
        columns: published.response.columns.map((column) => ({
          ...column,
          ...(column.tableId ? { tableId: requiredProjected(tableIds, column.tableId, "table") } : {}),
          ...(column.fieldId ? { fieldId: requiredProjected(fieldIds, column.fieldId, "field") } : {}),
          key: column.fieldId && column.key === column.fieldId ? requiredProjected(fieldIds, column.fieldId, "field") : column.key,
        })),
        rows: published.response.rows.map((row) => ({
          ...row,
          ...(row.recordId ? { recordId: requiredProjected(recordIds, row.recordId, "record") } : {}),
          ...(row.tableId ? { tableId: requiredProjected(tableIds, row.tableId, "table") } : {}),
          values: Object.fromEntries(
            Object.entries(row.values).map(([key, value]) => [
              fieldIds.get(key) ?? key,
              projectRecordValues({ [key]: value }, new Map(), recordIds, relationValueKeys)[key],
            ]),
          ),
        })),
      }
    : published.response;
  const presentation = published.presentation
    ? { fields: published.presentation.fields.map((field) => projectField(field, tableIds, fieldIds)) }
    : undefined;
  const rowNavigationParams = published.rowNavigationParams
    ? Object.fromEntries(
        Object.entries(published.rowNavigationParams).map(([recordId, params]) => [
          requiredProjected(recordIds, recordId, "record"),
          Object.fromEntries(Object.entries(params).map(([key, value]) => [key, requiredProjected(recordIds, value, "record")])),
        ]),
      )
    : undefined;
  const cards = published.cards
    ? {
        ...published.cards,
        displayConfig: {
          ...published.cards.displayConfig,
          ...(published.cards.displayConfig.cards
            ? {
                cards: {
                  ...published.cards.displayConfig.cards,
                  fieldIds: published.cards.displayConfig.cards.fieldIds?.map((id) => requiredProjected(fieldIds, id, "field")),
                  ...(published.cards.displayConfig.cards.imageFieldId
                    ? { imageFieldId: requiredProjected(fieldIds, published.cards.displayConfig.cards.imageFieldId, "field") }
                    : {}),
                },
              }
            : {}),
          ...(published.cards.displayConfig.calendar?.dateFieldId
            ? {
                calendar: {
                  ...published.cards.displayConfig.calendar,
                  dateFieldId: requiredProjected(fieldIds, published.cards.displayConfig.calendar.dateFieldId, "field"),
                },
              }
            : {}),
        },
        fields: published.cards.fields.map((field) => projectField(field, tableIds, fieldIds)),
        records: published.cards.records.map((record) => ({
          id: requiredProjected(recordIds, record.id, "record"),
          tableId: requiredProjected(tableIds, record.tableId, "table"),
          data: projectRecordValues(record.data, fieldIds, recordIds, relationFieldIds),
          version: record.version,
          ...(record.finalizedAt ? { finalizedAt: record.finalizedAt, finalizedBy: record.finalizedBy ?? null } : {}),
          deletedAt: record.deletedAt,
          createdBy: record.createdBy,
          updatedBy: record.updatedBy,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })),
        relationLabels: Object.fromEntries(
          Object.entries(published.cards.relationLabels).map(([id, label]) => [requiredProjected(recordIds, id, "record"), label]),
        ),
        filePreviews: Object.fromEntries(
          Object.entries(published.cards.filePreviews).map(([recordId, byField]) => [
            requiredProjected(recordIds, recordId, "record"),
            Object.fromEntries(
              Object.entries(byField).map(([fieldId, preview]) => [
                requiredProjected(fieldIds, fieldId, "field"),
                {
                  ...preview,
                  fileId: requiredProjected(fileIds, preview.fileId, "file"),
                  recordId: requiredProjected(recordIds, preview.recordId, "record"),
                  fieldId: requiredProjected(fieldIds, preview.fieldId, "field"),
                },
              ]),
            ),
          ]),
        ),
      }
    : undefined;
  return {
    ...response,
    ...(presentation ? { presentation } : {}),
    ...(cards ? { cards } : {}),
    ...(rowNavigationParams ? { rowNavigationParams } : {}),
  };
};

const sameStringRecord = (left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean => {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value], index) => rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value)
  );
};

const gateDefinitionAdmin = async (c: Parameters<typeof gateAt>[0], input: unknown) => {
  const parsed = DefinitionBaseSchema.safeParse(input);
  if (!parsed.success) {
    const locale = getLocale(c);
    return c.json(
      {
        diagnostics: parsed.error.issues.map((issue) =>
          customAppDiagnostic(
            locale,
            "schema.invalid",
            issue.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number"),
            { detail: issue.message },
          ),
        ),
      },
      400,
    );
  }
  const baseId = await resolvePublicId("base", parsed.data.baseId);
  if (!baseId) return c.json({ diagnostics: [customAppDiagnostic(getLocale(c), "base.missing", ["baseId"])] }, 400);
  const gate = await gateAt(c, { baseId }, "admin");
  return gate.ok ? null : respond(c, () => Promise.resolve(gate));
};

const resolvePublishedRuntime = async (c: Context<AuthContext>) => {
  const shortId = ShortIdSchema.safeParse(c.req.param("shortId"));
  if (!shortId.success) return null;
  const access = gridsAccessContext(c);
  return resolvePublishedCustomAppRuntime({
    access,
    shortId: shortId.data,
    pageId: c.req.param("pageId"),
    query: c.req.query(),
    dateConfig: getDateConfig(c),
    signal: c.req.raw.signal,
  });
};

type PublishedRuntime = NonNullable<Awaited<ReturnType<typeof resolvePublishedRuntime>>>;

const runtimeTimeZone = (runtime: { runtimeContext: { query: Record<string, unknown> } }): string => {
  const value = runtime.runtimeContext.query["time.timeZone"];
  return typeof value === "string" ? value : "UTC";
};

const resolvePublishedPageRun = async (c: Context<AuthContext>) => {
  // A page remains a current access boundary. Block/action visibility and
  // workflow executability are start/effect concerns and must not hide a run
  // after it has changed the state that originally made it available.
  return resolvePublishedRuntime(c);
};

const resolvePublishedSidebarRuntime = async (c: Context<AuthContext>) => {
  const shortId = ShortIdSchema.safeParse(c.req.param("shortId"));
  if (!shortId.success) return null;
  const access = gridsAccessContext(c);
  const runtime = await resolvePublishedCustomAppGlobalRuntime({
    access,
    shortId: shortId.data,
    query: c.req.query(),
    dateConfig: getDateConfig(c),
    signal: c.req.raw.signal,
  });
  if (!runtime) return null;
  const action = runtime.definition.sidebar?.actions.find((candidate) => candidate.id === c.req.param("actionId"));
  if (!action) return null;
  if (!(await runtime.availableSidebarAction(action.id, action.availableWhen?.query))) return null;
  return { ...runtime, action, runtimeContext: runtime.globalRuntimeContext } as const;
};

const loadRuntimeBindingContext = async (runtime: PublishedRuntime) => {
  const parameterRecords = new Map<string, GridRecord>();
  const publicTableIds = Object.values(runtime.page.parameters).map((parameter) => parameter.tableId);
  if (publicTableIds.some((tableId) => !ShortIdSchema.safeParse(tableId).success)) return null;
  const tableIds = await resolvePublicIds("table", publicTableIds);
  if (tableIds.size !== new Set(publicTableIds).size) return null;
  for (const [parameterId, parameter] of Object.entries(runtime.page.parameters)) {
    const record = await gridsService.record.get(tableIds.get(parameter.tableId)!, runtime.pageParams[parameterId]!, {
      viewer: runtime.viewer,
      dateConfig: runtime.dateConfig,
    });
    if (!record) return null;
    parameterRecords.set(parameterId, record);
  }
  const pageRecord = runtime.page.record ? parameterRecords.get(runtime.page.record.id.path) : undefined;
  if (runtime.page.record && !pageRecord) return null;
  return { parameterRecords, pageRecord, currentUserId: accessActorUser(runtime.access)?.id };
};

const resolveRuntimeComments = async (c: Context<AuthContext>) => {
  const runtime = await resolvePublishedRuntime(c);
  if (!runtime) return null;
  const { app, capabilities, page, pageParams } = runtime;
  const block = page?.rows
    .flatMap((row) => row.columns.flatMap((column) => column.blocks))
    .find((candidate) => candidate.id === c.req.param("blockId") && candidate.type === "comments");
  if (!page?.record || !pageParams || !block || block.type !== "comments") return null;
  if (!(await runtime.available("block", block.availableWhen?.query, block.id))) return null;
  const capability = capabilities.comments.find((candidate) => candidate.pageId === page.id && candidate.blockId === block.id);
  if (!capability) return null;

  const recordId = pageParams[page.record.id.path];
  if (!recordId) return null;
  const record = await gridsService.record.get(capability.tableId, recordId, {
    viewer: runtime.viewer,
  });
  if (!record) return null;
  const canModerate = (await gateAt(c, { baseId: app.baseId }, "admin")).ok;
  return { app, page, block, recordId, tableId: capability.tableId, canModerate } as const;
};

const resolveRuntimeRecordBlock = async (c: Context<AuthContext>) => {
  const runtime = await resolvePublishedRuntime(c);
  if (!runtime) return null;
  const { app, capabilities, page, pageParams } = runtime;
  const block = page?.rows
    .flatMap((row) => row.columns.flatMap((column) => column.blocks))
    .find((candidate) => candidate.id === c.req.param("blockId") && candidate.type === "record");
  if (!page?.record || !pageParams || !block || block.type !== "record") return null;
  if (!(await runtime.available("block", block.availableWhen?.query, block.id))) return null;

  const tableId = await resolvePublicId("table", page.record.tableId);
  if (!tableId) return null;
  const recordBlocks = page.rows.flatMap((row) =>
    row.columns.flatMap((column) => column.blocks.filter((candidate) => candidate.type === "record")),
  );
  const publicFieldIds = customAppPageRecordFieldIds(page);
  const publicEditableFieldIds = [...new Set(recordBlocks.flatMap((candidate) => candidate.editableFieldIds))];
  if ([...publicFieldIds, ...publicEditableFieldIds].some((fieldId) => !ShortIdSchema.safeParse(fieldId).success)) return null;
  const fieldIds = await resolvePublicIds("field", [...publicFieldIds, ...publicEditableFieldIds]);
  if (fieldIds.size !== new Set([...publicFieldIds, ...publicEditableFieldIds]).size) return null;
  const expectedFieldIds = publicFieldIds.map((fieldId) => fieldIds.get(fieldId)!).sort();
  const expectedEditableFieldIds = publicEditableFieldIds.map((fieldId) => fieldIds.get(fieldId)!).sort();
  const capability = capabilities.records.find((candidate) => candidate.pageId === page.id && candidate.tableId === tableId);
  if (
    !capability ||
    capability.fieldIds.join("\0") !== expectedFieldIds.join("\0") ||
    capability.editableFieldIds.join("\0") !== expectedEditableFieldIds.join("\0")
  ) {
    return null;
  }

  const recordId = pageParams[page.record.id.path];
  if (!recordId) return null;
  const record = await gridsService.record.get(tableId, recordId, {
    viewer: runtime.viewer,
  });
  if (!record) return null;
  const resolvedBlock = {
    ...block,
    fieldIds: block.fieldIds.map((fieldId) => fieldIds.get(fieldId)!),
    editableFieldIds: block.editableFieldIds.map((fieldId) => fieldIds.get(fieldId)!),
  };
  return { app, page, block: resolvedBlock, capability, record, tableId, viewer: runtime.viewer } as const;
};

const resolveRuntimeRecordEdit = async (c: Context<AuthContext>) => {
  const resolved = await resolveRuntimeRecordBlock(c);
  return resolved && resolved.block.editableFieldIds.length > 0 ? resolved : null;
};

const resolveRuntimeRecordFile = async (c: Context<AuthContext>, requireWrite: boolean) => {
  const resolved = await resolveRuntimeRecordBlock(c);
  if (!resolved) return null;
  const fieldId = internalIdParam(c, "fieldId") ?? "";
  if (!resolved.block.fieldIds.includes(fieldId) || (requireWrite && !resolved.block.editableFieldIds.includes(fieldId))) return null;
  const field = (await gridsService.field.listByTable(resolved.tableId)).find((candidate) => candidate.id === fieldId);
  return field?.type === "file" && !field.deletedAt ? { ...resolved, fieldId } : null;
};

const submitPublishedCustomAppForm = async (c: Context<AuthContext>, submitted: Record<string, unknown>) => {
  const runtime = await resolvePublishedRuntime(c);
  if (!runtime) return c.json({ message: apiMessages(c).formNotFound }, 404);
  const { app, capabilities, page, pageParams, dateConfig, viewer } = runtime;
  const block = runtime.blocks.get(c.req.param("blockId") ?? "");
  if (!block || block.type !== "form" || !(await runtime.available("block", block.availableWhen?.query, block.id))) {
    return c.json({ message: apiMessages(c).formNotFound }, 404);
  }

  const resolvedForm = await resolvePublishedCustomAppForm({ surface: block, page, capabilities });
  if (!resolvedForm) return c.json({ message: apiMessages(c).formNotFound }, 404);
  const { form, surface } = resolvedForm;

  const bindingContext = await loadRuntimeBindingContext(runtime);
  if (!bindingContext) return c.json({ message: apiMessages(c).formNotFound }, 404);

  const submission = await resolveFormSubmission(submitted);
  if (!submission) return c.json({ message: apiMessages(c).invalidFormSubmission }, 400);
  const fixedValues: Record<string, unknown> = {};
  for (const [fieldId, binding] of Object.entries(surface.fixedValues)) {
    const resolved = resolveCustomAppValueBinding(binding, bindingContext);
    if (!resolved.ok) return c.json({ message: apiMessages(c).formNotFound }, 404);
    fixedValues[fieldId] = resolved.value;
  }
  const result = await gridsService.form.submit({
    form,
    submission,
    actorId: currentActorUserId(c),
    dateConfig,
    fixedValues,
    viewer,
  });
  if (!result.ok) return respond(c, () => Promise.resolve(result));
  const [recordId, publicPageParams] = await Promise.all([
    requiredPublicId("record", result.data.recordId),
    projectPublicIds("record", Object.values(pageParams)),
  ]);
  const navigateTo = block.onSuccessNavigate
    ? customAppFormSuccessHref(
        app.shortId,
        block.onSuccessNavigate,
        Object.fromEntries(Object.entries(pageParams).map(([key, id]) => [key, requiredProjected(publicPageParams, id, "record")])),
        recordId,
      )
    : undefined;
  return c.json({ recordId, navigateTo }, 201);
};

const submitPublishedSidebarForm = async (c: Context<AuthContext>, submitted: Record<string, unknown>) => {
  const runtime = await resolvePublishedSidebarRuntime(c);
  if (!runtime || runtime.action.kind !== "form") return c.json({ message: apiMessages(c).formNotFound }, 404);
  const { app, action, dateConfig, viewer } = runtime;
  const resolvedForm = await resolvePublishedCustomAppForm({ surface: action, capabilities: runtime.capabilities });
  if (!resolvedForm) return c.json({ message: apiMessages(c).formNotFound }, 404);
  const { form, surface } = resolvedForm;
  const submission = await resolveFormSubmission(submitted);
  if (!submission) return c.json({ message: apiMessages(c).invalidFormSubmission }, 400);
  const fixedValues: Record<string, unknown> = {};
  for (const [fieldId, binding] of Object.entries(surface.fixedValues)) {
    const resolved = resolveCustomAppValueBinding(binding, {
      parameterRecords: new Map(),
      currentUserId: accessActorUser(runtime.access)?.id,
    });
    if (!resolved.ok) return c.json({ message: apiMessages(c).formNotFound }, 404);
    fixedValues[fieldId] = resolved.value;
  }
  const result = await gridsService.form.submit({
    form,
    submission,
    actorId: currentActorUserId(c),
    dateConfig,
    fixedValues,
    viewer,
  });
  if (!result.ok) return respond(c, () => Promise.resolve(result));
  const recordId = await requiredPublicId("record", result.data.recordId);
  const navigateTo = action.onSuccessNavigate
    ? customAppSidebarFormSuccessHref(app.shortId, action.onSuccessNavigate, recordId)
    : undefined;
  return c.json({ recordId, navigateTo }, 201);
};

const resolveRuntimeScanner = async (c: Context<AuthContext>) => {
  const runtime = await resolvePublishedRuntime(c);
  if (!runtime) return null;
  const block = runtime.blocks.get(c.req.param("blockId") ?? "");
  if (!block || block.type !== "scanner" || !(await runtime.available("block", block.availableWhen?.query, block.id))) return null;
  const launcherId = await resolvePublicId("workflowLauncher", block.launcherId);
  if (!launcherId) return null;
  const capability = runtime.capabilities.scannerLaunchers.find(
    (candidate) => candidate.pageId === runtime.page.id && candidate.blockId === block.id && candidate.launcherId === launcherId,
  );
  return capability ? { runtime, block, capability, launcherId } : null;
};

export const createCustomAppsApi = (
  deps: {
    loadOptionalActor?: MiddlewareHandler<AuthContext>;
    requireAuthenticated?: MiddlewareHandler<AuthContext>;
    invokeCustomAppLauncher?: typeof gridsService.workflow.launcher.invokeCustomApp;
    invokeScannerLauncher?: typeof gridsService.workflow.launcher.invokeScanner;
    getDocumentPdf?: typeof gridsService.document.getPdf;
    getWorkflowRunScope?: typeof getWorkflowRunScope;
    getWorkflowRun?: typeof gridsService.workflow.getRun;
  } = {},
) => {
  const loadOptionalActor = deps.loadOptionalActor ?? auth.requireRole("*");
  const invokeCustomAppLauncher = deps.invokeCustomAppLauncher ?? gridsService.workflow.launcher.invokeCustomApp;
  const invokeScannerLauncher = deps.invokeScannerLauncher ?? gridsService.workflow.launcher.invokeScanner;
  const getDocumentPdf = deps.getDocumentPdf ?? gridsService.document.getPdf;
  const loadWorkflowRunScope = deps.getWorkflowRunScope ?? getWorkflowRunScope;
  const getWorkflowRun = deps.getWorkflowRun ?? gridsService.workflow.getRun;
  return new Hono<AuthContext>()
    .get("/runtime/:shortId/:pageId/:blockId/records", loadOptionalActor, v("query", CustomAppRecordsQuerySchema), async (c) => {
      const runtime = await resolvePublishedRuntime(c);
      if (!runtime) return c.json({ message: apiMessages(c).recordsNotFound }, 404);
      const block = runtime.blocks.get(c.req.param("blockId") ?? "");
      if (
        !block ||
        (block.type !== "records" && block.type !== "referenced_records") ||
        !(await runtime.available("block", block.availableWhen?.query, block.id))
      ) {
        return c.json({ message: apiMessages(c).recordsNotFound }, 404);
      }
      const query = c.req.valid("query");
      const published = await executePublishedCustomAppRecords({
        baseId: runtime.app.baseId,
        customAppId: runtime.app.id,
        publishedAt: runtime.app.publishedAt!,
        page: runtime.page,
        pageParams: runtime.pageParams,
        block,
        capabilities: runtime.capabilities,
        context: runtime.runtimeContext.query,
        signal: c.req.raw.signal,
        timeZone: runtime.runtimeContext.query["time.timeZone"],
        viewer: runtime.viewer,
        viewerUserId: runtime.viewer.userId,
        viewerServiceAccountId: runtime.viewer.serviceAccountId ?? null,
        search: query.q,
        cursor: query.cursor,
      }).catch(() => null);
      if (!published) return c.json({ message: apiMessages(c).recordsNotFound }, 404);
      const payload = await projectPublishedRecords(published);
      return c.json(payload, published.response.ok ? 200 : 400);
    })
    .post("/runtime/:shortId/:pageId/:blockId/submit", loadOptionalActor, v("json", FormSubmitSchema), (c) =>
      submitPublishedCustomAppForm(c, c.req.valid("json")),
    )
    .post("/runtime/:shortId/sidebar/forms/:actionId/submit", loadOptionalActor, v("json", FormSubmitSchema), (c) =>
      submitPublishedSidebarForm(c, c.req.valid("json")),
    )
    .get(
      "/runtime/:shortId/:pageId/:blockId/documents/:documentId/download",
      loadOptionalActor,
      requirePublicIdParam("documentId", "document", "Document"),
      async (c) => {
        const runtime = await resolvePublishedRuntime(c);
        if (!runtime) return c.json({ message: apiMessages(c).documentNotFound }, 404);
        const block = runtime.blocks.get(c.req.param("blockId") ?? "");
        if (!runtime.page.record || !block || block.type !== "record" || !block.documents) {
          return c.json({ message: apiMessages(c).documentNotFound }, 404);
        }
        if (!(await runtime.available("block", block.availableWhen?.query, block.id))) {
          return c.json({ message: apiMessages(c).documentNotFound }, 404);
        }
        const publicTemplateIds = [...block.documents.templateIds];
        if (publicTemplateIds.some((templateId) => !ShortIdSchema.safeParse(templateId).success)) {
          return c.json({ message: apiMessages(c).documentNotFound }, 404);
        }
        const resolvedTemplateIds = await resolvePublicIds("documentTemplate", publicTemplateIds);
        if (resolvedTemplateIds.size !== publicTemplateIds.length) return c.json({ message: apiMessages(c).documentNotFound }, 404);
        const templateIds = [...resolvedTemplateIds.values()].sort();
        const capability = runtime.capabilities.documents.find(
          (candidate) =>
            candidate.pageId === runtime.page.id &&
            candidate.blockId === block.id &&
            candidate.templateIds.join("\0") === templateIds.join("\0"),
        );
        const bindingContext = capability ? await loadRuntimeBindingContext(runtime) : null;
        const record = bindingContext?.pageRecord;
        const document = record ? await gridsService.document.getDocument(internalIdParam(c, "documentId")!) : null;
        if (
          !capability ||
          !record ||
          !document ||
          document.baseId !== runtime.app.baseId ||
          document.tableId !== capability.tableId ||
          document.recordId !== record.id ||
          !templateIds.includes(document.templateId)
        ) {
          return c.json({ message: apiMessages(c).documentNotFound }, 404);
        }
        const pdf = await getDocumentPdf(document);
        if (!pdf.ok) return c.json({ message: pdf.error.message }, pdf.error.status);
        return pdfResponse(pdf.data.pdf, document.filename, {
          "X-Grids-Document-Id": c.req.param("documentId")!,
          "X-Grids-Document-Number": document.documentNumber,
          "X-Grids-Document-Filename": encodeHeaderValue(document.filename),
          "X-Grids-Document-Artifact": "stored",
        });
      },
    )
    .get("/runtime/:shortId/:pageId/:blockId/files/:token", loadOptionalActor, async (c) => {
      const runtime = await resolvePublishedRuntime(c);
      const secret = process.env.APP_SECRET?.trim();
      const token = secret ? verifyCustomAppFileToken(c.req.param("token") ?? "", secret) : null;
      if (
        !runtime ||
        !token ||
        !customAppFileTokenMatchesContext(token, {
          appId: runtime.app.id,
          publishedAt: runtime.app.publishedAt!,
          pageId: runtime.page.id,
          blockId: c.req.param("blockId") ?? "",
          pageParams: runtime.pageParams,
          viewerUserId: runtime.viewer.userId,
          viewerServiceAccountId: runtime.viewer.serviceAccountId ?? null,
        })
      ) {
        return c.json({ message: apiMessages(c).fileNotFound }, 404);
      }
      const block = runtime.blocks.get(token.blockId);
      if (!block || block.type !== "records" || block.display.kind !== "cards" || block.source.kind !== "view") {
        return c.json({ message: apiMessages(c).fileNotFound }, 404);
      }
      if (!(await runtime.available("block", block.availableWhen?.query, block.id))) {
        return c.json({ message: apiMessages(c).fileNotFound }, 404);
      }
      const currentRecords = await executePublishedCustomAppRecords({
        baseId: runtime.app.baseId,
        customAppId: runtime.app.id,
        publishedAt: runtime.app.publishedAt!,
        page: runtime.page,
        pageParams: runtime.pageParams,
        block,
        capabilities: runtime.capabilities,
        context: runtime.runtimeContext.query,
        signal: c.req.raw.signal,
        timeZone: runtimeTimeZone(runtime),
        viewer: runtime.viewer,
        viewerUserId: runtime.viewer.userId,
        viewerServiceAccountId: runtime.viewer.serviceAccountId ?? null,
        search: token.search ?? undefined,
        cursor: token.cursor ?? undefined,
      }).catch(() => null);
      if (!currentRecords?.response.ok || !currentRecords.response.rows.some((row) => row.recordId === token.recordId)) {
        return c.json({ message: apiMessages(c).fileNotFound }, 404);
      }
      const viewId = await resolvePublicId("view", block.source.viewId);
      if (!viewId) return c.json({ message: apiMessages(c).fileNotFound }, 404);
      const capability = runtime.capabilities.views.find((candidate) => candidate.viewId === viewId && candidate.tableId === token.tableId);
      if (!capability?.displayConfig || !capability.displayFieldHash || capability.displayConfig.cards?.imageFieldId !== token.fieldId) {
        return c.json({ message: apiMessages(c).fileNotFound }, 404);
      }
      const fields = await gridsService.field.listByTable(token.tableId, true);
      if (customAppRecordsDisplayFieldHash(capability.displayConfig, fields) !== capability.displayFieldHash) {
        return c.json({ message: apiMessages(c).fileNotFound }, 404);
      }
      // The token is minted only for an authorized preview returned by this
      // exact published source. App access and display drift are rechecked.
      const result = await gridsService.file.getContent({
        tableId: token.tableId,
        recordId: token.recordId,
        fieldId: token.fieldId,
        fileId: token.fileId,
      });
      if (!result.ok) return c.json({ message: apiMessages(c).fileNotFound }, 404);
      const file = result.data;
      if (!isSafeInlineCardImageMimeType(file.mimeType)) return c.json({ message: apiMessages(c).fileNotFound }, 404);
      const buffer = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
      return new Response(new Blob([buffer], { type: file.mimeType }), {
        headers: {
          "Content-Type": file.mimeType,
          "Content-Disposition": `inline; filename="${encodeURIComponent(file.filename)}"`,
          "Cache-Control": "private, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    })
    .use(deps.requireAuthenticated ?? auth.requireRole("authenticated"))
    .post("/runtime/:shortId/:pageId/:blockId/scanner", v("json", ScannerLauncherRequestSchema), async (c) => {
      const resolved = await resolveRuntimeScanner(c);
      if (!resolved) return c.json({ message: apiMessages(c).scannerNotFound }, 404);
      const { runtime, block, capability, launcherId } = resolved;
      const result = await invokeScannerLauncher({
        ...c.req.valid("json"),
        launcherId,
        expectedRevision: capability.revision,
        principal: currentWorkflowPrincipal(c),
        locale: getLocale(c),
        authorization: {
          kind: "custom-app-scanner",
          customAppId: runtime.app.id,
          publishedAt: runtime.app.publishedAt,
          pageId: runtime.page.id,
          pageParams: runtime.pageParams,
          timeZone: runtimeTimeZone(runtime),
          blockId: block.id,
          revision: capability.revision,
          configHash: capability.configHash,
        },
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      const [projected, publicPageParams] = await Promise.all([
        projectWorkflowInvocation(result.data),
        projectRecordParams(runtime.pageParams),
      ]);
      return c.json(
        {
          ...projected,
          statusUrl: customAppScannerRunUrl(runtime.app.shortId, runtime.page.id, block.id, projected.runId, publicPageParams),
        },
        202,
      );
    })
    .get(
      "/runtime/:shortId/:pageId/:blockId/scanner/runs/:runId",
      requirePublicIdParam("runId", "workflowRun", "Workflow run"),
      async (c) => {
        const runtime = await resolvePublishedPageRun(c);
        if (!runtime) return c.json({ message: apiMessages(c).workflowRunNotFound }, 404);
        const block = runtime.blocks.get(c.req.param("blockId") ?? "");
        const launcherId = block?.type === "scanner" ? await resolvePublicId("workflowLauncher", block.launcherId) : null;
        const capability =
          block?.type === "scanner" && launcherId
            ? runtime.capabilities.scannerLaunchers.find(
                (candidate) =>
                  candidate.pageId === runtime.page.id && candidate.blockId === block.id && candidate.launcherId === launcherId,
              )
            : null;
        if (!block || block.type !== "scanner" || !capability) return c.json({ message: apiMessages(c).workflowRunNotFound }, 404);
        const principal = currentWorkflowPrincipal(c);
        const [scope, run] = await Promise.all([
          loadWorkflowRunScope(internalIdParam(c, "runId")!),
          getWorkflowRun(internalIdParam(c, "runId")!),
        ]);
        if (
          !scope ||
          !run ||
          scope.baseId !== runtime.app.baseId ||
          run.baseId !== runtime.app.baseId ||
          run.workflowId !== capability.workflowId ||
          run.launcherId !== capability.launcherId ||
          scope.principal.userId !== principal.userId ||
          scope.principal.serviceAccountId !== principal.serviceAccountId ||
          (scope.principal.actorServiceAccountId ?? null) !== (principal.actorServiceAccountId ?? null) ||
          scope.launcherId !== capability.launcherId ||
          scope.workflow.id !== capability.workflowId ||
          run.workflowRevision !== capability.revision ||
          scope.authorization.kind !== "custom-app-scanner" ||
          scope.authorization.customAppId !== runtime.app.id ||
          scope.authorization.publishedAt !== runtime.app.publishedAt ||
          scope.authorization.pageId !== runtime.page.id ||
          !sameStringRecord(scope.authorization.pageParams, runtime.pageParams) ||
          scope.authorization.blockId !== block.id ||
          scope.authorization.revision !== capability.revision ||
          scope.authorization.configHash !== capability.configHash
        ) {
          return c.json({ message: apiMessages(c).workflowRunNotFound }, 404);
        }
        return c.json(await projectWorkflowRunSummary(run));
      },
    )
    .get("/reference", (c) => c.json(CUSTOM_APP_REFERENCE))
    .get("/runtime/:shortId/:pageId/:blockId/comments", v("query", RecordCommentListQuerySchema), async (c) => {
      const resolved = await resolveRuntimeComments(c);
      if (!resolved) return c.json({ message: apiMessages(c).commentsNotFound }, 404);
      const query = c.req.valid("query");
      const cursor = await rewriteCommentCursor(query.cursor, "resolve");
      if (query.cursor && !cursor) return c.json({ message: apiMessages(c).invalidCommentCursor }, 400);
      const result = await gridsService.record.comments.list({
        baseId: resolved.app.baseId,
        tableId: resolved.tableId,
        recordId: resolved.recordId,
        ...query,
        cursor,
        locale: getLocale(c),
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json({
        ...result.data,
        items: result.data.items.map(projectComment),
        nextCursor: await rewriteCommentCursor(result.data.nextCursor, "project"),
        permissions: {
          actorUserId: currentActorUserId(c),
          canWrite: true,
          canModerate: resolved.canModerate,
        },
      });
    })
    .post("/runtime/:shortId/:pageId/:blockId/comments", v("json", RecordCommentBodySchema), async (c) => {
      const resolved = await resolveRuntimeComments(c);
      if (!resolved) return c.json({ message: apiMessages(c).commentsNotFound }, 404);
      const result = await gridsService.record.comments.create({
        baseId: resolved.app.baseId,
        tableId: resolved.tableId,
        recordId: resolved.recordId,
        actorUserId: currentActorUserId(c),
        body: c.req.valid("json").body,
        locale: getLocale(c),
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json(projectComment(result.data), 201);
    })
    .patch(
      "/runtime/:shortId/:pageId/:blockId/comments/:commentId",
      requirePublicIdParam("commentId", "comment", "Comment"),
      v("json", RecordCommentBodySchema),
      async (c) => {
        const resolved = await resolveRuntimeComments(c);
        if (!resolved) return c.json({ message: apiMessages(c).commentsNotFound }, 404);
        const result = await gridsService.record.comments.update({
          baseId: resolved.app.baseId,
          tableId: resolved.tableId,
          recordId: resolved.recordId,
          commentId: internalIdParam(c, "commentId")!,
          actorUserId: currentActorUserId(c),
          canModerate: resolved.canModerate,
          body: c.req.valid("json").body,
          locale: getLocale(c),
        });
        if (!result.ok) return respond(c, () => Promise.resolve(result));
        return c.json(projectComment(result.data));
      },
    )
    .delete(
      "/runtime/:shortId/:pageId/:blockId/comments/:commentId",
      requirePublicIdParam("commentId", "comment", "Comment"),
      async (c) => {
        const resolved = await resolveRuntimeComments(c);
        if (!resolved) return c.json({ message: apiMessages(c).commentsNotFound }, 404);
        const result = await gridsService.record.comments.remove({
          baseId: resolved.app.baseId,
          tableId: resolved.tableId,
          recordId: resolved.recordId,
          commentId: internalIdParam(c, "commentId")!,
          actorUserId: currentActorUserId(c),
          canModerate: resolved.canModerate,
          locale: getLocale(c),
        });
        if (!result.ok) return respond(c, () => Promise.resolve(result));
        return c.body(null, 204);
      },
    )
    .patch("/runtime/:shortId/:pageId/:blockId/record", v("json", CustomAppRecordUpdateSchema), async (c) => {
      const resolved = await resolveRuntimeRecordEdit(c);
      if (!resolved) return c.json({ message: apiMessages(c).recordEditorNotFound }, 404);

      const ifMatch = Number(c.req.header("If-Match"));
      if (!Number.isInteger(ifMatch) || ifMatch < 1) return c.json({ message: apiMessages(c).invalidIfMatchCurrent }, 400);
      const body = c.req.valid("json");
      const values = await resolveFieldValues(body.values);
      if (!values) return c.json({ message: apiMessages(c).recordUpdateUnknownField }, 400);
      const allowed = new Set(resolved.block.editableFieldIds);
      const submittedFieldIds = Object.keys(values);
      if (submittedFieldIds.some((fieldId) => !allowed.has(fieldId))) {
        return c.json({ message: apiMessages(c).recordUpdateOutsideEditor }, 400);
      }

      const fields = await gridsService.field.listByTable(resolved.tableId);
      const fieldsById = new Map(fields.map((field) => [field.id, field]));
      if (
        resolved.block.editableFieldIds.some((fieldId) => {
          const field = fieldsById.get(fieldId);
          return !field || field.deletedAt !== null || (!isRecordWritableFieldType(field.type) && field.type !== "file");
        })
      ) {
        return c.json({ message: apiMessages(c).recordEditorChanged }, 409);
      }
      if (
        submittedFieldIds.some((fieldId) => {
          const field = fieldsById.get(fieldId);
          return !field || !isRecordWritableFieldType(field.type);
        })
      ) {
        return c.json({ message: apiMessages(c).recordUpdateNotWritable }, 400);
      }

      const result = await gridsService.record.update(
        resolved.tableId,
        resolved.record.id,
        values,
        currentActorUserId(c),
        "direct",
        ifMatch,
        {
          dateConfig: getDateConfig(c),
          viewer: resolved.viewer,
          audit: body.audit,
        },
      );
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      const visibleFieldIds = new Set(resolved.block.fieldIds);
      const visibleFields = fields.filter((field) => visibleFieldIds.has(field.id));
      const visibleRelations = resolved.capability.relationLabels.filter((relation) => visibleFieldIds.has(relation.fieldId));
      const relationTableIds = [resolved.tableId, ...new Set(resolved.capability.relationLabels.map((relation) => relation.targetTableId))];
      const relationViewer = {
        ...resolved.viewer,
        isAdmin: false,
        readableTableIds: new Set(relationTableIds),
        tableReadAccess: new Map(relationTableIds.map((tableId) => [tableId, true])),
      };
      const relationLabels = await buildCustomAppRecordLabelCache({
        records: [result.data],
        fields: visibleFields,
        relations: visibleRelations,
        viewer: relationViewer,
        actorUserId: currentActorUserId(c),
      }).catch(() => ({}));
      const [record, relationRecordIds] = await Promise.all([
        projectGridRecord(projectCustomAppRecord(result.data, resolved.block.fieldIds), visibleFields),
        projectPublicIds("record", Object.keys(relationLabels)),
      ]);
      return c.json({
        ...record,
        relationLabels: Object.fromEntries(
          Object.entries(relationLabels).map(([id, label]) => [requiredProjected(relationRecordIds, id, "record"), label]),
        ),
      });
    })
    .get("/runtime/:shortId/:pageId/:blockId/record/files/:fieldId", requirePublicIdParam("fieldId", "field", "Field"), async (c) => {
      const resolved = await resolveRuntimeRecordFile(c, false);
      if (!resolved) return c.json({ message: apiMessages(c).filesNotFound }, 404);
      const result = await gridsService.file.listForRecordField({
        tableId: resolved.tableId,
        recordId: resolved.record.id,
        fieldId: resolved.fieldId,
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json({ items: await Promise.all(result.data.map(projectGridFile)) });
    })
    .post("/runtime/:shortId/:pageId/:blockId/record/files/:fieldId", requirePublicIdParam("fieldId", "field", "Field"), async (c) => {
      const resolved = await resolveRuntimeRecordFile(c, true);
      if (!resolved) return c.json({ message: apiMessages(c).fileEditorNotFound }, 404);
      const form = await c.req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return c.json({ message: apiMessages(c).missingFileField }, 400);
      const maxBytes = await getMaxFileSizeBytes();
      if (file.size > maxBytes) return c.json({ message: apiMessages(c).fileTooLarge({ max: Math.round(maxBytes / 1024 / 1024) }) }, 413);
      const result = await gridsService.file.upload({
        tableId: resolved.tableId,
        recordId: resolved.record.id,
        fieldId: resolved.fieldId,
        filename: file.name || "untitled",
        mimeType: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
        userId: currentActorUserId(c),
        origin: "direct",
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json(await projectGridFile(result.data));
    })
    .put(
      "/runtime/:shortId/:pageId/:blockId/record/files/:fieldId/:fileId",
      requirePublicIdParam("fieldId", "field", "Field"),
      requirePublicIdParam("fileId", "file", "File"),
      async (c) => {
        const resolved = await resolveRuntimeRecordFile(c, true);
        if (!resolved) return c.json({ message: apiMessages(c).fileEditorNotFound }, 404);
        const form = await c.req.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File)) return c.json({ message: apiMessages(c).missingFileField }, 400);
        const maxBytes = await getMaxFileSizeBytes();
        if (file.size > maxBytes) return c.json({ message: apiMessages(c).fileTooLarge({ max: Math.round(maxBytes / 1024 / 1024) }) }, 413);
        const result = await gridsService.file.replace({
          tableId: resolved.tableId,
          recordId: resolved.record.id,
          fieldId: resolved.fieldId,
          fileId: internalIdParam(c, "fileId")!,
          filename: file.name || "untitled",
          mimeType: file.type || "application/octet-stream",
          bytes: new Uint8Array(await file.arrayBuffer()),
          userId: currentActorUserId(c),
          origin: "direct",
        });
        if (!result.ok) return respond(c, () => Promise.resolve(result));
        return c.json(await projectGridFile(result.data));
      },
    )
    .get(
      "/runtime/:shortId/:pageId/:blockId/record/files/:fieldId/:fileId/content",
      requirePublicIdParam("fieldId", "field", "Field"),
      requirePublicIdParam("fileId", "file", "File"),
      async (c) => {
        const resolved = await resolveRuntimeRecordFile(c, false);
        if (!resolved) return c.json({ message: apiMessages(c).fileNotFound }, 404);
        const result = await gridsService.file.getContent({
          tableId: resolved.tableId,
          recordId: resolved.record.id,
          fieldId: resolved.fieldId,
          fileId: internalIdParam(c, "fileId")!,
        });
        if (!result.ok) return c.json({ message: apiMessages(c).fileNotFound }, 404);
        const file = result.data;
        const buffer = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
        const inline = c.req.query("inline") === "true";
        return new Response(new Blob([buffer], { type: file.mimeType }), {
          headers: {
            "Content-Type": file.mimeType,
            "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(file.filename)}"`,
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    )
    .delete(
      "/runtime/:shortId/:pageId/:blockId/record/files/:fieldId/:fileId",
      requirePublicIdParam("fieldId", "field", "Field"),
      requirePublicIdParam("fileId", "file", "File"),
      async (c) => {
        const resolved = await resolveRuntimeRecordFile(c, true);
        if (!resolved) return c.json({ message: apiMessages(c).fileEditorNotFound }, 404);
        const result = await gridsService.file.remove({
          tableId: resolved.tableId,
          recordId: resolved.record.id,
          fieldId: resolved.fieldId,
          fileId: internalIdParam(c, "fileId")!,
          userId: currentActorUserId(c),
          origin: "direct",
        });
        if (!result.ok) return respond(c, () => Promise.resolve(result));
        return c.body(null, 204);
      },
    )
    .post("/runtime/:shortId/:pageId/:blockId/actions/:actionId", v("json", CustomAppActionInvocationSchema), async (c) => {
      const runtime = await resolvePublishedRuntime(c);
      if (!runtime) return c.json({ message: apiMessages(c).actionNotFound }, 404);
      const { app, capabilities, page, pageParams } = runtime;
      const block = page?.rows
        .flatMap((row) => row.columns.flatMap((column) => column.blocks))
        .find((candidate) => candidate.id === c.req.param("blockId") && candidate.type === "actions");
      const action = block?.type === "actions" ? block.actions.find((candidate) => candidate.id === c.req.param("actionId")) : null;
      if (!page || !pageParams || !block || block.type !== "actions" || !action || action.kind !== "workflow") {
        return c.json({ message: apiMessages(c).actionNotFound }, 404);
      }
      if (
        !(await runtime.available("block", block.availableWhen?.query, block.id)) ||
        !(await runtime.available("action", action.availableWhen?.query, block.id, action.id))
      ) {
        return c.json({ message: apiMessages(c).actionNotFound }, 404);
      }

      const launcherId = await resolvePublicId("workflowLauncher", action.launcherId);
      if (!launcherId) return c.json({ message: apiMessages(c).actionNotFound }, 404);
      const capability = capabilities.workflowLaunchers.find(
        (candidate) =>
          "pageId" in candidate &&
          candidate.pageId === page.id &&
          candidate.blockId === block.id &&
          candidate.actionId === action.id &&
          candidate.launcherId === launcherId,
      );
      if (!capability) return c.json({ message: apiMessages(c).actionNotFound }, 404);

      const bindingContext = await loadRuntimeBindingContext(runtime);
      if (!bindingContext) return c.json({ message: apiMessages(c).actionNotFound }, 404);
      const inputs: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(action.inputs)) {
        const resolved = resolveCustomAppValueBinding(value, bindingContext);
        if (!resolved.ok) return c.json({ message: apiMessages(c).actionNotFound }, 404);
        inputs[name] = resolved.value;
      }
      const result = await invokeCustomAppLauncher({
        launcherId,
        operationId: c.req.valid("json").operationId,
        mode: "execute",
        expectedRevision: capability.revision,
        principal: currentWorkflowPrincipal(c),
        locale: getLocale(c),
        inputs,
        authorization: {
          kind: "custom-app-action",
          customAppId: app.id,
          publishedAt: app.publishedAt,
          pageId: page.id,
          pageParams,
          timeZone: runtimeTimeZone(runtime),
          blockId: block.id,
          actionId: action.id,
          revision: capability.revision,
        },
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      const [projected, publicPageParams] = await Promise.all([projectWorkflowInvocation(result.data), projectRecordParams(pageParams)]);
      return c.json(
        {
          runId: projected.runId,
          workflowId: projected.workflowId,
          status: projected.status,
          statusUrl: customAppActionStatusUrl(app.shortId, page.id, block.id, action.id, projected.runId, publicPageParams),
        },
        202,
      );
    })
    .post("/runtime/:shortId/:pageId/:blockId/row-actions/:actionId", v("json", CustomAppRowActionInvocationSchema), async (c) => {
      const runtime = await resolvePublishedRuntime(c);
      if (!runtime) return c.json({ message: apiMessages(c).actionNotFound }, 404);
      const { app, capabilities, page, pageParams } = runtime;
      const block = runtime.blocks.get(c.req.param("blockId") ?? "");
      const action =
        block?.type === "records" || block?.type === "referenced_records"
          ? block.rowActions?.find((candidate) => candidate.id === c.req.param("actionId"))
          : null;
      if (!block || (block.type !== "records" && block.type !== "referenced_records") || !action) {
        return c.json({ message: apiMessages(c).actionNotFound }, 404);
      }
      if (
        !(await runtime.available("block", block.availableWhen?.query, block.id)) ||
        !(await runtime.available("action", action.availableWhen?.query, block.id, action.id))
      ) {
        return c.json({ message: apiMessages(c).actionNotFound }, 404);
      }
      const launcherId = await resolvePublicId("workflowLauncher", action.launcherId);
      if (!launcherId) return c.json({ message: apiMessages(c).actionNotFound }, 404);
      const capability = capabilities.workflowLaunchers.find(
        (candidate) =>
          "pageId" in candidate &&
          candidate.pageId === page.id &&
          candidate.blockId === block.id &&
          candidate.actionId === action.id &&
          candidate.launcherId === launcherId,
      );
      if (!capability) return c.json({ message: apiMessages(c).actionNotFound }, 404);

      const published = await executePublishedCustomAppRecords({
        baseId: app.baseId,
        customAppId: app.id,
        publishedAt: app.publishedAt!,
        page,
        pageParams,
        block,
        capabilities,
        context: runtime.runtimeContext.query,
        signal: c.req.raw.signal,
        timeZone: runtime.runtimeContext.query["time.timeZone"],
        viewer: runtime.viewer,
        viewerUserId: runtime.viewer.userId,
        viewerServiceAccountId: runtime.viewer.serviceAccountId ?? null,
        search: c.req.valid("json").search,
        cursor: c.req.valid("json").cursor,
      }).catch(() => null);
      const rowId = await resolvePublicId("record", c.req.valid("json").rowId);
      if (!rowId) return c.json({ message: apiMessages(c).actionNotFound }, 404);
      if (!published?.response.ok || !published.response.rows.some((row) => row.recordId === rowId)) {
        return c.json({ message: apiMessages(c).actionNotFound }, 404);
      }

      const bindingContext = await loadRuntimeBindingContext(runtime);
      if (!bindingContext) return c.json({ message: apiMessages(c).actionNotFound }, 404);
      const inputs: Record<string, unknown> = {};
      for (const [name, binding] of Object.entries(action.inputs)) {
        const resolved = resolveCustomAppValueBinding(binding, { ...bindingContext, rowRecordId: rowId });
        if (!resolved.ok) return c.json({ message: apiMessages(c).actionNotFound }, 404);
        inputs[name] = resolved.value;
      }
      const result = await invokeCustomAppLauncher({
        launcherId,
        operationId: c.req.valid("json").operationId,
        mode: "execute",
        expectedRevision: capability.revision,
        principal: currentWorkflowPrincipal(c),
        locale: getLocale(c),
        inputs,
        authorization: {
          kind: "custom-app-action",
          customAppId: app.id,
          publishedAt: app.publishedAt,
          pageId: page.id,
          pageParams,
          timeZone: runtimeTimeZone(runtime),
          blockId: block.id,
          actionId: action.id,
          recordId: rowId,
          search: c.req.valid("json").search,
          cursor: c.req.valid("json").cursor,
          revision: capability.revision,
        },
      });
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      const [projected, publicPageParams] = await Promise.all([projectWorkflowInvocation(result.data), projectRecordParams(pageParams)]);
      return c.json(
        {
          runId: projected.runId,
          workflowId: projected.workflowId,
          status: projected.status,
          statusUrl: customAppActionStatusUrl(app.shortId, page.id, block.id, action.id, projected.runId, publicPageParams),
        },
        202,
      );
    })
    .get(
      "/runtime/:shortId/:pageId/:blockId/actions/:actionId/runs/:runId",
      requirePublicIdParam("runId", "workflowRun", "Workflow run"),
      async (c) => {
        const runtime = await resolvePublishedPageRun(c);
        if (!runtime) return c.json({ message: apiMessages(c).workflowRunNotFound }, 404);
        const block = runtime.blocks.get(c.req.param("blockId") ?? "");
        const action =
          block?.type === "actions"
            ? block.actions.find((candidate) => candidate.id === c.req.param("actionId") && candidate.kind === "workflow")
            : block?.type === "records"
              ? block.rowActions?.find((candidate) => candidate.id === c.req.param("actionId"))
              : null;
        const workflowAction = action && "launcherId" in action ? action : null;
        if (!block || !workflowAction) {
          return c.json({ message: apiMessages(c).workflowRunNotFound }, 404);
        }
        const launcherId = await resolvePublicId("workflowLauncher", workflowAction.launcherId);
        const capability = launcherId
          ? runtime.capabilities.workflowLaunchers.find(
              (candidate) =>
                "pageId" in candidate &&
                candidate.pageId === runtime.page.id &&
                candidate.blockId === block!.id &&
                candidate.actionId === workflowAction.id &&
                candidate.launcherId === launcherId,
            )
          : null;
        const principal = currentWorkflowPrincipal(c);
        const [scope, run] = capability
          ? await Promise.all([loadWorkflowRunScope(internalIdParam(c, "runId")!), getWorkflowRun(internalIdParam(c, "runId")!)])
          : [null, null];
        const authorization = scope?.authorization;
        if (
          !block ||
          !workflowAction ||
          !capability ||
          !scope ||
          !run ||
          scope.baseId !== runtime.app.baseId ||
          run.baseId !== runtime.app.baseId ||
          run.workflowId !== capability.workflowId ||
          run.launcherId !== capability.launcherId ||
          scope.principal.userId !== principal.userId ||
          scope.principal.serviceAccountId !== principal.serviceAccountId ||
          (scope.principal.actorServiceAccountId ?? null) !== (principal.actorServiceAccountId ?? null) ||
          scope.launcherId !== capability.launcherId ||
          scope.workflow.id !== capability.workflowId ||
          run.workflowRevision !== capability.revision ||
          authorization?.kind !== "custom-app-action" ||
          authorization.customAppId !== runtime.app.id ||
          authorization.publishedAt !== runtime.app.publishedAt ||
          authorization.pageId !== runtime.page.id ||
          !sameStringRecord(authorization.pageParams, runtime.pageParams) ||
          authorization.blockId !== block.id ||
          authorization.actionId !== workflowAction.id ||
          authorization.revision !== capability.revision
        ) {
          return c.json({ message: apiMessages(c).workflowRunNotFound }, 404);
        }
        const status =
          run.status === "succeeded" ? "succeeded" : ["failed", "canceled", "needs_attention"].includes(run.status) ? "failed" : "running";
        return c.json({ status, message: run.resultMessage });
      },
    )
    .get("/by-base/:baseId", requirePublicIdParam("baseId", "base", "Base"), async (c) => {
      const baseId = internalIdParam(c, "baseId")!;
      const gate = await gateAt(c, { baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const projected: Awaited<ReturnType<typeof projectCustomApp>>[] = [];
      for (const app of await gridsService.customApp.listByBase(baseId)) projected.push(await projectCustomApp(app));
      return c.json(projected);
    })
    .post("/by-base/:baseId", requirePublicIdParam("baseId", "base", "Base"), v("json", CustomAppCreateSchema), async (c) => {
      const baseId = internalIdParam(c, "baseId")!;
      const gate = await gateAt(c, { baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.customApp.createBlank(baseId, c.req.valid("json").name, currentActorUserId(c), getLocale(c));
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json(await projectCustomApp(result.data));
    })
    .post("/validate", v("json", CustomAppDefinitionInputSchema), async (c) => {
      const input = c.req.valid("json").definition;
      const denied = await gateDefinitionAdmin(c, input);
      if (denied) return denied;
      const compilation = await gridsService.customApp.compile(input, undefined, getLocale(c));
      return c.json(
        compilation.ok
          ? { valid: true, diagnostics: [], capabilities: await projectCapabilities(compilation.compiled.capabilities) }
          : { valid: false, diagnostics: compilation.diagnostics },
      );
    })
    .post("/plan", v("json", CustomAppDefinitionInputSchema), async (c) => {
      const input = c.req.valid("json").definition;
      const denied = await gateDefinitionAdmin(c, input);
      if (denied) return denied;
      return c.json(await gridsService.customApp.plan(input, getLocale(c)));
    })
    .post("/apply", v("json", CustomAppDefinitionInputSchema), async (c) => {
      const input = c.req.valid("json").definition;
      const denied = await gateDefinitionAdmin(c, input);
      if (denied) return denied;
      const result = await gridsService.customApp.apply(input, currentActorUserId(c), getLocale(c));
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json(await projectCustomApp(result.data));
    })
    .get("/:appId", requirePublicIdParam("appId", "customApp", "Grids App"), async (c) => {
      const app = await gridsService.customApp.get(internalIdParam(c, "appId")!);
      if (!app) return c.json({ message: apiMessages(c).gridsAppNotFound }, 404);
      const gate = await gateAt(c, { baseId: app.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      return c.json(await projectCustomApp(app));
    })
    .put("/:appId/draft", requirePublicIdParam("appId", "customApp", "Grids App"), v("json", CustomAppDefinitionInputSchema), async (c) => {
      const app = await gridsService.customApp.get(internalIdParam(c, "appId")!);
      if (!app) return c.json({ message: apiMessages(c).gridsAppNotFound }, 404);
      const gate = await gateAt(c, { baseId: app.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.customApp.saveDraft(app.id, c.req.valid("json").definition, getLocale(c));
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json(await projectDraftSave(result.data));
    })
    .post("/:appId/restore", requirePublicIdParam("appId", "customApp", "Grids App"), async (c) => {
      const app = await gridsService.customApp.get(internalIdParam(c, "appId")!);
      if (!app) return c.json({ message: apiMessages(c).gridsAppNotFound }, 404);
      const gate = await gateAt(c, { baseId: app.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.customApp.restoreDraft(app.id, currentActorUserId(c), getLocale(c));
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json(await projectCustomApp(result.data));
    })
    .get("/:appId/export", requirePublicIdParam("appId", "customApp", "Grids App"), async (c) => {
      const app = await gridsService.customApp.get(internalIdParam(c, "appId")!);
      if (!app) return c.json({ message: apiMessages(c).gridsAppNotFound }, 404);
      const gate = await gateAt(c, { baseId: app.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      return c.json(app.draftDefinition);
    })
    .post("/:appId/publish", requirePublicIdParam("appId", "customApp", "Grids App"), async (c) => {
      const app = await gridsService.customApp.get(internalIdParam(c, "appId")!);
      if (!app) return c.json({ message: apiMessages(c).gridsAppNotFound }, 404);
      const gate = await gateAt(c, { baseId: app.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.customApp.publish(app.id, currentActorUserId(c), getLocale(c));
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json(await projectCustomApp(result.data));
    })
    .post("/:appId/unpublish", requirePublicIdParam("appId", "customApp", "Grids App"), async (c) => {
      const app = await gridsService.customApp.get(internalIdParam(c, "appId")!);
      if (!app) return c.json({ message: apiMessages(c).gridsAppNotFound }, 404);
      const gate = await gateAt(c, { baseId: app.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.customApp.unpublish(app.id, currentActorUserId(c), getLocale(c));
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return c.json(await projectCustomApp(result.data));
    })
    .delete("/:appId", requirePublicIdParam("appId", "customApp", "Grids App"), async (c) => {
      const app = await gridsService.customApp.get(internalIdParam(c, "appId")!);
      if (!app) return c.json({ message: apiMessages(c).gridsAppNotFound }, 404);
      const gate = await gateAt(c, { baseId: app.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.customApp.remove(app.id, currentActorUserId(c), getLocale(c));
      if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
      return c.json({ id: app.shortId });
    });
};

export default createCustomAppsApi();
