import { type AuthContext, getDateConfig, getLocale, type RequestActor } from "@valentinkolb/cloud/server";
import type { Context } from "hono";
import { z } from "zod";
import {
  DocumentTemplateRendererSchema,
  DocumentTemplateRendererSummarySchema,
  type DocumentTemplateSummary,
  ShortIdSchema,
} from "../contracts";
import { gridsService } from "../service";
import { decodeDocumentCursor } from "../service/document-values";
import { loadDocumentNumberSeries } from "../service/number-series";
import { projectPublicIds, resolvePublicIds } from "../service/public-resources";
import { ALL_RECORD_ACCESS } from "../service/record-access";
import { PUBLIC_DOCUMENT_PAGE_LIMIT, PublicDocumentSchema } from "./document-public-contracts";
import { pdfResponse } from "./download-response";
import { apiMessages } from "./messages";
import { PublicNumberSeriesSummarySchema, toPublicNumberSeries } from "./number-series-dto";
import { currentActorViewer, gateAt } from "./permissions";

export {
  PUBLIC_DOCUMENT_PAGE_LIMIT,
  PublicDocumentArtifactSchema,
  PublicDocumentRendererSchema,
  PublicDocumentSchema,
} from "./document-public-contracts";

export const documentActor = (actor: RequestActor | undefined) => {
  if (!actor) return { kind: "system" as const };
  if (actor.kind === "user") return { kind: "user" as const, userId: actor.user.id };
  return {
    kind: "service_account" as const,
    serviceAccountId: actor.serviceAccount.id,
    delegatedUserId: actor.delegatedUser?.id ?? null,
    credentialId: actor.credentialId ?? null,
  };
};

export const PublicDocumentTemplateSchema = z.object({
  id: ShortIdSchema,
  tableId: ShortIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  source: z.string(),
  renderer: DocumentTemplateRendererSchema,
  enabled: z.boolean(),
  position: z.number().int(),
  createdBy: z.string().uuid().nullable(),
  updatedBy: z.string().uuid().nullable(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  numberSeries: PublicNumberSeriesSummarySchema.nullable(),
});
export const PublicDocumentTemplateListSchema = z.array(PublicDocumentTemplateSchema);
export const PublicDocumentTemplateSummarySchema = PublicDocumentTemplateSchema.pick({
  id: true,
  tableId: true,
  name: true,
  description: true,
  enabled: true,
  position: true,
  createdAt: true,
  updatedAt: true,
}).extend({ renderer: DocumentTemplateRendererSummarySchema });
export const PublicDocumentTemplateSummaryListSchema = z.array(PublicDocumentTemplateSummarySchema);

export const PublicRecordSnapshotSchema = z.object({
  id: ShortIdSchema,
  baseId: ShortIdSchema,
  tableId: ShortIdSchema,
  recordId: ShortIdSchema,
  root: z.record(z.string(), z.unknown()),
  graph: z.record(z.string(), z.unknown()),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export const PublicRecordSnapshotSummarySchema = PublicRecordSnapshotSchema.omit({ root: true, graph: true });
export const PublicRecordSnapshotListResponseSchema = z.object({ items: z.array(PublicRecordSnapshotSummarySchema) });
export const PublicCreateRecordSnapshotResponseSchema = z.object({ snapshot: PublicRecordSnapshotSchema });

export const PublicDocumentListSchema = z
  .object({
    items: z.array(PublicDocumentSchema),
    cursor: z.string().nullable(),
    hasMore: z.boolean(),
  })
  .strict();
export const PublicDocumentBrowseResponseSchema = PublicDocumentListSchema.extend({
  path: z.array(z.string()),
  folders: z.array(
    z.object({
      kind: z.enum(["year", "month"]),
      key: z.string(),
      label: z.string(),
      path: z.array(z.string()),
      count: z.number().int().nonnegative(),
    }),
  ),
});

export const PublicDocumentLinkSchema = z.object({
  id: ShortIdSchema,
  documentId: ShortIdSchema,
  baseId: ShortIdSchema,
  tableId: ShortIdSchema,
  recordId: ShortIdSchema,
  comment: z.string().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  revokedBy: z.string().uuid().nullable(),
  lastAccessedAt: z.string().datetime().nullable(),
  accessCount: z.number().int().nonnegative(),
});
export const PublicDocumentLinkListResponseSchema = z.object({ items: z.array(PublicDocumentLinkSchema) });
export const PublicCreateDocumentLinkResponseSchema = z.object({ link: PublicDocumentLinkSchema, url: z.string() });

export const PublicDocumentTemplateDraftPreviewSchema = z
  .object({
    source: z.string().trim().min(1).max(20_000),
    renderer: DocumentTemplateRendererSchema,
    recordId: ShortIdSchema,
  })
  .strict();
export const PublicDocumentRecordBodySchema = z.object({
  recordId: ShortIdSchema,
  filename: z.string().trim().min(1).max(255).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional().default([]),
});
export const PublicDocumentGenerateBodySchema = PublicDocumentRecordBodySchema.extend({
  idempotencyKey: z.string().trim().min(1).max(200),
});
export const PublicReorderDocumentTemplatesSchema = z.object({
  templateIds: z
    .array(ShortIdSchema)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, "template ids must be unique"),
});
export const PublicRelationLookupResponseSchema = z.object({ items: z.array(z.object({ id: ShortIdSchema, label: z.string() })) });

const PublicDocumentPreviewColumnSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    tableId: ShortIdSchema.optional(),
    fieldId: ShortIdSchema.optional(),
    joinAlias: z.string().optional(),
    type: z.string(),
    sqlType: z.string(),
    aggregate: z.string().optional(),
  })
  .strict();
