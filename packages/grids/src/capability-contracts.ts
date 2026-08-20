import { CapabilitySemanticLinkSchema } from "@valentinkolb/cloud/contracts";
import { z } from "zod";
import { ShortIdSchema } from "./contracts";

const TimestampSchema = z.string().datetime({ offset: true });
const CursorSchema = z.string().min(1).max(16_384).optional().describe("Opaque cursor returned by the previous page.");
const PageLimitSchema = z.number().int().min(1).max(100).default(25).describe("Maximum number of items to return.");
const ResourceLinksSchema = z.array(CapabilitySemanticLinkSchema).min(1).max(10).optional();

export const BaseCapabilityDataSchema = z
  .object({
    id: ShortIdSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(1_000).nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    links: ResourceLinksSchema,
  })
  .strict();

export const BaseListDataSchema = z.array(BaseCapabilityDataSchema).max(100);

export const BaseListInputSchema = z
  .object({
    query: z.string().trim().max(500).optional().describe("Optional Base name, description, or short-ID search."),
    cursor: CursorSchema,
    limit: PageLimitSchema,
  })
  .strict();

export const BaseReadInputSchema = z.object({ id: ShortIdSchema.describe("Stable public Base ID.") }).strict();

const ContextKindSchema = z.enum(["tables", "views", "fields", "options"]);
const GridsPermissionSchema = z.enum(["read", "write", "admin"]);

export const TableCapabilityDataSchema = z
  .object({
    kind: z.literal("table"),
    id: ShortIdSchema,
    baseId: ShortIdSchema,
    tableKind: z.enum(["stored", "federated"]),
    name: z.string().min(1).max(200),
    description: z.string().max(1_000).nullable(),
    icon: z.string().max(200).nullable(),
    permission: GridsPermissionSchema,
    canCreateRecords: z.boolean(),
    canUpdateRecords: z.boolean(),
    links: ResourceLinksSchema,
  })
  .strict();

export const ViewCapabilityDataSchema = z
  .object({
    kind: z.literal("view"),
    id: ShortIdSchema,
    tableId: ShortIdSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(2_000).nullable(),
    icon: z.string().max(200).nullable(),
    links: ResourceLinksSchema,
  })
  .strict();

const FieldContextItemSchema = z
  .object({
    kind: z.literal("field"),
    id: ShortIdSchema,
    tableId: ShortIdSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(2_000).nullable(),
    type: z.string().min(1).max(100),
    position: z.number().int(),
    required: z.boolean(),
    writable: z.boolean(),
    valueHint: z.string().min(1).max(500).nullable(),
    targetTableId: ShortIdSchema.nullable(),
    relationCardinality: z.enum(["single", "multiple"]).nullable(),
  })
  .strict();

const OptionContextItemSchema = z
  .object({
    kind: z.literal("option"),
    id: z.string().min(1).max(10_000),
    fieldId: ShortIdSchema,
    label: z.string().min(1).max(500),
    description: z.string().max(1_000).nullable(),
  })
  .strict();

