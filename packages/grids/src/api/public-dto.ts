import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import {
  type Base,
  BaseSchema,
  CreateTableSchema,
  CreateViewSchema,
  type FederatedDiagnostic,
  type FederatedDraftInput,
  type FederatedRevision,
  type FederatedSourceCandidatePage,
  type FederatedSourcePublication,
  type Field,
  FieldSchema,
  FormatSpecSchema,
  type GridRecord,
  GridRecordSchema,
  ShortIdSchema,
  type Table,
  type TableAuditPolicy,
  TableAuditPolicySchema,
  TableMutationPolicySchema,
  TableQueryResponseSchema,
  TableSchema,
  UpdateTableSchema,
  UpdateViewSchema,
  type View,
  ViewSchema,
} from "../contracts";
import { groupedColumnFieldId, rewriteGroupedColumnKeys } from "../presentation-ids";
import { listByTable } from "../service/field-read";
import type { Form } from "../service/forms";
import { isSequentialNumberSeriesConfig, loadFieldNumberSeries } from "../service/number-series";
import { projectPublicIds, resolvePublicIds } from "../service/public-resources";
import type { RecordComment } from "../service/record-comments";
import type { GridFile } from "../service/types";
import { PublicNumberSeriesSummarySchema, toPublicNumberSeries } from "./number-series-dto";

export const PublicBaseSchema = BaseSchema.omit({ id: true, shortId: true }).extend({ id: ShortIdSchema });
export const PublicRecordDisplayConfigSchema = z.object({
  mode: z.enum(["table", "cards", "calendar"]),
  cards: z.object({ imageFieldId: ShortIdSchema.nullable().optional(), fieldIds: z.array(ShortIdSchema).optional() }).optional(),
  calendar: z.object({ dateFieldId: ShortIdSchema.nullable().optional() }).optional(),
});
export const PublicFieldColumnSchema = z.object({
  fieldId: ShortIdSchema,
  label: z.string().optional(),
  format: FormatSpecSchema.optional(),
});

const TableAuditPolicyObjectSchema = TableAuditPolicySchema.removeDefault();
const PublicAuditUpdateRequirementSchema = TableAuditPolicyObjectSchema.shape.update
  .unwrap()
  .safeExtend({ fieldIds: z.array(ShortIdSchema).max(200).default([]) });
export const PublicTableAuditPolicySchema = TableAuditPolicyObjectSchema.extend({
  update: PublicAuditUpdateRequirementSchema.optional(),
}).default({});

export const PublicTableSchema = TableSchema.omit({ id: true, shortId: true, baseId: true }).extend({
  id: ShortIdSchema,
  baseId: ShortIdSchema,
  columns: z.array(PublicFieldColumnSchema),
  displayConfig: PublicRecordDisplayConfigSchema,
  auditPolicy: PublicTableAuditPolicySchema,
});

export const PublicCreateTableSchema = CreateTableSchema.omit({ columns: true, displayConfig: true }).extend({
  columns: z.array(PublicFieldColumnSchema).optional(),
  displayConfig: PublicRecordDisplayConfigSchema.optional(),
});

export const PublicUpdateTableSchema = UpdateTableSchema.omit({ columns: true, displayConfig: true, auditPolicy: true }).extend({
  columns: z.array(PublicFieldColumnSchema).optional(),
  displayConfig: PublicRecordDisplayConfigSchema.optional(),
  auditPolicy: PublicTableAuditPolicySchema.optional(),
});

export const PublicMutationPolicyInputSchema = z.object({ policy: TableMutationPolicySchema }).strict();
export const PublicMutationPolicyUpdateSchema = z
  .object({ policy: TableMutationPolicySchema, confirmFreeze: z.literal(true).optional() })
  .strict()
  .superRefine((input, ctx) => {
    if (input.policy.mode === "selected" && input.policy.sources.length === 0 && input.confirmFreeze !== true) {
      ctx.addIssue({ code: "custom", path: ["confirmFreeze"], message: "Freezing all record changes requires confirmation" });
    }
  });
export const PublicMutationPolicyResponseSchema = z.object({ policy: TableMutationPolicySchema }).strict();
export const PublicMutationPolicyImpactItemSchema = z
  .object({
    kind: z.enum(["form", "workflow", "action"]),
    id: ShortIdSchema,
    name: z.string(),
  })
  .strict();
export const PublicMutationPolicyImpactSchema = z
  .object({
    items: z.array(PublicMutationPolicyImpactItemSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    truncated: z.boolean(),
    complete: z.boolean(),
  })
  .strict();
const PublicRelationConfigSchema = z.object({
  targetTableId: ShortIdSchema.optional(),
  cardinality: z.enum(["single", "multiple"]).optional(),
});
const PublicLookupConfigSchema = z.object({
  relationFieldId: ShortIdSchema.optional(),
  targetFieldId: ShortIdSchema.optional(),
  format: FormatSpecSchema.optional(),
});
const PublicRollupConfigSchema = PublicLookupConfigSchema.extend({
  agg: z.enum(["count", "sum", "avg", "min", "max"]).optional(),
});
const PublicRelationDefaultSchema = z.union([ShortIdSchema, z.array(ShortIdSchema)]).nullable();

const validatePublicFieldReferences = (
  value: { type: string; config?: Record<string, unknown>; defaultValue?: unknown },
  ctx: z.RefinementCtx,
) => {
  const configSchema =
    value.type === "relation"
      ? PublicRelationConfigSchema
      : value.type === "lookup"
        ? PublicLookupConfigSchema
        : value.type === "rollup"
          ? PublicRollupConfigSchema
          : null;
  if (configSchema && !configSchema.safeParse(value.config ?? {}).success) {
    ctx.addIssue({ code: "custom", message: `Invalid public ${value.type} field configuration`, path: ["config"] });
  }
  if (value.type === "relation" && value.defaultValue !== undefined && !PublicRelationDefaultSchema.safeParse(value.defaultValue).success) {
    ctx.addIssue({ code: "custom", message: "Invalid public relation default", path: ["defaultValue"] });
  }
};

export const PublicFieldSchema = FieldSchema.omit({ id: true, shortId: true, tableId: true })
  .extend({
    id: ShortIdSchema,
    tableId: ShortIdSchema,
    numberSeries: PublicNumberSeriesSummarySchema.nullable().optional(),
  })
  .superRefine(validatePublicFieldReferences);

const PublicFieldWriteShape = {
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(200).nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  position: z.number().int().optional(),
  required: z.boolean().optional(),
  presentable: z.boolean().optional(),
  hideInTable: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  indexed: z.boolean().optional(),
  uniqueConstraint: z.boolean().optional(),
};
export const PublicCreateFieldSchema = z
  .object({ ...PublicFieldWriteShape, type: z.string().min(1) })
  .superRefine(validatePublicFieldReferences);
export const PublicUpdateFieldSchema = z.object(PublicFieldWriteShape).partial();

const PublicFederatedDiagnosticSchema = z
  .object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1000),
    sourceTableId: ShortIdSchema.optional(),
    targetFieldId: ShortIdSchema.optional(),
    sourceFieldId: ShortIdSchema.optional(),
  })
  .strict();