const PublicDocumentPreviewRecordSchema = z
  .object({
    id: ShortIdSchema,
    tableId: ShortIdSchema,
    version: z.number().int().optional(),
    data: z.record(ShortIdSchema, z.unknown()),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const PublicDocumentPreviewImageSchema = z
  .object({
    fieldId: ShortIdSchema,
    fieldName: z.string(),
    fileId: ShortIdSchema,
    filename: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number(),
    url: z.string(),
  })
  .strict();
export const PublicDocumentPreviewDataSchema = z
  .object({
    record: PublicDocumentPreviewRecordSchema,
    table: z.object({ id: ShortIdSchema, name: z.string() }).strict(),
    query: z.object({ columns: z.array(PublicDocumentPreviewColumnSchema), rows: z.array(z.record(z.string(), z.unknown())) }).strict(),
    rows: z.array(z.record(z.string(), z.unknown())),
    columns: z.array(PublicDocumentPreviewColumnSchema),
    template: z.object({ id: z.union([ShortIdSchema, z.literal("draft")]), name: z.string() }).strict(),
    date: z.record(z.string(), z.unknown()),
    images: z.array(PublicDocumentPreviewImageSchema),
    primaryImage: PublicDocumentPreviewImageSchema.nullable(),
    app: z.record(z.string(), z.unknown()),
    business: z.record(z.string(), z.unknown()),
    document: z.record(z.string(), z.unknown()),
    snapshot: PublicRecordSnapshotSchema.nullable(),
  })
  .strict();
export const PublicDocumentPreviewResponseSchema = z
  .object({ html: z.string(), source: z.string(), data: PublicDocumentPreviewDataSchema })
  .strict();

const requiredPublicId = (ids: ReadonlyMap<string, string>, internalId: string, resource: string): string => {
  const id = ids.get(internalId);
  if (!id) throw new Error(`Grids could not project a public ${resource} id.`);
  return id;
};

type InternalDocumentTemplate =
  Awaited<ReturnType<typeof gridsService.document.getTemplateByShortId>> extends infer T ? NonNullable<T> : never;
type InternalDocumentSummary = ReturnType<typeof gridsService.document.summarizeDocument>;
type InternalDocumentLink = NonNullable<Awaited<ReturnType<typeof gridsService.document.getDocumentLink>>>;
type InternalRecordSnapshot = NonNullable<Awaited<ReturnType<typeof gridsService.document.getSnapshot>>>;
type InternalRecordSnapshotSummary = Awaited<ReturnType<typeof gridsService.document.listSnapshotsForRecord>>[number];

export const projectDocumentTemplates = async (templates: InternalDocumentTemplate[]) => {
  const [tableIds, numberSeries] = await Promise.all([
    projectPublicIds(
      "table",
      templates.map((template) => template.tableId),
    ),
    loadDocumentNumberSeries(templates.map((template) => template.id)),
  ]);
  return templates.map(({ id: _id, shortId, tableId, ...template }) => {
    const series = numberSeries.get(_id);
    if (!series && template.renderer.kind === "html")
      throw new Error(`Grids document template ${_id} is missing its durable number series.`);
    return {
      ...template,
      id: shortId,
      tableId: requiredPublicId(tableIds, tableId, "table"),
      numberSeries: template.renderer.kind === "html" && series ? toPublicNumberSeries(series) : null,
    };
  });
};

export const projectDocumentTemplateSummaries = async (templates: readonly DocumentTemplateSummary[]) => {
  const tableIds = await projectPublicIds(
    "table",
    templates.map((template) => template.tableId),
  );
  return templates.map((template) => ({
    id: template.shortId,
    tableId: requiredPublicId(tableIds, template.tableId, "table"),
    name: template.name,
    description: template.description,
    renderer: template.renderer,
    enabled: template.enabled,
    position: template.position,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  }));
};

export const projectRelationLookup = async (lookup: { items: Array<{ id: string; label: string }> }) => {
  const ids = await projectPublicIds(
    "record",
    lookup.items.map((item) => item.id),
  );
  return { items: lookup.items.map((item) => ({ ...item, id: requiredPublicId(ids, item.id, "record") })) };
};

export const projectRecordSnapshotSummaries = async (snapshots: InternalRecordSnapshotSummary[]) => {
  const [publicSnapshots, bases, tables, records] = await Promise.all([
    projectPublicIds(
      "documentSnapshot",
      snapshots.map((snapshot) => snapshot.id),
    ),
    projectPublicIds(
      "base",
      snapshots.map((snapshot) => snapshot.baseId),
    ),
    projectPublicIds(
      "table",
      snapshots.map((snapshot) => snapshot.tableId),
    ),
    projectPublicIds(
      "record",
      snapshots.map((snapshot) => snapshot.recordId),
    ),
  ]);
  return snapshots.map(({ id, baseId, tableId, recordId, createdBy, createdAt }) => ({
    id: requiredPublicId(publicSnapshots, id, "document snapshot"),
    baseId: requiredPublicId(bases, baseId, "base"),
    tableId: requiredPublicId(tables, tableId, "table"),
    recordId: requiredPublicId(records, recordId, "record"),
    createdBy,
    createdAt,
  }));
};

export const projectDocuments = async (documents: InternalDocumentSummary[]) => {
  const [templates, bases, tables, records] = await Promise.all([
    projectPublicIds(
      "documentTemplate",
      documents.map((document) => document.templateId),
    ),
    projectPublicIds(
      "base",
      documents.map((document) => document.baseId),
    ),
    projectPublicIds(
      "table",
      documents.map((document) => document.tableId),
    ),
    projectPublicIds(
      "record",
      documents.map((document) => document.recordId),
    ),
  ]);
  return documents.map(
    ({ id: _id, shortId, templateId, workflowRunId: _workflowRunId, snapshotId: _snapshotId, baseId, tableId, recordId, ...document }) => ({
      id: shortId,
      baseId: requiredPublicId(bases, baseId, "base"),
      tableId: requiredPublicId(tables, tableId, "table"),
      recordId: requiredPublicId(records, recordId, "record"),
      templateId: requiredPublicId(templates, templateId, "document template"),
      number: document.documentNumber,
      filename: document.filename,
      createdAt: document.createdAt,
      tags: document.tags,
      createdBy: document.createdBy,
      renderer: document.profile ? { kind: "profile" as const, ...document.profile } : { kind: "html" as const },
      validationStatus: document.validationStatus,
      artifacts: document.artifacts.map(({ fileId: _fileId, ...artifact }) => artifact),
    }),
  );
};

export const projectDocumentLinks = async (links: InternalDocumentLink[]) => {
  const [publicLinks, documents, bases, tables, records] = await Promise.all([
    projectPublicIds(
      "documentLink",
      links.map((link) => link.id),
    ),
    projectPublicIds(
      "document",
      links.map((link) => link.documentId),
    ),
    projectPublicIds(
      "base",
      links.map((link) => link.baseId),
    ),
    projectPublicIds(
      "table",
      links.map((link) => link.tableId),
    ),
    projectPublicIds(
      "record",
      links.map((link) => link.recordId),
    ),
  ]);
  return links.map(({ id, shortId: _shortId, documentId, baseId, tableId, recordId, ...link }) => ({
    ...link,
    id: requiredPublicId(publicLinks, id, "document link"),
    documentId: requiredPublicId(documents, documentId, "document"),
    baseId: requiredPublicId(bases, baseId, "base"),
    tableId: requiredPublicId(tables, tableId, "table"),
    recordId: requiredPublicId(records, recordId, "record"),
  }));
};

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

type SnapshotConfigResource = "table" | "field" | "record" | "view" | "form";
const snapshotConfigResource = (key: string): SnapshotConfigResource | null => {
  if (/tableIds?$/i.test(key)) return "table";
  if (/fieldIds?$/i.test(key)) return "field";
  if (/recordIds?$/i.test(key)) return "record";
  if (/viewIds?$/i.test(key)) return "view";
  if (/formIds?$/i.test(key)) return "form";
  return null;
};

const collectSnapshotConfigIds = (value: unknown, target: Map<SnapshotConfigResource, Set<string>>, key = "") => {
  const resource = snapshotConfigResource(key);
  if (resource && typeof value === "string") {
    const ids = target.get(resource) ?? new Set<string>();
    ids.add(value);
    target.set(resource, ids);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSnapshotConfigIds(item, target, key.endsWith("s") ? key.slice(0, -1) : key);
    return;
  }
  const object = objectValue(value);
  if (object) for (const [nestedKey, nestedValue] of Object.entries(object)) collectSnapshotConfigIds(nestedValue, target, nestedKey);
};

const projectSnapshotConfigIds = (
  value: unknown,
  ids: ReadonlyMap<SnapshotConfigResource, ReadonlyMap<string, string>>,
  key = "",
): unknown => {
  const resource = snapshotConfigResource(key);
  if (resource && typeof value === "string") return requiredPublicId(ids.get(resource) ?? new Map(), value, resource);
  if (Array.isArray(value)) return value.map((item) => projectSnapshotConfigIds(item, ids, key.endsWith("s") ? key.slice(0, -1) : key));
  const object = objectValue(value);
  return object
    ? Object.fromEntries(
        Object.entries(object).map(([nestedKey, nestedValue]) => [nestedKey, projectSnapshotConfigIds(nestedValue, ids, nestedKey)]),
      )
    : value;
};

export const projectRecordSnapshot = async (snapshot: InternalRecordSnapshot) => {
  const graph = objectValue(snapshot.graph);
  const graphRecords = objectValue(graph?.records);
  const snapshotRecords = [snapshot.root, ...Object.values(graphRecords ?? {})].map(objectValue).filter((value) => value !== null);
  const nestedTableIds = snapshotRecords.flatMap((record) => {
    const table = objectValue(record.table);
    return typeof table?.id === "string" ? [table.id] : [];
  });
  const nestedRecordIds = snapshotRecords.flatMap((record) => (typeof record.id === "string" ? [record.id] : []));
  const nestedFieldIds = snapshotRecords.flatMap((record) =>
    Array.isArray(record.fields)
      ? record.fields.flatMap((field) => {
          const value = objectValue(field);
          return typeof value?.id === "string" ? [value.id] : [];
        })
      : [],
  );
  const configIds = new Map<SnapshotConfigResource, Set<string>>();
  for (const record of snapshotRecords) {
    if (!Array.isArray(record.fields)) continue;
    for (const field of record.fields) {
      const config = objectValue(field)?.config;
      collectSnapshotConfigIds(config, configIds);
    }
  }
  const relationRecordIds = snapshotRecords.flatMap((record) => {
    const data = objectValue(record.data) ?? {};
    if (!Array.isArray(record.fields)) return [];
    return record.fields.flatMap((field) => {
      const value = objectValue(field);
      if (value?.type !== "relation" || typeof value.id !== "string") return [];
      const related = [data[value.id], value.defaultValue];
      return related.flatMap((candidate) =>
        Array.isArray(candidate)
          ? candidate.filter((id): id is string => typeof id === "string")
          : typeof candidate === "string"
            ? [candidate]
            : [],
      );
    });
  });
  const [snapshots, bases, tables, records, fields, views, forms] = await Promise.all([
    projectPublicIds("documentSnapshot", [snapshot.id]),
    projectPublicIds("base", [snapshot.baseId]),
    projectPublicIds("table", [snapshot.tableId, ...nestedTableIds, ...(configIds.get("table") ?? [])]),
    projectPublicIds("record", [snapshot.recordId, ...nestedRecordIds, ...relationRecordIds, ...(configIds.get("record") ?? [])]),
    projectPublicIds("field", [...nestedFieldIds, ...(configIds.get("field") ?? [])]),
    projectPublicIds("view", [...(configIds.get("view") ?? [])]),
    projectPublicIds("form", [...(configIds.get("form") ?? [])]),
  ]);
  const configPublicIds = new Map<SnapshotConfigResource, ReadonlyMap<string, string>>([
    ["table", tables],
    ["field", fields],
    ["record", records],
    ["view", views],
    ["form", forms],
  ]);
  const projectSnapshotRecord = (record: Record<string, unknown>): Record<string, unknown> => {
    const table = objectValue(record.table);
    const internalTableId = typeof table?.id === "string" ? table.id : null;
    const projectedFields = Array.isArray(record.fields)
      ? record.fields.map((field) => {
          const value = objectValue(field);
          if (!value || typeof value.id !== "string") return field;
          const { id, shortId: _shortId, config, ...rest } = value;
          return {
            ...rest,
            id: requiredPublicId(fields, id, "field"),
            config: projectSnapshotConfigIds(config, configPublicIds),
            defaultValue:
              value.type === "relation"
                ? Array.isArray(value.defaultValue)
                  ? value.defaultValue.map((recordId) =>
                      typeof recordId === "string" ? requiredPublicId(records, recordId, "record") : recordId,
                    )
                  : typeof value.defaultValue === "string"
                    ? requiredPublicId(records, value.defaultValue, "record")
                    : value.defaultValue
                : value.defaultValue,
          };
        })
      : [];
    const data = objectValue(record.data) ?? {};
    const projectedData = Object.fromEntries(
      Array.isArray(record.fields)
        ? record.fields.flatMap((field) => {
            const value = objectValue(field);
            if (!value || typeof value.id !== "string") return [];
            const publicFieldId = requiredPublicId(fields, value.id, "field");
            const raw = data[value.id];
            const projected =
              value.type === "relation"
                ? Array.isArray(raw)
                  ? raw.map((id) => (typeof id === "string" ? requiredPublicId(records, id, "record") : id))
                  : typeof raw === "string"
                    ? requiredPublicId(records, raw, "record")
                    : raw
                : raw;
            return [[publicFieldId, projected] as const];
          })
        : [],
    );
    const { id, ...rest } = record;
    return {
      ...rest,
      id: typeof id === "string" ? requiredPublicId(records, id, "record") : id,
      table: internalTableId ? { name: table?.name, id: requiredPublicId(tables, internalTableId, "table") } : table,
      fields: projectedFields,
      data: projectedData,
    };
  };
  const projectedRoot = projectSnapshotRecord(snapshot.root);
  const projectedRecords = Object.fromEntries(
    Object.values(graphRecords ?? {}).flatMap((record) => {
      const value = objectValue(record);
      if (!value || typeof value.id !== "string") return [];
      const table = objectValue(value.table);
      if (typeof table?.id !== "string") return [];
      const key = `${requiredPublicId(tables, table.id, "table")}:${requiredPublicId(records, value.id, "record")}`;
      return [[key, projectSnapshotRecord(value)] as const];
    }),
  );
  const { id: _id, shortId: _shortId, baseId, tableId, recordId, ...rest } = snapshot;
  return {
    ...rest,
    id: requiredPublicId(snapshots, snapshot.id, "document snapshot"),
    baseId: requiredPublicId(bases, baseId, "base"),
    tableId: requiredPublicId(tables, tableId, "table"),
    recordId: requiredPublicId(records, recordId, "record"),
    root: projectedRoot,
    graph: {
      rootId: `${requiredPublicId(tables, tableId, "table")}:${requiredPublicId(records, recordId, "record")}`,
      records: projectedRecords,
    },
  };
};

export const projectDocumentPreviewData = async (data: Record<string, unknown>) => {
  const record = objectValue(data.record) ?? {};
  const table = objectValue(data.table) ?? {};
  const columns = (Array.isArray(data.columns) ? data.columns : []).map(objectValue).filter((column) => column !== null);
  const rows = (Array.isArray(data.rows) ? data.rows : []).map(objectValue).filter((row) => row !== null);
  const internalTableId = typeof table.id === "string" ? table.id : typeof record.tableId === "string" ? record.tableId : null;
  const internalRecordId = typeof record.id === "string" ? record.id : null;
  if (!internalTableId || !internalRecordId) throw new Error("Document preview data is missing its record identity.");
  const fields = await gridsService.field.listByTable(internalTableId);
  const fieldsByTemplateKey = new Map(fields.flatMap((field) => [[field.id, field] as const, [field.shortId, field] as const]));
  const columnFieldIds = columns.flatMap((column) => (typeof column.fieldId === "string" ? [column.fieldId] : []));
  const columnTableIds = columns.flatMap((column) => (typeof column.tableId === "string" ? [column.tableId] : []));
  const rowRecordIds = rows.flatMap((row) => (typeof row.recordId === "string" ? [row.recordId] : []));
  const rowTableIds = rows.flatMap((row) => (typeof row.tableId === "string" ? [row.tableId] : []));
  const relationRecordIds = Object.entries(objectValue(record.data) ?? {}).flatMap(([fieldId, value]) => {
    if (fieldsByTemplateKey.get(fieldId)?.type !== "relation") return [];
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string" && z.string().uuid().safeParse(id).success)
      : typeof value === "string" && z.string().uuid().safeParse(value).success
        ? [value]
        : [];
  });
  for (const row of rows) {
    for (const column of columns) {
      if (column.type !== "relation") continue;
      const value = row[typeof column.key === "string" ? column.key : ""] ?? row[typeof column.label === "string" ? column.label : ""];
      if (Array.isArray(value))
        relationRecordIds.push(...value.filter((id): id is string => typeof id === "string" && z.string().uuid().safeParse(id).success));
      else if (typeof value === "string" && z.string().uuid().safeParse(value).success) relationRecordIds.push(value);
    }
  }
  const images = (Array.isArray(data.images) ? data.images : []).map(objectValue).filter((image) => image !== null);
  const primaryImage = objectValue(data.primaryImage);
  const allImages = [...images, ...(primaryImage ? [primaryImage] : [])];
  const [tables, records, publicFields, files] = await Promise.all([
    projectPublicIds("table", [internalTableId, ...columnTableIds, ...rowTableIds]),
    projectPublicIds("record", [internalRecordId, ...rowRecordIds, ...relationRecordIds]),
    projectPublicIds("field", [
      ...fields.map((field) => field.id),
      ...columnFieldIds,
      ...allImages.flatMap((image) => (typeof image.fieldId === "string" ? [image.fieldId] : [])),
    ]),
    projectPublicIds(
      "file",
      allImages.flatMap((image) => (typeof image.fileId === "string" ? [image.fileId] : [])),
    ),
  ]);
  const projectRelationValue = (value: unknown) =>
    Array.isArray(value)
      ? value.map((id) =>
          typeof id === "string" && z.string().uuid().safeParse(id).success ? requiredPublicId(records, id, "record") : id,
        )
      : typeof value === "string"
        ? z.string().uuid().safeParse(value).success
          ? requiredPublicId(records, value, "record")
          : value
        : value;
  const projectRowRelationValue = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map((id) => (typeof id === "string" ? (records.get(id) ?? id) : id))
      : typeof value === "string"
        ? (records.get(value) ?? value)
        : value;
  const projectRow = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (key === "recordId" && typeof value === "string") return [key, requiredPublicId(records, value, "record")];
        if (key === "tableId" && typeof value === "string") return [key, requiredPublicId(tables, value, "table")];
        const column = columns.find((candidate) => candidate.key === key || candidate.label === key);
        const publicKey = publicFields.get(key) ?? key;
        return [publicKey, column?.type === "relation" ? projectRowRelationValue(value) : value];
      }),
    );
  const projectedColumns = columns.map((column) => ({
    key: typeof column.key === "string" ? (publicFields.get(column.key) ?? column.key) : "",
    label: typeof column.label === "string" ? column.label : "",
    ...(typeof column.tableId === "string" ? { tableId: requiredPublicId(tables, column.tableId, "table") } : {}),
    ...(typeof column.fieldId === "string" ? { fieldId: requiredPublicId(publicFields, column.fieldId, "field") } : {}),
    ...(typeof column.joinAlias === "string" ? { joinAlias: column.joinAlias } : {}),
    type: typeof column.type === "string" ? column.type : "unknown",
    sqlType: typeof column.sqlType === "string" ? column.sqlType : "unknown",
    ...(typeof column.aggregate === "string" ? { aggregate: column.aggregate } : {}),
  }));
  const projectImage = (image: Record<string, unknown>) => ({
    fieldId: requiredPublicId(publicFields, String(image.fieldId), "field"),
    fieldName: String(image.fieldName),
    fileId: requiredPublicId(files, String(image.fileId), "file"),
    filename: String(image.filename),
    mimeType: String(image.mimeType),
    sizeBytes: Number(image.sizeBytes),
    url: String(image.url),
  });
  const recordData = objectValue(record.data) ?? {};
  const template = objectValue(data.template) ?? {};
  const snapshot = objectValue(data.snapshot);
  return PublicDocumentPreviewDataSchema.parse({
    record: {
      id: requiredPublicId(records, internalRecordId, "record"),
      tableId: requiredPublicId(tables, internalTableId, "table"),
      ...(typeof record.version === "number" ? { version: record.version } : {}),
      data: Object.fromEntries(
        Object.entries(recordData).map(([fieldId, value]) => {
          const field = fieldsByTemplateKey.get(fieldId);
          if (!field) throw new Error(`Document preview data contains unknown field ${fieldId}.`);
          return [field.shortId, field.type === "relation" ? projectRelationValue(value) : value];
        }),
      ),
      ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
      ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {}),
      ...(objectValue(record.meta) ? { meta: record.meta } : {}),
    },
    table: { id: requiredPublicId(tables, internalTableId, "table"), name: String(table.name ?? "") },
    query: { columns: projectedColumns, rows: rows.map(projectRow) },
    rows: rows.map(projectRow),
    columns: projectedColumns,
    template: { id: String(template.id ?? "draft"), name: String(template.name ?? "Draft template") },
    date: objectValue(data.date) ?? {},
    images: images.map(projectImage),
    primaryImage: primaryImage ? projectImage(primaryImage) : null,
    app: objectValue(data.app) ?? {},
    business: objectValue(data.business) ?? {},
    document: objectValue(data.document) ?? {},
    snapshot: snapshot ? await projectRecordSnapshot(snapshot as InternalRecordSnapshot) : null,
  });
};