// Audit question and option IDs are config-local keys, not public resource identities.
// Actor IDs below are foreign Cloud identities. Neither is resolved as a Grids resource.
const AuditOptionSchema = z.object({ id: z.uuid(), label: z.string().min(1).max(200) }).strict();
const AuditQuestionBaseSchema = z.object({
  id: z.uuid(),
  label: z.string().min(1).max(200),
  description: z.string().max(1_000).nullable(),
  required: z.boolean(),
});
const AuditQuestionSchema = z.discriminatedUnion("type", [
  AuditQuestionBaseSchema.extend({ type: z.literal("text") }).strict(),
  AuditQuestionBaseSchema.extend({ type: z.literal("longtext") }).strict(),
  AuditQuestionBaseSchema.extend({ type: z.literal("select"), options: z.array(AuditOptionSchema).max(100) }).strict(),
]);
const RecordWriteContextSchema = z
  .object({
    tableId: ShortIdSchema,
    canCreateRecords: z.boolean(),
    canUpdateRecords: z.boolean(),
    updateAudit: z
      .object({
        scope: z.enum(["all", "selected"]),
        fieldIds: z.array(ShortIdSchema).max(200),
        questions: z.array(AuditQuestionSchema).max(20),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const GqlContextItemSchema = z.discriminatedUnion("kind", [
  TableCapabilityDataSchema,
  ViewCapabilityDataSchema,
  FieldContextItemSchema,
  OptionContextItemSchema,
]);

export const GqlContextDataSchema = z
  .object({
    base: BaseCapabilityDataSchema,
    kind: ContextKindSchema,
    items: z.array(GqlContextItemSchema).max(100),
    recordWrite: RecordWriteContextSchema.nullable(),
  })
  .strict();

export const GqlContextInputSchema = z
  .object({
    baseId: ShortIdSchema.describe("Public Base ID whose permission-shaped GQL context should be loaded."),
    kind: ContextKindSchema.default("tables").describe("Catalog section: tables, views, fields, or exact select option IDs."),
    tableId: ShortIdSchema.optional().describe("Public Table ID; required for fields and options, optional for views."),
    fieldId: ShortIdSchema.optional().describe("Public Select Field ID; required when kind is options."),
    cursor: CursorSchema,
    limit: PageLimitSchema,
  })
  .strict();

const CurrentSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("table").describe("Select a Table as the current source."),
      tableId: ShortIdSchema.describe("Public current Table ID."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("view").describe("Select a View as the current source."),
      viewId: ShortIdSchema.describe("Public current View ID."),
    })
    .strict(),
]);

const GqlInputShape = {
  baseId: ShortIdSchema.describe("Public Base ID in which the GQL source is resolved."),
  query: z.string().trim().min(1).max(20_000).describe("Grids Query Language source to execute."),
  currentTableId: ShortIdSchema.optional().describe("Optional public Table ID used when the source omits an explicit from clause."),
  currentSource: CurrentSourceSchema.optional().describe("Optional current Table or View source used when GQL omits from."),
  cursor: CursorSchema,
};

export const GqlPreviewInputSchema = z
  .object({
    ...GqlInputShape,
    pageSize: z.number().int().min(1).max(25).default(25).describe("Maximum preview rows to return."),
  })
  .strict();

export const GqlExecuteInputSchema = z
  .object({
    ...GqlInputShape,
    pageSize: z.number().int().min(1).max(100).default(100).describe("Maximum rows to return on this cursor page."),
    limit: z.number().int().min(1).max(1_000).optional().describe("Optional logical result cap across cursor pages."),
  })
  .strict();

export const GqlViewExecuteInputSchema = z
  .object({
    baseId: ShortIdSchema.describe("Public Base ID containing the saved View."),
    viewId: ShortIdSchema.describe("Public saved View ID whose exact stored GQL should execute."),
    pageSize: z.number().int().min(1).max(100).default(100).describe("Maximum rows to return on this cursor page."),
    cursor: CursorSchema,
  })
  .strict();

const GqlDiagnosticSchema = z
  .object({
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    length: z.number().int().positive().optional(),
    message: z.string().min(1).max(2_000),
  })
  .strict();

const GqlColumnSchema = z
  .object({
    key: z.string().min(1).max(500),
    label: z.string().max(500),
    tableId: ShortIdSchema.optional(),
    fieldId: ShortIdSchema.optional(),
    joinAlias: z.string().max(500).optional(),
    type: z.string().max(100),
    sqlType: z.string().max(100),
    aggregate: z.string().max(100).optional(),
  })
  .strict();

const RecordMetaSchema = z
  .object({
    version: z.number().int().positive(),
    finalizedAt: TimestampSchema.nullable(),
    finalizedBy: z.uuid().nullable(),
    deletedAt: TimestampSchema.nullable(),
    createdBy: z.uuid().nullable(),
    updatedBy: z.uuid().nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

const GqlSuccessSchema = z
  .object({
    ok: z.literal(true),
    mode: z.enum(["rows", "groups"]),
    columns: z.array(GqlColumnSchema).max(100),
    rows: z
      .array(
        z
          .object({
            recordId: ShortIdSchema.optional(),
            tableId: ShortIdSchema.optional(),
            recordMeta: RecordMetaSchema.optional(),
            values: z.record(z.string(), z.unknown()),
            links: ResourceLinksSchema,
          })
          .strict(),
      )
      .max(100),
    limit: z.number().int().min(1).max(1_000),
    truncated: z.boolean().optional(),
    explode: z.boolean().optional(),
  })
  .strict();

const GqlFailureSchema = z
  .object({
    ok: z.literal(false),
    diagnostics: z.array(GqlDiagnosticSchema).min(1).max(100),
  })
  .strict();

export const GqlResultDataSchema = z.discriminatedUnion("ok", [GqlSuccessSchema, GqlFailureSchema]);

export const RecordCapabilityDataSchema = z
  .object({
    id: ShortIdSchema,
    tableId: ShortIdSchema,
    version: z.number().int().positive(),
    finalizedAt: TimestampSchema.nullable().optional(),
    finalizedBy: z.uuid().nullable().optional(),
    deletedAt: TimestampSchema.nullable(),
    createdBy: z.uuid().nullable(),
    updatedBy: z.uuid().nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const TableReadInputSchema = z.object({ id: ShortIdSchema.describe("Stable public Table ID.") }).strict();
export const ViewReadInputSchema = z.object({ id: ShortIdSchema.describe("Stable public View ID.") }).strict();
export const RecordReadInputSchema = z.object({ id: ShortIdSchema.describe("Stable public live Record ID.") }).strict();

const RecordValuesSchema = z.record(ShortIdSchema, z.unknown());
const RecordAuditSchema = z
  .object({
    answers: z.record(z.string().uuid(), z.string().max(10_000)).default({}).describe("Audit question UUIDs mapped to their answers."),
  })
  .strict();

export const RecordCreateInputSchema = z
  .object({
    tableId: ShortIdSchema.describe("Public ID of the writable stored Table that should receive the record."),
    values: RecordValuesSchema.describe("Public Field IDs mapped to explicitly supplied values."),
  })
  .strict();

export const RecordUpdateInputSchema = z
  .object({
    tableId: ShortIdSchema.describe("Public ID of the writable stored Table containing the record."),
    recordId: ShortIdSchema.describe("Stable public live Record ID to update."),
    values: RecordValuesSchema.describe("Public Field IDs mapped to explicitly supplied replacement values."),
    ifVersion: z.number().int().positive().describe("Record version returned by record.read; stale versions are rejected."),
    audit: RecordAuditSchema.optional().describe("Answers required by the Table audit policy, when configured."),
  })
  .strict();