const PublicFederatedMappingSchema = z
  .object({
    targetFieldId: ShortIdSchema,
    sourceTableId: ShortIdSchema,
    sourceFieldId: ShortIdSchema,
    config: z.record(z.string(), z.unknown()),
  })
  .strict();
const PublicFederatedMappingWriteSchema = PublicFederatedMappingSchema.extend({
  config: z.record(z.string(), z.unknown()).optional(),
});
export const PublicFederatedDraftInputSchema = z
  .object({
    sourceTableIds: z.array(ShortIdSchema).max(50),
    mappings: z.array(PublicFederatedMappingWriteSchema).max(10_000),
  })
  .strict();
export const PublicUpdateFederatedDraftSchema = PublicFederatedDraftInputSchema.extend({ draftToken: z.string().min(1) });
export const PublicFederatedRevisionViewSchema = z
  .object({
    tableId: ShortIdSchema,
    revision: z.number().int().positive(),
    status: z.enum(["draft", "active", "degraded", "superseded"]),
    diagnostics: z.array(PublicFederatedDiagnosticSchema),
    revisionToken: z.string().min(1),
    createdBy: z.string().uuid().nullable(),
    publishedBy: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    publishedAt: z.string().datetime().nullable(),
    sources: z.array(
      z
        .object({
          sourceTableId: ShortIdSchema.nullable(),
          position: z.number().int().nonnegative(),
          authorizedAt: z.string().datetime().nullable(),
          revokedAt: z.string().datetime().nullable(),
        })
        .strict(),
    ),
    mappings: z.array(PublicFederatedMappingSchema),
  })
  .strict();
export const PublicFederatedTableConfigSchema = z
  .object({
    current: PublicFederatedRevisionViewSchema.nullable(),
    draft: PublicFederatedRevisionViewSchema,
  })
  .strict();
export const PublicFederatedValidationSchema = z
  .object({ valid: z.boolean(), diagnostics: z.array(PublicFederatedDiagnosticSchema) })
  .strict();
const PublicFederatedSourceCandidateSchema = z
  .object({
    base: z.object({ id: ShortIdSchema, name: z.string() }).strict(),
    table: z
      .object({
        id: ShortIdSchema,
        baseId: ShortIdSchema,
        name: z.string(),
        description: z.string().nullable(),
        icon: z.string().nullable(),
      })
      .strict(),
    fieldCount: z.number().int().nonnegative(),
  })
  .strict();