export const resolveDocumentRecordId = async (publicId: string): Promise<string | null> =>
  (await resolvePublicIds("record", [publicId])).get(publicId) ?? null;

export const errorResponse = (c: Context<AuthContext>, message: string, status: number) =>
  c.json({ message }, status === 400 ? 400 : status === 403 ? 403 : status === 404 ? 404 : 500);

export const auditRequestContext = (c: Context<AuthContext>) => ({
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("cf-connecting-ip") || null,
  userAgent: c.req.header("user-agent") ?? null,
});

export const RecordLookupQuerySchema = z.object({
  q: z.string().optional().default(""),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  excludeIds: z
    .string()
    .optional()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    )
    .pipe(z.array(ShortIdSchema)),
});

export const PublicDocumentPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PUBLIC_DOCUMENT_PAGE_LIMIT).optional().default(50),
  cursor: z
    .string()
    .optional()
    .default("")
    .refine((cursor) => !cursor || decodeDocumentCursor(cursor) !== null, "Invalid document cursor"),
});

export const PublicDocumentListQuerySchema = PublicDocumentPageQuerySchema.extend({
  q: z.string().optional().default(""),
  tags: z
    .string()
    .optional()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    ),
});

export const DocumentBrowseQuerySchema = PublicDocumentListQuerySchema.extend({
  mode: z.enum(["list", "folders"]).optional().default("list"),
  path: z
    .string()
    .optional()
    .default("")
    .transform((s) =>
      s
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
});

export const DocumentTemplateSummaryQuerySchema = z.object({
  min: z.enum(["read", "write", "admin"]).optional().default("read"),
});

export const loadTemplateAndTable = async (templateId: string) => {
  const parsed = ShortIdSchema.safeParse(templateId);
  if (!parsed.success) return null;
  const template = await gridsService.document.getTemplateByShortId(parsed.data);
  if (!template) return null;
  const table = await gridsService.table.get(template.tableId);
  if (!table) return null;
  return { template, table };
};

export const gateTemplate = async (
  c: Context<AuthContext>,
  loaded: NonNullable<Awaited<ReturnType<typeof loadTemplateAndTable>>>,
  required: "read" | "write" | "admin",
) => gateAt(c, { baseId: loaded.table.baseId }, required);

export const snapshotRecordAccessResolver = (c: Context<AuthContext>) => async (target: { baseId: string; tableId: string }) => {
  const resolved = await gateAt(c, { baseId: target.baseId }, "read");
  return resolved.ok ? ALL_RECORD_ACCESS : null;
};

export const gateDocument = async (
  c: Context<AuthContext>,
  document: NonNullable<Awaited<ReturnType<typeof gridsService.document.getDocument>>>,
  required: "read" | "write",
) => gateAt(c, { baseId: document.baseId }, required);

export const gateEnabledTemplateWrite = async (
  c: Context<AuthContext>,
  loaded: NonNullable<Awaited<ReturnType<typeof loadTemplateAndTable>>>,
) => {
  const gate = await gateTemplate(c, loaded, "write");
  if (!gate.ok) return gate;
  if (!loaded.template.enabled && !gridsService.permission.hasAtLeast(gate.data, "admin")) {
    return gateAt(c, { baseId: loaded.table.baseId }, "admin");
  }
  return gate;
};

export const liveRenderData = async (
  c: Context<AuthContext>,
  params: {
    template: Pick<NonNullable<Awaited<ReturnType<typeof gridsService.document.getTemplate>>>, "source"> &
      Partial<Pick<NonNullable<Awaited<ReturnType<typeof gridsService.document.getTemplate>>>, "id" | "shortId" | "name">>;
    tableId: string;
    recordId: string;
    createdAt?: Date;
    dateConfig?: Awaited<ReturnType<typeof getDateConfig>>;
  },
) => {
  const table = await gridsService.table.get(params.tableId);
  if (!table) return { ok: false as const, status: 404, phase: "data" as const, message: apiMessages(c).tableNotFound };
  const recordAccess = await gateAt(c, { baseId: table.baseId }, "read");
  if (!recordAccess.ok) return { ok: false as const, status: 404, phase: "data" as const, message: apiMessages(c).recordNotFound };
  const dateConfig = params.dateConfig ?? (await getDateConfig(c));
  const record = await gridsService.record.get(params.tableId, params.recordId, {
    dateConfig,
    viewer: currentActorViewer(c),
    recordAccess: ALL_RECORD_ACCESS,
  });
  if (!record) return { ok: false as const, status: 404, phase: "data" as const, message: apiMessages(c).recordNotFound };

  const rendered = await gridsService.document.buildLiveRenderData({
    template: params.template,
    table,
    record,
    app: await gridsService.document.buildTemplateAppData(),
    dateConfig,
    createdAt: params.createdAt,
  });
  if (!rendered.ok) return { ok: false as const, status: rendered.error.status, phase: "source" as const, message: rendered.error.message };
  return {
    ok: true as const,
    table,
    record,
    source: rendered.data.source,
    columns: rendered.data.columns,
    rows: rendered.data.rows,
    data: rendered.data.data,
  };
};

export const draftTemplateFromBody = (
  body: z.infer<typeof PublicDocumentTemplateDraftPreviewSchema>,
  base?: Partial<NonNullable<Awaited<ReturnType<typeof gridsService.document.getTemplate>>>>,
) => ({
  id: base?.id,
  shortId: base?.shortId,
  name: base?.name,
  source: body.source,
  renderer: body.renderer,
});

export const addDraftDocumentMetadata = async (
  c: Context<AuthContext>,
  params: {
    template: ReturnType<typeof draftTemplateFromBody>;
    data: Record<string, unknown>;
    createdAt: Date;
    dateConfig: Awaited<ReturnType<typeof getDateConfig>>;
  },
) => {
  const built = await gridsService.document.buildDocumentRenderData({
    template: params.template,
    renderData: params.data,
    documentShortId: "draft",
    createdAt: params.createdAt,
    dateConfig: params.dateConfig,
    documentNumber: params.template.renderer.kind === "profile" ? "draft" : undefined,
  });
  if (!built.ok) return { ok: false as const, response: c.json({ message: built.error.message, phase: "document" }, built.error.status) };
  return { ok: true as const, data: built.data.data };
};

export const renderDraftDataResponse = async (
  c: Context<AuthContext>,
  params: {
    template: ReturnType<typeof draftTemplateFromBody>;
    tableId: string;
    recordId: string;
  },
) => {
  const createdAt = new Date();
  const dateConfig = await getDateConfig(c);
  const rendered = await liveRenderData(c, { ...params, createdAt, dateConfig });
  if (!rendered.ok) return c.json({ message: rendered.message, phase: rendered.phase }, rendered.status === 400 ? 400 : 404);
  const data = await addDraftDocumentMetadata(c, { template: params.template, data: rendered.data, createdAt, dateConfig });
  if (!data.ok) return data.response;
  if (params.template.renderer.kind === "profile") {
    const input = await gridsService.document.renderProfileInput(params.template, data.data, getLocale(c));
    if (!input.ok) return c.json({ message: input.error.message, phase: "profile" }, input.error.status);
    return c.json({ html: "", source: rendered.source, data: await projectDocumentPreviewData(data.data) });
  }
  const html = await gridsService.document.renderHtml(params.template, data.data, getLocale(c));
  if (!html.ok) return c.json({ message: html.error.message, phase: "html" }, html.error.status);
  return c.json({ html: html.data, source: rendered.source, data: await projectDocumentPreviewData(data.data) });
};

export const renderDraftPdfResponse = async (
  c: Context<AuthContext>,
  params: {
    template: ReturnType<typeof draftTemplateFromBody>;
    tableId: string;
    recordId: string;
  },
) => {
  const createdAt = new Date();
  const dateConfig = await getDateConfig(c);
  const rendered = await liveRenderData(c, { ...params, createdAt, dateConfig });
  if (!rendered.ok) return c.json({ message: rendered.message, phase: rendered.phase }, rendered.status === 400 ? 400 : 404);
  const data = await addDraftDocumentMetadata(c, { template: params.template, data: rendered.data, createdAt, dateConfig });
  if (!data.ok) return data.response;

  if (params.template.renderer.kind === "profile") {
    const input = await gridsService.document.renderProfileInput(params.template, data.data, getLocale(c));
    if (!input.ok) return c.json({ message: input.error.message, phase: "profile" }, input.error.status);
    const preview = await gridsService.document.preview({
      profileId: params.template.renderer.id,
      profileVersion: params.template.renderer.version,
      snapshot: input.data,
      issuedAt: createdAt,
    });
    if (!preview.ok) return c.json({ message: preview.error.message, phase: "profile" }, preview.error.status);
    const pdf = preview.data.find((artifact) => artifact.key === "pdf");
    if (!pdf) return c.json({ message: apiMessages(c).documentProducedNoPdf, phase: "profile" }, 500);
    return pdfResponse(pdf.bytes, pdf.filename, {}, "inline");
  }
  const pdf = await gridsService.document.renderPdfPreview(params.template, data.data, "preview.html", undefined, getLocale(c));
  if (!pdf.ok) {
    return c.json(
      { message: pdf.error.message, phase: pdf.error.phase, code: pdf.error.code },
      pdf.error.status === 400 ? 400 : pdf.error.status === 502 ? 502 : 500,
    );
  }
  return pdfResponse(pdf.pdf.pdf, "preview.pdf", {}, "inline");
};