export const PublicFederatedSourceCandidatePageSchema = z
  .object({
    items: z.array(PublicFederatedSourceCandidateSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().min(1),
    offset: z.number().int().nonnegative(),
  })
  .strict();
export const PublicFederatedSourcePublicationSchema = z
  .object({
    targetBaseId: ShortIdSchema,
    targetBaseName: z.string(),
    targetTableId: ShortIdSchema,
    targetTableName: z.string(),
    revision: z.number().int().positive(),
    status: z.enum(["active", "degraded"]),
    publishedAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
    mappings: z.array(
      z
        .object({
          sourceFieldId: ShortIdSchema,
          sourceFieldName: z.string(),
          targetFieldId: ShortIdSchema,
          targetFieldName: z.string(),
          targetFieldType: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export const PublicFederatedSourcePublicationListSchema = z.array(PublicFederatedSourcePublicationSchema);

export type PublicFederatedRevisionView = z.infer<typeof PublicFederatedRevisionViewSchema>;
export type PublicFederatedSourceCandidate = z.infer<typeof PublicFederatedSourceCandidateSchema>;
export type PublicFederatedSourcePublication = z.infer<typeof PublicFederatedSourcePublicationSchema>;
const PublicGroupedColumnKeySchema = z
  .string()
  .min(1)
  .superRefine((key, ctx) => {
    const fieldId = groupedColumnFieldId(key);
    if (fieldId !== null && fieldId !== "*" && !ShortIdSchema.safeParse(fieldId).success) {
      ctx.addIssue({ code: "custom", message: "Grouped columns must reference a public field ID" });
    }
  });

export const PublicViewUiSettingsSchema = z.object({
  displayConfig: PublicRecordDisplayConfigSchema.optional(),
  columns: z
    .array(
      z.union([
        PublicFieldColumnSchema,
        z.object({
          kind: z.literal("computed"),
          id: z.string(),
          label: z.string(),
          expression: z.string(),
          format: FormatSpecSchema.optional(),
        }),
      ]),
    )
    .optional(),
  groupedColumnOrder: z.array(PublicGroupedColumnKeySchema).optional(),
  hiddenGroupedColumns: z.array(PublicGroupedColumnKeySchema).optional(),
});

export const PublicViewSchema = ViewSchema.omit({ id: true, shortId: true, tableId: true }).extend({
  id: ShortIdSchema,
  tableId: ShortIdSchema,
  ui: PublicViewUiSettingsSchema,
});

export const PublicCreateViewSchema = CreateViewSchema.omit({ ui: true }).extend({ ui: PublicViewUiSettingsSchema.optional() });
export const PublicUpdateViewSchema = UpdateViewSchema.omit({ ui: true }).extend({ ui: PublicViewUiSettingsSchema.optional() });
const PublicInlineCreateFieldSchema = z.object({
  fieldId: ShortIdSchema,
  label: z.string().optional(),
  helpText: z.string().optional(),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
});
const PublicFormFieldEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user_input"),
    fieldId: ShortIdSchema,
    label: z.string().optional(),
    helpText: z.string().optional(),
    required: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
    inlineCreate: z.object({ enabled: z.boolean().optional(), fields: z.array(PublicInlineCreateFieldSchema).optional() }).optional(),
  }),
  z.object({ kind: z.literal("form_value"), fieldId: ShortIdSchema, value: z.unknown() }),
]);
export const PublicFormConfigSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(PublicFormFieldEntrySchema),
  validations: z
    .array(
      z.object({
        leftFieldId: ShortIdSchema,
        operator: z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]),
        rightFieldId: ShortIdSchema,
        message: z.string(),
        errorFieldId: ShortIdSchema.optional(),
      }),
    )
    .optional(),
  submitLabel: z.string().optional(),
  successMessage: z.string().optional(),
  redirectUrl: z.string().nullable().optional(),
  titleImage: z.string().optional(),
});
export const PublicFormSchema = z.object({
  id: ShortIdSchema.optional(),
  tableId: ShortIdSchema,
  name: z.string(),
  config: PublicFormConfigSchema,
  publicToken: z.string().nullable(),
  isActive: z.boolean(),
  ownerUserId: z.string().uuid().nullable(),
  position: z.number().int(),
  isDefault: z.boolean(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const PublicGridRecordSchema = GridRecordSchema.omit({ id: true, shortId: true, tableId: true, finalRevisionId: true }).extend({
  id: ShortIdSchema,
  tableId: ShortIdSchema,
});
export const PublicGridFileSchema = z.object({
  id: ShortIdSchema,
  recordId: ShortIdSchema,
  fieldId: ShortIdSchema,
  position: z.number().int(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export const PublicRecordCommentSchema = z.object({
  id: ShortIdSchema,
  authorUserId: z.string().uuid().nullable(),
  authorDisplayName: z.string(),
  authorAvatarHash: z.string().nullable(),
  body: z.string().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PublicBase = z.infer<typeof PublicBaseSchema>;
export type PublicTable = z.infer<typeof PublicTableSchema>;
export type PublicField = z.infer<typeof PublicFieldSchema>;
export type PublicView = z.infer<typeof PublicViewSchema>;
export type PublicGridRecord = z.infer<typeof PublicGridRecordSchema>;

export const PublicRecordChangeFeedItemSchema = z
  .object({
    baseId: ShortIdSchema,
    tableId: ShortIdSchema,
    recordId: ShortIdSchema,
    type: z.enum(["record.created", "record.updated", "record.deleted", "record.restored", "record.finalized"]),
    version: z.number().int().positive(),
    deletedAt: z.string().datetime({ offset: true }).nullable(),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const PublicRecordChangeFeedPageSchema = z
  .object({
    items: z.array(PublicRecordChangeFeedItemSchema),
    cursor: z.string().max(2_000).nullable(),
    hasMore: z.boolean(),
    retentionDays: z.literal(30),
  })
  .strict();
export type PublicRecordChangeFeedItem = z.infer<typeof PublicRecordChangeFeedItemSchema>;
export type PublicRecordChangeFeedPage = z.infer<typeof PublicRecordChangeFeedPageSchema>;
export type PublicGridFile = z.infer<typeof PublicGridFileSchema>;
export type PublicRecordComment = z.infer<typeof PublicRecordCommentSchema>;
export type PublicForm = z.infer<typeof PublicFormSchema>;

type PublicWriteDeps = { listFields?: typeof listByTable };

const convertPublicDisplayConfig = (config: z.infer<typeof PublicRecordDisplayConfigSchema> | undefined, fields: Map<string, Field>) => {
  if (!config) return config;
  const resolve = (id: string | null | undefined): string | null | undefined => (id === null || id === undefined ? id : fields.get(id)?.id);
  const imageFieldId = resolve(config.cards?.imageFieldId);
  const cardFieldIds = config.cards?.fieldIds?.map((id) => resolve(id));
  const dateFieldId = resolve(config.calendar?.dateFieldId);
  if (imageFieldId === undefined && config.cards?.imageFieldId !== undefined) return null;
  if (cardFieldIds?.some((id) => id === undefined)) return null;
  if (dateFieldId === undefined && config.calendar?.dateFieldId !== undefined) return null;
  return {
    ...config,
    ...(config.cards
      ? {
          cards: {
            ...config.cards,
            ...(config.cards.imageFieldId !== undefined ? { imageFieldId } : {}),
            ...(cardFieldIds ? { fieldIds: cardFieldIds.filter((id): id is string => id !== undefined && id !== null) } : {}),
          },
        }
      : {}),
    ...(config.calendar ? { calendar: { ...config.calendar, ...(config.calendar.dateFieldId !== undefined ? { dateFieldId } : {}) } } : {}),
  };
};

const convertPublicColumns = (columns: z.infer<typeof PublicFieldColumnSchema>[] | undefined, fields: Map<string, Field>) => {
  if (!columns) return columns;
  const converted = columns.map((column) => {
    const field = fields.get(column.fieldId);
    return field ? { ...column, fieldId: field.id } : null;
  });
  return converted.some((column) => column === null)
    ? null
    : converted.filter((column): column is NonNullable<typeof column> => column !== null);
};

const convertPublicAuditPolicy = (
  policy: TableAuditPolicy | undefined,
  fields: Map<string, Field>,
): TableAuditPolicy | null | undefined => {
  if (!policy?.update?.fieldIds) return policy;
  const fieldIds = policy.update.fieldIds.map((id) => fields.get(id)?.id);
  if (fieldIds.some((id) => !id)) return null;
  return { ...policy, update: { ...policy.update, fieldIds: fieldIds.filter((id): id is string => Boolean(id)) } };
};

const fieldsForPublicWrite = async (tableId: string | null, deps: PublicWriteDeps): Promise<Map<string, Field>> =>
  new Map((tableId ? await (deps.listFields ?? listByTable)(tableId) : []).map((field) => [field.shortId, field]));

const invalidReference = <T>(): Result<T> => fail(err.badInput("Unknown field ID"));

export const fromPublicCreateTable = async (
  input: z.infer<typeof PublicCreateTableSchema>,
  deps: PublicWriteDeps = {},
): Promise<Result<z.infer<typeof CreateTableSchema>>> => {
  const fields = await fieldsForPublicWrite(null, deps);
  const columns = convertPublicColumns(input.columns, fields);
  const displayConfig = convertPublicDisplayConfig(input.displayConfig, fields);
  if (columns === null || displayConfig === null) return invalidReference();
  const parsed = CreateTableSchema.safeParse({ ...input, columns, displayConfig });
  return parsed.success ? ok(parsed.data) : fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid table"));
};

export const fromPublicUpdateTable = async (
  tableId: string,
  input: z.infer<typeof PublicUpdateTableSchema>,
  deps: PublicWriteDeps = {},
): Promise<Result<z.infer<typeof UpdateTableSchema>>> => {
  const fields = await fieldsForPublicWrite(tableId, deps);
  const columns = convertPublicColumns(input.columns, fields);
  const displayConfig = convertPublicDisplayConfig(input.displayConfig, fields);
  const auditPolicy = convertPublicAuditPolicy(input.auditPolicy, fields);
  if (columns === null || displayConfig === null || auditPolicy === null) return invalidReference();
  const parsed = UpdateTableSchema.safeParse({ ...input, columns, displayConfig, auditPolicy });
  return parsed.success ? ok(parsed.data) : fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid table"));
};

const convertPublicViewUi = async (
  tableId: string,
  ui: z.infer<typeof PublicViewUiSettingsSchema> | undefined,
  deps: PublicWriteDeps,
): Promise<Result<z.infer<typeof ViewSchema>["ui"] | undefined>> => {
  if (!ui) return ok(undefined);
  const fields = await fieldsForPublicWrite(tableId, deps);
  const columns = ui.columns?.map((column) => {
    if (!("fieldId" in column)) return column;
    const field = fields.get(column.fieldId);
    return field ? { ...column, fieldId: field.id } : null;
  });
  if (columns?.some((column) => column === null)) return invalidReference();
  const displayConfig = convertPublicDisplayConfig(ui.displayConfig, fields);
  if (displayConfig === null) return invalidReference();
  const resolve = (id: string) => fields.get(id)?.id ?? null;
  const groupedColumnOrder = rewriteGroupedColumnKeys(ui.groupedColumnOrder, resolve);
  if (!groupedColumnOrder.ok) return groupedColumnOrder;
  const hiddenGroupedColumns = rewriteGroupedColumnKeys(ui.hiddenGroupedColumns, resolve);
  if (!hiddenGroupedColumns.ok) return hiddenGroupedColumns;
  return ok({
    ...ui,
    displayConfig,
    columns: columns?.filter((column): column is NonNullable<typeof column> => column !== null),
    groupedColumnOrder: groupedColumnOrder.data,
    hiddenGroupedColumns: hiddenGroupedColumns.data,
  });
};

export const fromPublicCreateView = async (
  tableId: string,
  input: z.infer<typeof PublicCreateViewSchema>,
  deps: PublicWriteDeps = {},
): Promise<Result<z.infer<typeof CreateViewSchema>>> => {
  const ui = await convertPublicViewUi(tableId, input.ui, deps);
  if (!ui.ok) return ui;
  const parsed = CreateViewSchema.safeParse({ ...input, ui: ui.data });
  return parsed.success ? ok(parsed.data) : fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid view"));
};

export const fromPublicUpdateView = async (
  tableId: string,
  input: z.infer<typeof PublicUpdateViewSchema>,
  deps: PublicWriteDeps = {},
): Promise<Result<z.infer<typeof UpdateViewSchema>>> => {
  const ui = await convertPublicViewUi(tableId, input.ui, deps);
  if (!ui.ok) return ui;
  const parsed = UpdateViewSchema.safeParse({ ...input, ui: ui.data });
  return parsed.success ? ok(parsed.data) : fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid view"));
};

export const PublicBaseListSchema = z.object({
  items: z.array(PublicBaseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export const PublicTableListSchema = z.array(PublicTableSchema);
export const PublicFieldListSchema = z.array(PublicFieldSchema);
export const PublicViewListSchema = z.array(PublicViewSchema);
const PublicGridFilePreviewSchema = z.object({
  fileId: ShortIdSchema,
  fieldId: ShortIdSchema,
  recordId: ShortIdSchema,
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
});
export const PublicTableQueryResponseSchema = TableQueryResponseSchema.omit({
  items: true,
  filePreviews: true,
  relationLabels: true,
}).extend({
  items: z.array(PublicGridRecordSchema).optional(),
  relationLabels: z.record(ShortIdSchema, z.string()).optional(),
  filePreviews: z.record(ShortIdSchema, z.record(ShortIdSchema, PublicGridFilePreviewSchema)).optional(),
});
export type PublicTableQueryResult = z.infer<typeof PublicTableQueryResponseSchema>;

const omitShortId = <T extends { shortId: string }>(value: T): Omit<T, "shortId"> => {
  const { shortId: _, ...rest } = value;
  return rest;
};
const publicId = (ids: ReadonlyMap<string, string>, internalId: string, resource: string): string => {
  const id = ids.get(internalId);
  if (!id) throw new Error(`Missing public ID for ${resource}`);
  return id;
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const publicFieldKey = (ids: ReadonlyMap<string, string>, key: string): string | null => {
  const id = ids.get(key);
  if (id) return id;
  if (UUID_PATTERN.test(key)) return null;
  return key;
};

type PublicFieldWrite = z.infer<typeof PublicCreateFieldSchema> | z.infer<typeof PublicUpdateFieldSchema>;

const publicRelationRecordIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];

export const fromPublicFieldWrite = async <T extends PublicFieldWrite>(type: string, input: T): Promise<Result<T>> => {
  let config = input.config ?? {};
  if (type === "relation") {
    const parsed = PublicRelationConfigSchema.safeParse(config);
    if (!parsed.success) return fail(err.badInput("Invalid public relation field configuration"));
    config = parsed.data;
    if (input.defaultValue !== undefined && !PublicRelationDefaultSchema.safeParse(input.defaultValue).success) {
      return fail(err.badInput("Invalid public relation default"));
    }
  } else if (type === "lookup" || type === "rollup") {
    const schema = type === "lookup" ? PublicLookupConfigSchema : PublicRollupConfigSchema;
    const parsed = schema.safeParse(config);
    if (!parsed.success) return fail(err.badInput(`Invalid public ${type} field configuration`));
    config = parsed.data;
  }
  const tableIds = type === "relation" && typeof config.targetTableId === "string" ? [config.targetTableId] : [];
  const fieldIds =
    type === "lookup" || type === "rollup"
      ? [config.relationFieldId, config.targetFieldId].filter((id): id is string => typeof id === "string")
      : [];
  const recordIds = type === "relation" ? publicRelationRecordIds(input.defaultValue) : [];
  const [tables, fields, records] = await Promise.all([
    resolvePublicIds("table", tableIds),
    resolvePublicIds("field", fieldIds),
    resolvePublicIds("record", recordIds),
  ]);
  if (tables.size !== new Set(tableIds).size) return fail(err.badInput("Unknown relation target table"));
  if (fields.size !== new Set(fieldIds).size) return fail(err.badInput("Unknown computed field reference"));
  if (records.size !== new Set(recordIds).size) return fail(err.badInput("Unknown relation default record"));

  let internalConfig = config;
  if (type === "relation") {
    internalConfig = {
      ...config,
      ...(typeof config.targetTableId === "string" ? { targetTableId: tables.get(config.targetTableId)! } : {}),
    };
  } else if (type === "lookup" || type === "rollup") {
    internalConfig = {
      ...config,
      ...(typeof config.relationFieldId === "string" ? { relationFieldId: fields.get(config.relationFieldId)! } : {}),
      ...(typeof config.targetFieldId === "string" ? { targetFieldId: fields.get(config.targetFieldId)! } : {}),
    };
  }

  const internalDefault =
    type !== "relation" || input.defaultValue === undefined || input.defaultValue === null
      ? input.defaultValue
      : Array.isArray(input.defaultValue)
        ? input.defaultValue.map((id) => records.get(id as string)!)
        : records.get(input.defaultValue as string)!;
  return ok({
    ...input,
    ...(input.config !== undefined ? { config: internalConfig } : {}),
    ...(input.defaultValue !== undefined ? { defaultValue: internalDefault } : {}),
  });
};

export const fromPublicFederatedDraft = async (
  input: z.infer<typeof PublicFederatedDraftInputSchema>,
): Promise<Result<FederatedDraftInput>> => {
  const tableIds = [...input.sourceTableIds, ...input.mappings.map((mapping) => mapping.sourceTableId)];
  const fieldIds = input.mappings.flatMap((mapping) => [mapping.targetFieldId, mapping.sourceFieldId]);
  const [tables, fields] = await Promise.all([resolvePublicIds("table", tableIds), resolvePublicIds("field", fieldIds)]);
  if (tables.size !== new Set(tableIds).size) return fail(err.badInput("Unknown federation source table"));
  if (fields.size !== new Set(fieldIds).size) return fail(err.badInput("Unknown federation field"));
  return ok({
    sourceTableIds: input.sourceTableIds.map((id) => tables.get(id)!),
    mappings: input.mappings.map((mapping) => ({
      ...mapping,
      targetFieldId: fields.get(mapping.targetFieldId)!,
      sourceTableId: tables.get(mapping.sourceTableId)!,
      sourceFieldId: fields.get(mapping.sourceFieldId)!,
    })),
  });
};

export const toPublicFederatedDiagnostics = async (
  diagnostics: readonly FederatedDiagnostic[],
  administeredSourceTableIds?: ReadonlySet<string>,
) => {
  const visible = diagnostics.map((diagnostic) =>
    diagnostic.sourceTableId && administeredSourceTableIds && !administeredSourceTableIds.has(diagnostic.sourceTableId)
      ? {
          code: diagnostic.code,
          message: diagnostic.message,
          ...(diagnostic.targetFieldId ? { targetFieldId: diagnostic.targetFieldId } : {}),
        }
      : diagnostic,
  );
  const [tableIds, fieldIds] = await Promise.all([
    projectPublicIds(
      "table",
      visible.flatMap((diagnostic) => (diagnostic.sourceTableId ? [diagnostic.sourceTableId] : [])),
    ),
    projectPublicIds(
      "field",
      visible.flatMap((diagnostic) =>
        [diagnostic.targetFieldId, diagnostic.sourceFieldId].filter((id): id is string => typeof id === "string"),
      ),
    ),
  ]);
  return visible.map((diagnostic) =>
    PublicFederatedDiagnosticSchema.parse({
      ...diagnostic,
      ...(diagnostic.sourceTableId ? { sourceTableId: publicId(tableIds, diagnostic.sourceTableId, "federation source table") } : {}),
      ...(diagnostic.targetFieldId ? { targetFieldId: publicId(fieldIds, diagnostic.targetFieldId, "federation target field") } : {}),
      ...(diagnostic.sourceFieldId ? { sourceFieldId: publicId(fieldIds, diagnostic.sourceFieldId, "federation source field") } : {}),
    }),
  );
};

export const toPublicFederatedRevision = async (
  revision: FederatedRevision & { revisionToken: string },
  administeredSourceTableIds: ReadonlySet<string>,
): Promise<PublicFederatedRevisionView> => {
  const visibleMappings = revision.mappings.filter((mapping) => administeredSourceTableIds.has(mapping.sourceTableId));
  const [tableIds, fieldIds, diagnostics] = await Promise.all([
    projectPublicIds("table", [
      revision.tableId,
      ...revision.sources.filter((source) => administeredSourceTableIds.has(source.sourceTableId)).map((source) => source.sourceTableId),
      ...visibleMappings.map((mapping) => mapping.sourceTableId),
    ]),
    projectPublicIds(
      "field",
      visibleMappings.flatMap((mapping) => [mapping.targetFieldId, mapping.sourceFieldId]),
    ),
    toPublicFederatedDiagnostics(revision.diagnostics, administeredSourceTableIds),
  ]);
  return PublicFederatedRevisionViewSchema.parse({
    tableId: publicId(tableIds, revision.tableId, "federation table"),
    revision: revision.revision,
    status: revision.status,
    diagnostics,
    revisionToken: revision.revisionToken,
    createdBy: revision.createdBy,
    publishedBy: revision.publishedBy,
    createdAt: revision.createdAt,
    updatedAt: revision.updatedAt,
    publishedAt: revision.publishedAt,
    sources: revision.sources.map((source) => ({
      sourceTableId: administeredSourceTableIds.has(source.sourceTableId)
        ? publicId(tableIds, source.sourceTableId, "federation source table")
        : null,
      position: source.position,
      authorizedAt: source.authorizedAt,
      revokedAt: source.revokedAt,
    })),
    mappings: visibleMappings.map((mapping) => ({
      targetFieldId: publicId(fieldIds, mapping.targetFieldId, "federation target field"),
      sourceTableId: publicId(tableIds, mapping.sourceTableId, "federation source table"),
      sourceFieldId: publicId(fieldIds, mapping.sourceFieldId, "federation source field"),
      config: mapping.config,
    })),
  });
};

export const toPublicFederatedSourceCandidates = (
  page: FederatedSourceCandidatePage,
): z.infer<typeof PublicFederatedSourceCandidatePageSchema> =>
  PublicFederatedSourceCandidatePageSchema.parse({
    ...page,
    items: page.items.map((candidate) => ({
      base: { id: candidate.base.shortId, name: candidate.base.name },
      table: {
        id: candidate.table.shortId,
        baseId: candidate.base.shortId,
        name: candidate.table.name,
        description: candidate.table.description,
        icon: candidate.table.icon,
      },
      fieldCount: candidate.fieldCount,
    })),
  });

export const toPublicFederatedSourcePublications = async (publications: readonly FederatedSourcePublication[]) => {
  const fieldIds = await projectPublicIds(
    "field",
    publications.flatMap((publication) => publication.mappings.flatMap((mapping) => [mapping.sourceFieldId, mapping.targetFieldId])),
  );
  return PublicFederatedSourcePublicationListSchema.parse(
    publications.map((publication) => ({
      targetBaseId: publication.targetBaseShortId,
      targetBaseName: publication.targetBaseName,
      targetTableId: publication.targetTableShortId,
      targetTableName: publication.targetTableName,
      revision: publication.revision,
      status: publication.status,
      publishedAt: publication.publishedAt,
      revokedAt: publication.revokedAt,
      mappings: publication.mappings.map((mapping) => ({
        ...mapping,
        sourceFieldId: publicId(fieldIds, mapping.sourceFieldId, "federation source field"),
        targetFieldId: publicId(fieldIds, mapping.targetFieldId, "federation target field"),
      })),
    })),
  );
};

export const toPublicBase = (base: Base) => ({ ...omitShortId(base), id: base.shortId });
export const toPublicBases = (bases: readonly Base[]) => bases.map(toPublicBase);

export const toPublicTables = async (tables: readonly Table[]): Promise<PublicTable[]> => {
  const baseIds = await projectPublicIds(
    "base",
    tables.map((table) => table.baseId),
  );
  const projected = await Promise.all(
    tables.map(async (table) => ({
      ...omitShortId(table),
      id: table.shortId,
      baseId: publicId(baseIds, table.baseId, "base"),
      columns: await projectKnownIds(table.columns),
      displayConfig: await projectKnownIds(table.displayConfig),
      auditPolicy: await projectKnownIds(table.auditPolicy),
    })),
  );
  return projected.map((table) => PublicTableSchema.parse(table));
};
export const toPublicTable = async (table: Table) => (await toPublicTables([table]))[0]!;

type KnownIdResourceType = "table" | "field" | "record" | "view" | "form";

export const resourceTypeForKnownIdKey = (key: string): KnownIdResourceType | null => {
  if (/tableIds?$/i.test(key)) return "table";
  if (/fieldIds?$/i.test(key)) return "field";
  if (/recordIds?$/i.test(key)) return "record";
  if (/viewIds?$/i.test(key)) return "view";
  if (/formIds?$/i.test(key)) return "form";
  return null;
};

const projectKnownIds = async (value: unknown): Promise<unknown> => {
  const idsByType = new Map<"table" | "field" | "record" | "view" | "form", Set<string>>();
  const collect = (candidate: unknown, key = "") => {
    const type = resourceTypeForKnownIdKey(key);
    if (type && typeof candidate === "string") {
      const ids = idsByType.get(type) ?? new Set<string>();
      ids.add(candidate);
      idsByType.set(type, ids);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) collect(item, key.endsWith("Ids") ? key.slice(0, -1) : key);
      return;
    }
    if (candidate && typeof candidate === "object") {
      for (const [nestedKey, nested] of Object.entries(candidate)) collect(nested, nestedKey);
    }
  };
  collect(value);
  const maps = new Map<string, Map<string, string>>();
  await Promise.all([...idsByType].map(async ([type, ids]) => maps.set(type, await projectPublicIds(type, [...ids]))));
  const replace = (candidate: unknown, key = ""): unknown => {
    const type = resourceTypeForKnownIdKey(key);
    if (type && typeof candidate === "string") return publicId(maps.get(type) ?? new Map(), candidate, type);
    if (Array.isArray(candidate)) return candidate.map((item) => replace(item, key.endsWith("Ids") ? key.slice(0, -1) : key));
    if (candidate && typeof candidate === "object")
      return Object.fromEntries(Object.entries(candidate).map(([nestedKey, nested]) => [nestedKey, replace(nested, nestedKey)]));
    return candidate;
  };
  return replace(value);
};

export const toPublicFields = async (fields: readonly Field[]): Promise<PublicField[]> => {
  const relationFields = fields.filter((field) => field.type === "relation");
  const computedFields = fields.filter((field) => field.type === "lookup" || field.type === "rollup");
  const [tableIds, relationTargetTableIds, computedFieldIds, relationDefaultRecordIds, numberSeries] = await Promise.all([
    projectPublicIds(
      "table",
      fields.map((field) => field.tableId),
    ),
    projectPublicIds(
      "table",
      relationFields.flatMap((field) => (typeof field.config.targetTableId === "string" ? [field.config.targetTableId] : [])),
    ),
    projectPublicIds(
      "field",
      computedFields.flatMap((field) =>
        [field.config.relationFieldId, field.config.targetFieldId].filter((id): id is string => typeof id === "string"),
      ),
    ),
    projectPublicIds(
      "record",
      relationFields.flatMap((field) => publicRelationRecordIds(field.defaultValue)),
    ),
    loadFieldNumberSeries(fields.filter((field) => field.type === "id").map((field) => field.id)),
  ]);
  const projected = fields.map((field) => {
    let config = field.config;
    if (field.type === "relation") {
      const parsed = z
        .object({ targetTableId: z.string().uuid().optional(), cardinality: z.enum(["single", "multiple"]).optional() })
        .parse(field.config);
      config = {
        ...parsed,
        ...(parsed.targetTableId ? { targetTableId: publicId(relationTargetTableIds, parsed.targetTableId, "table") } : {}),
      };
    } else if (field.type === "lookup" || field.type === "rollup") {
      const internalSchema = z.object({
        relationFieldId: z.string().uuid().optional(),
        targetFieldId: z.string().uuid().optional(),
        ...(field.type === "rollup" ? { agg: z.enum(["count", "sum", "avg", "min", "max"]).optional() } : {}),
        format: FormatSpecSchema.optional(),
      });
      const parsed = internalSchema.parse(field.config);
      config = {
        ...parsed,
        ...(parsed.relationFieldId ? { relationFieldId: publicId(computedFieldIds, parsed.relationFieldId, "field") } : {}),
        ...(parsed.targetFieldId ? { targetFieldId: publicId(computedFieldIds, parsed.targetFieldId, "field") } : {}),
      };
    }
    const defaultValue =
      field.type !== "relation" || field.defaultValue === null
        ? field.defaultValue
        : Array.isArray(field.defaultValue)
          ? field.defaultValue.map((id) => publicId(relationDefaultRecordIds, String(id), "record"))
          : publicId(relationDefaultRecordIds, String(field.defaultValue), "record");
    const fieldNumberSeries = numberSeries.get(field.id);
    if (field.type === "id" && isSequentialNumberSeriesConfig(field.config) && !fieldNumberSeries) {
      throw new Error(`Grids field ${field.id} is missing its durable number series.`);
    }
    return {
      ...omitShortId(field),
      id: field.shortId,
      tableId: publicId(tableIds, field.tableId, "table"),
      config,
      defaultValue,
      ...(field.type === "id" ? { numberSeries: fieldNumberSeries ? toPublicNumberSeries(fieldNumberSeries) : null } : {}),
    };
  });
  return projected.map((field) => PublicFieldSchema.parse(field));
};
export const toPublicField = async (field: Field) => (await toPublicFields([field]))[0]!;

export const toPublicViews = async (views: readonly View[]): Promise<PublicView[]> => {
  const groupedFieldIds = views.flatMap((view) =>
    [...(view.ui.groupedColumnOrder ?? []), ...(view.ui.hiddenGroupedColumns ?? [])]
      .map(groupedColumnFieldId)
      .filter((id): id is string => id !== null && id !== "*"),
  );
  const [tableIds, groupedFields] = await Promise.all([
    projectPublicIds(
      "table",
      views.map((view) => view.tableId),
    ),
    projectPublicIds("field", groupedFieldIds),
  ]);
  const projected = await Promise.all(
    views.map(async (view) => {
      const ui = (await projectKnownIds(view.ui)) as View["ui"];
      const resolveGroupedField = (id: string) => groupedFields.get(id) ?? null;
      const groupedColumnOrder = rewriteGroupedColumnKeys(view.ui.groupedColumnOrder, resolveGroupedField);
      if (!groupedColumnOrder.ok) throw new Error(groupedColumnOrder.error.message);
      const hiddenGroupedColumns = rewriteGroupedColumnKeys(view.ui.hiddenGroupedColumns, resolveGroupedField);
      if (!hiddenGroupedColumns.ok) throw new Error(hiddenGroupedColumns.error.message);
      return {
        ...omitShortId(view),
        id: view.shortId,
        tableId: publicId(tableIds, view.tableId, "table"),
        ui: { ...ui, groupedColumnOrder: groupedColumnOrder.data, hiddenGroupedColumns: hiddenGroupedColumns.data },
      };
    }),
  );
  return projected.map((view) => PublicViewSchema.parse(view));
};
export const toPublicView = async (view: View) => (await toPublicViews([view]))[0]!;

export const toPublicForms = async (forms: readonly Form[]): Promise<PublicForm[]> => {
  const tableIds = await projectPublicIds(
    "table",
    forms.map((form) => form.tableId),
  );
  const projected = await Promise.all(
    forms.map(async (form) => {
      const { id: _internalId, shortId, ...rest } = form;
      return {
        ...rest,
        ...(shortId ? { id: shortId } : {}),
        tableId: publicId(tableIds, form.tableId, "table"),
        config: await projectKnownIds(form.config),
      };
    }),
  );
  return projected.map((form) => PublicFormSchema.parse(form));
};
export const toPublicForm = async (form: Form) => (await toPublicForms([form]))[0]!;

export const toPublicRecords = async (records: readonly GridRecord[], fields: readonly Field[]) => {
  const tableIds = await projectPublicIds(
    "table",
    records.map((record) => record.tableId),
  );
  const fieldIds = new Map(fields.map((field) => [field.id, field.shortId]));
  const relationFieldIds = new Set(fields.filter((field) => field.type === "relation").map((field) => field.id));
  const relationRecordIds = records.flatMap((record) =>
    Object.entries(record.data).flatMap(([fieldId, value]) => {
      if (!relationFieldIds.has(fieldId)) return [];
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : typeof value === "string"
          ? [value]
          : [];
    }),
  );
  const recordIds = await projectPublicIds("record", relationRecordIds);
  return records.map((record) => {
    const { expanded: _, finalRevisionId: _finalRevisionId, finalizedAt, finalizedBy, ...withoutExpanded } = omitShortId(record);
    return {
      ...withoutExpanded,
      ...(finalizedAt ? { finalizedAt, finalizedBy: finalizedBy ?? null } : {}),
      id: record.shortId,
      tableId: publicId(tableIds, record.tableId, "table"),
      data: Object.fromEntries(
        Object.entries(record.data).flatMap(([fieldId, value]) => {
          const publicFieldId = publicFieldKey(fieldIds, fieldId);
          if (!publicFieldId) return [];
          if (!relationFieldIds.has(fieldId)) return [[publicFieldId, value]];
          if (Array.isArray(value))
            return [[publicFieldId, value.map((id) => (typeof id === "string" ? publicId(recordIds, id, "record") : id))]];
          return [[publicFieldId, typeof value === "string" ? publicId(recordIds, value, "record") : value]];
        }),
      ),
    };
  });
};
export const toPublicRecord = async (record: GridRecord, fields: readonly Field[]) => (await toPublicRecords([record], fields))[0]!;

export const toPublicFiles = async (files: readonly GridFile[]) => {
  const [recordIds, fieldIds] = await Promise.all([
    projectPublicIds(
      "record",
      files.map((file) => file.recordId),
    ),
    projectPublicIds(
      "field",
      files.map((file) => file.fieldId),
    ),
  ]);
  return files.map((file) => ({
    ...omitShortId(file),
    id: file.shortId,
    recordId: publicId(recordIds, file.recordId, "record"),
    fieldId: publicId(fieldIds, file.fieldId, "field"),
  }));
};
export const toPublicFile = async (file: GridFile) => (await toPublicFiles([file]))[0]!;

export const toPublicComment = (comment: RecordComment) => ({ ...omitShortId(comment), id: comment.shortId });
export const toPublicComments = (comments: readonly RecordComment[]) => comments.map(toPublicComment);

export const toPublicTableQueryResponse = async (
  response: z.infer<typeof TableQueryResponseSchema>,
  fields: readonly Field[],
): Promise<z.infer<typeof PublicTableQueryResponseSchema>> => {
  const fieldIds = new Map(fields.map((field) => [field.id, field.shortId]));
  const relationInternalIds = Object.keys(response.relationLabels ?? {});
  const relationIds = await projectPublicIds("record", relationInternalIds);
  const projectAggregateKeys = (values: Record<string, unknown> | undefined) =>
    values
      ? Object.fromEntries(
          Object.entries(values).map(([key, value]) => {
            const [fieldId, ...suffix] = key.split("__");
            const publicFieldId = fieldIds.get(fieldId ?? "");
            return [publicFieldId ? [publicFieldId, ...suffix].join("__") : key, value];
          }),
        )
      : undefined;
  const previews = response.filePreviews;
  const previewFiles = previews
    ? Object.values(previews).flatMap((byField) => Object.values(byField).map((preview) => preview.fileId))
    : [];
  const [previewRecordIds, previewFieldIds, previewFileIds] = await Promise.all([
    projectPublicIds("record", Object.keys(previews ?? {})),
    projectPublicIds("field", previews ? Object.values(previews).flatMap((byField) => Object.keys(byField)) : []),
    projectPublicIds("file", previewFiles),
  ]);
  return {
    ...response,
    ...(response.items ? { items: await toPublicRecords(response.items, fields) } : {}),
    ...(response.aggregates ? { aggregates: projectAggregateKeys(response.aggregates) } : {}),
    ...(response.buckets
      ? {
          buckets: response.buckets.map((bucket) => ({
            keys: bucket.keys.map((key) => {
              if (typeof key !== "string") return key;
              const projected = relationIds.get(key);
              if (projected) return projected;
              if (UUID_PATTERN.test(key)) throw new Error("Missing public ID for grouped record");
              return key;
            }),
            values: projectAggregateKeys(bucket.values) ?? {},
          })),
        }
      : {}),
    ...(response.relationLabels
      ? {
          relationLabels: Object.fromEntries(
            Object.entries(response.relationLabels).map(([id, label]) => [publicId(relationIds, id, "record"), label]),
          ),
        }
      : {}),
    ...(previews
      ? {
          filePreviews: Object.fromEntries(
            Object.entries(previews).map(([recordId, byField]) => [
              publicId(previewRecordIds, recordId, "record"),
              Object.fromEntries(
                Object.entries(byField).map(([fieldId, preview]) => [
                  publicId(previewFieldIds, fieldId, "field"),
                  {
                    ...preview,
                    fileId: publicId(previewFileIds, preview.fileId, "file"),
                    fieldId: publicId(previewFieldIds, preview.fieldId, "field"),
                    recordId: publicId(previewRecordIds, preview.recordId, "record"),
                  },
                ]),
              ),
            ]),
          ),
        }
      : {}),
  };
};
