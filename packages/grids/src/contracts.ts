import { z } from "zod";
import { AGGREGATE_KINDS } from "./aggregate-catalog";

/**
 * Public ID for Grids resources: 6-character base62 alphanumeric.
 * Mirrors the DB CHECK constraint (`short_id ~ '^[A-Za-z0-9]{6}$'`) so the
 * contract layer and the storage layer cannot disagree. Service mappers
 * read `row.short_id` directly; if a row lacks the column the throw bubbles
 * up rather than getting silently coerced to "" (we hit that bug once).
 */
export const ShortIdSchema = z.string().regex(/^[A-Za-z0-9]{6}$/);
const IconNameSchema = z.string().max(200).nullable().optional();

export const DocumentDefaultsSchema = z
  .object({
    legalName: z.string().max(200).optional(),
    senderLine: z.string().max(500).optional(),
    address: z.string().max(1_000).optional(),
    department: z.string().max(200).optional(),
    contactEmail: z.string().max(320).optional(),
    phone: z.string().max(100).optional(),
    url: z.string().max(500).optional(),
    taxId: z.string().max(100).optional(),
    registration: z.string().max(300).optional(),
    bankName: z.string().max(200).optional(),
    iban: z.string().max(100).optional(),
    bic: z.string().max(100).optional(),
    paymentTerms: z.string().max(500).optional(),
    footerText: z.string().max(1_000).optional(),
  })
  .strict()
  .default({});
export type DocumentDefaults = z.infer<typeof DocumentDefaultsSchema>;

// ── Record display ────────────────────────────────────────────────────────
//
// Presentation-only settings for records surfaces. Kept deliberately
// separate from RecordQuery: filters, sort, grouping, search and aggregations
// remain the SQL source of truth; this only decides how the returned records
// are rendered.
const RecordDisplayModeSchema = z.enum(["table", "cards", "calendar"]);
export type RecordDisplayMode = z.infer<typeof RecordDisplayModeSchema>;

export const RecordDisplayConfigSchema = z
  .object({
    mode: RecordDisplayModeSchema.default("table"),
    cards: z
      .object({
        imageFieldId: z.string().uuid().nullable().optional(),
        fieldIds: z.array(z.string().uuid()).max(50).optional(),
      })
      .optional(),
    calendar: z
      .object({
        dateFieldId: z.string().uuid().nullable().optional(),
      })
      .optional(),
  })
  .default({ mode: "table" });
export type RecordDisplayConfig = z.infer<typeof RecordDisplayConfigSchema>;

// ── Record audit requirements ─────────────────────────────────────────────
//
// Audit questions are intentionally smaller than normal Grids fields. They
// describe immutable operation metadata, not values that belong to a record.
const AuditQuestionBaseSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1_000).optional(),
  required: z.boolean().default(false),
});

export const AuditQuestionSchema = z.discriminatedUnion("type", [
  AuditQuestionBaseSchema.extend({ type: z.literal("text") }).strict(),
  AuditQuestionBaseSchema.extend({ type: z.literal("longtext") }).strict(),
  AuditQuestionBaseSchema.extend({
    type: z.literal("select"),
    options: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            label: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  }).strict(),
]);
export type AuditQuestion = z.infer<typeof AuditQuestionSchema>;

const uniqueNormalizedValues = (values: string[]): boolean => {
  const normalized = values.map((value) => value.trim().toLowerCase());
  return new Set(normalized).size === normalized.length;
};

const AuditQuestionsSchema = z
  .array(AuditQuestionSchema)
  .max(20)
  .superRefine((questions, ctx) => {
    if (new Set(questions.map((question) => question.id)).size !== questions.length) {
      ctx.addIssue({ code: "custom", message: "Audit question IDs must be unique" });
    }
    if (!uniqueNormalizedValues(questions.map((question) => question.label))) {
      ctx.addIssue({ code: "custom", message: "Audit question labels must be unique" });
    }
    questions.forEach((question, questionIndex) => {
      if (question.type !== "select") return;
      if (new Set(question.options.map((option) => option.id)).size !== question.options.length) {
        ctx.addIssue({
          code: "custom",
          path: [questionIndex, "options"],
          message: "Select option IDs must be unique",
        });
      }
      if (!uniqueNormalizedValues(question.options.map((option) => option.label))) {
        ctx.addIssue({
          code: "custom",
          path: [questionIndex, "options"],
          message: "Select option labels must be unique",
        });
      }
    });
  })
  .default([]);

const AuditRequirementSchema = z
  .object({
    enabled: z.boolean().default(false),
    questions: AuditQuestionsSchema,
  })
  .strict()
  .superRefine((requirement, ctx) => {
    if (requirement.enabled && requirement.questions.length === 0) {
      ctx.addIssue({ code: "custom", path: ["questions"], message: "Enabled audit requirements need at least one question" });
    }
  });
export type AuditRequirement = z.infer<typeof AuditRequirementSchema>;

const AuditUpdateRequirementSchema = z
  .object({
    enabled: z.boolean().default(false),
    questions: AuditQuestionsSchema,
    scope: z.enum(["all", "selected"]).default("all"),
    fieldIds: z.array(z.string().uuid()).max(200).default([]),
  })
  .strict()
  .superRefine((requirement, ctx) => {
    if (requirement.enabled && requirement.questions.length === 0) {
      ctx.addIssue({ code: "custom", path: ["questions"], message: "Enabled audit requirements need at least one question" });
    }
    if (requirement.enabled && requirement.scope === "selected" && requirement.fieldIds.length === 0) {
      ctx.addIssue({ code: "custom", path: ["fieldIds"], message: "Select at least one field" });
    }
    if (new Set(requirement.fieldIds).size !== requirement.fieldIds.length) {
      ctx.addIssue({ code: "custom", path: ["fieldIds"], message: "Selected field IDs must be unique" });
    }
  });
export type AuditUpdateRequirement = z.infer<typeof AuditUpdateRequirementSchema>;

export const TableAuditPolicySchema = z
  .object({
    delete: AuditRequirementSchema.optional(),
    restore: AuditRequirementSchema.optional(),
    update: AuditUpdateRequirementSchema.optional(),
  })
  .strict()
  .default({});
export type TableAuditPolicy = z.infer<typeof TableAuditPolicySchema>;

export const MutationSourceSchema = z.enum(["direct", "form", "workflow"]);
export type MutationSource = z.infer<typeof MutationSourceSchema>;

export const TableMutationPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z
    .object({ mode: z.literal("selected"), sources: z.array(MutationSourceSchema).max(3) })
    .strict()
    .superRefine((policy, ctx) => {
      if (new Set(policy.sources).size !== policy.sources.length) {
        ctx.addIssue({ code: "custom", path: ["sources"], message: "Mutation sources must be unique" });
      }
    }),
]);
export type TableMutationPolicy = z.infer<typeof TableMutationPolicySchema>;

export const RecordMutationAuditSchema = z
  .object({
    answers: z.record(z.string().uuid(), z.string().max(10_000)).default({}),
  })
  .strict();
export type RecordMutationAudit = z.infer<typeof RecordMutationAuditSchema>;

export const RecordAuditContextSchema = z
  .object({
    version: z.literal(1),
    operation: z.enum(["delete", "restore", "update"]),
    questions: z.array(AuditQuestionSchema),
    answers: z.array(
      z
        .object({
          questionId: z.string().uuid(),
          label: z.string(),
          type: z.enum(["text", "longtext", "select"]),
          required: z.boolean(),
          value: z.string(),
          optionLabel: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type RecordAuditContext = z.infer<typeof RecordAuditContextSchema>;

// ── Base ──────────────────────────────────────────────────────────────────
export const BaseSchema = z.object({
  id: z.string().uuid(),
  shortId: ShortIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  documentDefaults: DocumentDefaultsSchema,
  createdBy: z.string().uuid().nullable(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Base = z.infer<typeof BaseSchema>;

export const CreateBaseSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(1000).nullable().optional(),
    documentDefaults: DocumentDefaultsSchema.optional(),
  })
  .strict();

export const UpdateBaseSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).nullable().optional(),
    documentDefaults: DocumentDefaultsSchema.optional(),
  })
  .strict();

// ── Table ─────────────────────────────────────────────────────────────────
export const TableKindSchema = z.enum(["stored", "federated"]);
export type TableKind = z.infer<typeof TableKindSchema>;

export const TableSchema = z.object({
  id: z.string().uuid(),
  shortId: ShortIdSchema,
  baseId: z.string().uuid(),
  kind: TableKindSchema,
  name: z.string(),
  description: z.string().nullable(),
  icon: IconNameSchema,
  columns: z.array(z.lazy(() => FieldColumnSpecSchema)),
  displayConfig: RecordDisplayConfigSchema,
  auditPolicy: TableAuditPolicySchema,
  mutationPolicy: TableMutationPolicySchema,
  position: z.number().int(),
  disableDirectInsert: z.boolean(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Table = z.infer<typeof TableSchema>;

export const CreateTableSchema = z.object({
  name: z.string().min(1).max(200),
  kind: TableKindSchema.optional(),
  description: z.string().max(1000).nullable().optional(),
  icon: IconNameSchema,
  columns: z.array(z.lazy(() => FieldColumnSpecSchema)).optional(),
  displayConfig: RecordDisplayConfigSchema.optional(),
});

export const UpdateTableSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  icon: IconNameSchema,
  columns: z.array(z.lazy(() => FieldColumnSpecSchema)).optional(),
  displayConfig: RecordDisplayConfigSchema.optional(),
  auditPolicy: TableAuditPolicySchema.optional(),
  disableDirectInsert: z.boolean().optional(),
});

// ── Federated table configuration ─────────────────────────────────────────
export const FederatedRevisionStatusSchema = z.enum(["draft", "active", "degraded", "superseded"]);
export type FederatedRevisionStatus = z.infer<typeof FederatedRevisionStatusSchema>;

export const FederatedDiagnosticSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(1000),
  sourceTableId: z.string().uuid().optional(),
  targetFieldId: z.string().uuid().optional(),
  sourceFieldId: z.string().uuid().optional(),
});
export type FederatedDiagnostic = z.infer<typeof FederatedDiagnosticSchema>;

export const FederatedSourceSchema = z.object({
  id: z.string().uuid(),
  revisionId: z.string().uuid(),
  sourceTableId: z.string().uuid(),
  position: z.number().int().nonnegative(),
  authorizedBy: z.string().uuid().nullable(),
  authorizedAt: z.string().datetime().nullable(),
  revokedBy: z.string().uuid().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export type FederatedSource = z.infer<typeof FederatedSourceSchema>;

export const FederatedFieldMappingSchema = z.object({
  revisionId: z.string().uuid(),
  targetFieldId: z.string().uuid(),
  sourceTableId: z.string().uuid(),
  sourceFieldId: z.string().uuid(),
  config: z.record(z.string(), z.unknown()),
});
export type FederatedFieldMapping = z.infer<typeof FederatedFieldMappingSchema>;

export const FederatedRevisionSchema = z.object({
  id: z.string().uuid(),
  tableId: z.string().uuid(),
  revision: z.number().int().positive(),
  status: FederatedRevisionStatusSchema,
  diagnostics: z.array(FederatedDiagnosticSchema),
  createdBy: z.string().uuid().nullable(),
  publishedBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
  sources: z.array(FederatedSourceSchema),
  mappings: z.array(FederatedFieldMappingSchema),
});
export type FederatedRevision = z.infer<typeof FederatedRevisionSchema>;

export const FederatedMappingWriteSchema = z.object({
  targetFieldId: z.string().uuid(),
  sourceTableId: z.string().uuid(),
  sourceFieldId: z.string().uuid(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const FederatedDraftInputSchema = z.object({
  sourceTableIds: z.array(z.string().uuid()).max(50),
  retainedSourceIds: z.array(z.string().uuid()).max(50).optional(),
  mappings: z.array(FederatedMappingWriteSchema).max(10_000),
});
export type FederatedDraftInput = z.infer<typeof FederatedDraftInputSchema>;

export const UpdateFederatedDraftSchema = FederatedDraftInputSchema.extend({
  draftToken: z.string().min(1),
});
export type UpdateFederatedDraftInput = z.infer<typeof UpdateFederatedDraftSchema>;

export const ValidateFederatedDraftSchema = FederatedDraftInputSchema;

export const FederatedSourceViewSchema = z.object({
  id: z.string().uuid(),
  sourceTableId: z.string().uuid().nullable(),
  position: z.number().int().nonnegative(),
  authorizedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});

export const FederatedFieldMappingViewSchema = FederatedFieldMappingSchema.omit({ revisionId: true });

export const FederatedRevisionViewSchema = FederatedRevisionSchema.omit({ sources: true, mappings: true }).extend({
  revisionToken: z.string().min(1),
  sources: z.array(FederatedSourceViewSchema),
  mappings: z.array(FederatedFieldMappingViewSchema),
});
export type FederatedRevisionView = z.infer<typeof FederatedRevisionViewSchema>;

export const FederatedTableConfigSchema = z.object({
  current: FederatedRevisionViewSchema.nullable(),
  draft: FederatedRevisionViewSchema,
});
export type FederatedTableConfig = z.infer<typeof FederatedTableConfigSchema>;

export const FederatedSourceCandidateSchema = z.object({
  base: BaseSchema.pick({ id: true, shortId: true, name: true }),
  table: TableSchema.pick({ id: true, shortId: true, baseId: true, name: true, description: true, icon: true }),
  fieldCount: z.number().int().nonnegative(),
});
export type FederatedSourceCandidate = z.infer<typeof FederatedSourceCandidateSchema>;
export const FederatedSourceCandidateQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const FederatedSourceCandidatePageSchema = z.object({
  items: z.array(FederatedSourceCandidateSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().min(1),
  offset: z.number().int().nonnegative(),
});
export type FederatedSourceCandidatePage = z.infer<typeof FederatedSourceCandidatePageSchema>;

export const FederatedValidationSchema = z.object({
  valid: z.boolean(),
  diagnostics: z.array(FederatedDiagnosticSchema),
});
export type FederatedValidation = z.infer<typeof FederatedValidationSchema>;

export const FederatedSourcePublicationSchema = z.object({
  targetBaseId: z.string().uuid(),
  targetBaseShortId: ShortIdSchema,
  targetBaseName: z.string(),
  targetTableId: z.string().uuid(),
  targetTableShortId: ShortIdSchema,
  targetTableName: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(["active", "degraded"]),
  publishedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  mappings: z.array(
    z.object({
      sourceFieldId: z.string().uuid(),
      sourceFieldName: z.string(),
      targetFieldId: z.string().uuid(),
      targetFieldName: z.string(),
      targetFieldType: z.string(),
    }),
  ),
});
export type FederatedSourcePublication = z.infer<typeof FederatedSourcePublicationSchema>;
export const FederatedSourcePublicationListSchema = z.array(FederatedSourcePublicationSchema);

// ── Field ─────────────────────────────────────────────────────────────────
export const FieldSchema = z.object({
  id: z.string().uuid(),
  shortId: ShortIdSchema,
  tableId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().max(200).nullable().optional(),
  type: z.string(),
  config: z.record(z.string(), z.unknown()),
  position: z.number().int(),
  required: z.boolean(),
  presentable: z.boolean(),
  hideInTable: z.boolean(),
  defaultValue: z.unknown().nullable(),
  indexed: z.boolean(),
  uniqueConstraint: z.boolean(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Field = z.infer<typeof FieldSchema>;

export const CreateFieldSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(200).nullable().optional(),
  type: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  position: z.number().int().optional(),
  required: z.boolean().optional(),
  presentable: z.boolean().optional(),
  hideInTable: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  indexed: z.boolean().optional(),
  uniqueConstraint: z.boolean().optional(),
});

export const UpdateFieldSchema = z.object({
  name: z.string().min(1).max(200).optional(),
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
});

/** Reorder payload — list of field ids in the new desired order. */
export const ReorderFieldsSchema = z.object({
  fieldIds: z.array(z.string().uuid()).min(1),
});

// ── Record ────────────────────────────────────────────────────────────────
export const GridRecordSchema = z.object({
  id: z.string().uuid(),
  shortId: ShortIdSchema,
  tableId: z.string().uuid(),
  data: z.record(z.string(), z.unknown()),
  expanded: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  version: z.number().int(),
  finalizedAt: z.string().datetime().nullable().optional(),
  finalizedBy: z.string().uuid().nullable().optional(),
  finalRevisionId: z.string().uuid().nullable().optional(),
  deletedAt: z.string().datetime().nullable(),
  createdBy: z.string().uuid().nullable(),
  updatedBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type GridRecord = z.infer<typeof GridRecordSchema>;

export const RecordPayloadSchema = z.record(z.string(), z.unknown());

export const RecordUpdateBodySchema = z
  .object({
    values: RecordPayloadSchema,
    audit: RecordMutationAuditSchema.optional(),
  })
  .strict();

export const RecordOperationBodySchema = z
  .object({
    audit: RecordMutationAuditSchema.optional(),
  })
  .strict();

const FilterLeafSchema = z.object({
  fieldId: z.string(),
  op: z.string(),
  value: z.unknown().optional(),
  caseInsensitive: z.boolean().optional(),
});

export type FilterTree = z.infer<typeof FilterLeafSchema> | { op: "AND" | "OR"; filters: FilterTree[] };

export const MAX_FILTER_DEPTH = 20;
export const MAX_FILTER_NODES = 200;
export const MAX_FILTER_GROUP_ITEMS = 100;
export const MAX_QUERY_SORTS = 16;
export const MAX_QUERY_AGGREGATIONS = 32;
export const MAX_QUERY_COLUMNS = 100;

const filterTreeWithinBounds = (value: unknown): boolean => {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_FILTER_NODES || current.depth > MAX_FILTER_DEPTH) return false;
    if (!current.value || typeof current.value !== "object" || Array.isArray(current.value)) continue;
    const filters = (current.value as { filters?: unknown }).filters;
    if (!Array.isArray(filters)) continue;
    if (filters.length > MAX_FILTER_GROUP_ITEMS) return false;
    for (const child of filters) stack.push({ value: child, depth: current.depth + 1 });
  }
  return true;
};

const RecursiveFilterTreeSchema: z.ZodType<FilterTree, FilterTree> = z.lazy(() =>
  z.union([
    FilterLeafSchema,
    z.object({
      op: z.enum(["AND", "OR"]),
      filters: z.array(RecursiveFilterTreeSchema).max(MAX_FILTER_GROUP_ITEMS),
    }),
  ]),
);

const FilterTreeSchema = z
  .custom<FilterTree>(filterTreeWithinBounds, "filter is too large or deeply nested")
  .pipe(RecursiveFilterTreeSchema) as z.ZodType<FilterTree>;

const RecordMetaSortKeySchema = z.enum(["createdAt", "updatedAt", "deletedAt"]);
export type RecordMetaSortKey = z.infer<typeof RecordMetaSortKeySchema>;

const FieldSortSpecSchema = z.object({
  source: z.literal("field").optional(),
  fieldId: z.string(),
  direction: z.enum(["asc", "desc"]),
  nullsFirst: z.boolean().optional(),
});

const RecordSortSpecSchema = z.object({
  source: z.literal("record"),
  key: RecordMetaSortKeySchema,
  direction: z.enum(["asc", "desc"]),
  nullsFirst: z.boolean().optional(),
});

const SortSpecSchema = z.union([RecordSortSpecSchema, FieldSortSpecSchema]);
export type SortSpec = z.infer<typeof SortSpecSchema>;

// ── Unified /tables/:id/query endpoint ────────────────────────────────────
// The canonical "ask this table for data" endpoint. Body carries a
// RecordQuery (filter/sort/columns/limit/groupBy/aggregations from the
// canonical type defined below); response is a discriminated envelope
// whose populated fields depend on what the query asked for:
//
//   groupBy non-empty                        → { buckets, nextCursor, explode }
//   groupBy empty + aggregations non-empty   → { items, aggregates, nextCursor }
//   groupBy empty + aggregations empty       → { items, nextCursor }
//
// Record writes and exports keep their dedicated endpoints; table reads
// go through this query endpoint.

// ── RecordQuery (canonical "how to query this table") ───────────────────────
// One shape, used by views (saved presets), records list, export, and
// grouped/aggregate reads. This is the contract-level source of truth
// for queryable table state.

/**
 * Per-column display override. `kind` distinguishes format families
 * (date / decimal / percent / barcode). Renderer is lenient:
 * if the format kind doesn't match the field's actual type, it's a
 * no-op (a `percent` format on a text field renders as plain text).
 */
export const FormatSpecSchema: z.ZodType<
  | { kind: "date"; format: "iso" | "short" | "long" | "relative"; includeTime?: boolean }
  | { kind: "decimal"; precision?: number; thousandsSeparator?: boolean }
  | { kind: "percent"; precision?: number }
  | { kind: "progress"; label?: "value" | "percent" | "none" }
  | { kind: "barcode"; bcid: string; showText?: boolean }
> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("date"),
    format: z.enum(["iso", "short", "long", "relative"]),
    includeTime: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("decimal"),
    precision: z.number().int().min(0).max(10).optional(),
    thousandsSeparator: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("percent"),
    precision: z.number().int().min(0).max(10).optional(),
  }),
  z.object({
    kind: z.literal("progress"),
    label: z.enum(["value", "percent", "none"]).optional(),
  }),
  z.object({
    kind: z.literal("barcode"),
    bcid: z
      .string()
      .regex(/^[a-z0-9]+$/)
      .min(1)
      .max(80),
    showText: z.boolean().optional(),
  }),
]);
export type FormatSpec = z.infer<typeof FormatSpecSchema>;

/**
 * One rendered column in a view. v3 has a single shape — just a
 * fieldId with optional format. The previous `kind: "field"` /
 * `kind: "join"` discriminator was speculative: only `field` was ever
 * implemented and `join` was silently skipped by the renderer.
 * Cross-table data is served by lookup/rollup field types, which compile
 * their relation traversal to SQL joins.
 */
export const FieldColumnSpecSchema = z.object({
  fieldId: z.string().uuid(),
  /** Optional per-view header label. Empty labels are not persisted by
   *  the UI; the renderer falls back to the field name. */
  label: z.string().trim().min(1).max(120).optional(),
  format: FormatSpecSchema.optional(),
});
export type FieldColumnSpec = z.infer<typeof FieldColumnSpecSchema>;

const ComputedColumnSpecSchema = z.object({
  kind: z.literal("computed"),
  id: z.string().regex(/^computed_[A-Za-z0-9]{5,32}$/),
  label: z.string().trim().min(1).max(120),
  expression: z.string().trim().min(1).max(5000),
  format: FormatSpecSchema.optional(),
});
export type ComputedColumnSpec = z.infer<typeof ComputedColumnSpecSchema>;

export const ColumnSpecSchema = z.union([FieldColumnSpecSchema, ComputedColumnSpecSchema]);
export type ColumnSpec = z.infer<typeof ColumnSpecSchema>;

/**
 * Group-by dimension. Stored in RecordQuery so saved views, URL state,
 * Grids App charts and exports use the same query contract.
 */
const GroupBySpecSchema = z.object({
  fieldId: z.string().uuid(),
  label: z.string().trim().min(1).max(120).optional(),
  format: FormatSpecSchema.optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  nullsFirst: z.boolean().optional(),
  /** date-field grouping bucket. Backend uses `date_trunc(<granularity>, …)`. */
  granularity: z.enum(["day", "week", "month", "quarter", "year"]).optional(),
});
export type GroupBySpec = z.infer<typeof GroupBySpecSchema>;

const AggregateKindSchema = z.enum(AGGREGATE_KINDS);

const AggregationSpecSchema = z.object({
  /** "*" is shorthand for COUNT(*) — count of records in the group. */
  fieldId: z.union([z.string().uuid(), z.literal("*")]),
  agg: AggregateKindSchema,
  label: z.string().optional(),
  format: FormatSpecSchema.optional(),
});
export type AggregationSpec = z.infer<typeof AggregationSpecSchema>;

const GroupSortSpecSchema = z.object({
  fieldId: z.union([z.string().uuid(), z.literal("*")]),
  agg: AggregateKindSchema,
  direction: z.enum(["asc", "desc"]).optional(),
  nullsFirst: z.boolean().optional(),
});
export type GroupSortSpec = z.infer<typeof GroupSortSpecSchema>;

/**
 * Optional per-query free-text search. Server compiles it as its own
 * SQL clause across the listed fieldIds (or a default set when fieldIds
 * is empty/undefined). Kept separate from `filter` so users can layer
 * search on top of structured view filters.
 */
const SearchSpecSchema = z.object({
  q: z.string().min(1),
  fieldIds: z.array(z.string().uuid()).optional(),
});
export type SearchSpec = z.infer<typeof SearchSpecSchema>;

export const RecordMetaUserKeySchema = z.enum(["createdBy", "updatedBy", "deletedBy"]);
export type RecordMetaUserKey = z.infer<typeof RecordMetaUserKeySchema>;

export const RecordFinalizationStateSchema = z.enum(["draft", "awaitingReview", "finalized"]);
export type RecordFinalizationState = z.infer<typeof RecordFinalizationStateSchema>;

const RecordMetaQuerySchema = z.object({
  ids: z.array(z.string().uuid()).max(100).optional(),
  finalizationStates: z.array(RecordFinalizationStateSchema).max(3).optional(),
  users: z
    .object({
      createdBy: z.array(z.string().uuid()).max(50).optional(),
      updatedBy: z.array(z.string().uuid()).max(50).optional(),
      deletedBy: z.array(z.string().uuid()).max(50).optional(),
    })
    .optional(),
});
export type RecordMetaQuery = z.infer<typeof RecordMetaQuerySchema>;

const RecordActorSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  subtitle: z.string().nullable(),
  avatarHash: z.string().nullable().optional(),
});
export type RecordActor = z.infer<typeof RecordActorSchema>;

export const RecordActorListResponseSchema = z.object({
  items: z.array(RecordActorSchema),
});

/**
 * Transient structured query shape for table execution and toolbar patches.
 * Persisted Views store canonical GQL in `view.source`; when the records UI
 * needs this shape, it derives it from the GQL source at the service boundary.
 *
 * This is the bound internal shape. Public HTTP query/export bodies use
 * `PublicRecordQuerySchema` in `api/public-query.ts` and resolve app-owned
 * IDs before reaching this contract.
 *
 * Do not persist this object as the View definition.
 */
export const RecordQuerySchema = z.object({
  filter: FilterTreeSchema.optional(),
  search: SearchSpecSchema.optional(),
  /** Record/system metadata criteria. Kept separate from field filters
   *  because these predicates target `records.*` columns, not table data. */
  recordMeta: RecordMetaQuerySchema.optional(),
  sort: z.array(SortSpecSchema).max(MAX_QUERY_SORTS).optional(),
  groupBy: z.array(GroupBySpecSchema).max(3).optional(),
  /** Bucket ordering for grouped queries. When set, groups are ordered
   *  by aggregate value first, then by group keys for deterministic ties.
   *  Used for Top-N views such as "top customers by revenue". */
  groupSort: z.array(GroupSortSpecSchema).max(3).optional(),
  aggregations: z.array(AggregationSpecSchema).max(MAX_QUERY_AGGREGATIONS).optional(),
  columns: z.array(ColumnSpecSchema).max(MAX_QUERY_COLUMNS).optional(),
  /** Visual order for grouped view columns. Group and aggregate specs keep
   *  their semantic order; this only controls the rendered table order. */
  groupedColumnOrder: z.array(z.string().min(1)).optional(),
  /** Hidden visual columns in grouped views. This never changes groupBy
   *  or aggregations; it only suppresses rendered columns. */
  hiddenGroupedColumns: z.array(z.string().min(1)).optional(),
  /** Hard cap on returned rows. Applied after filter+sort, before
   *  pagination. nextCursor becomes null once it would advance past
   *  the cap. */
  limit: z.number().int().min(1).max(10_000).optional(),
  /** When true, soft-deleted records are included in the result. */
  includeDeleted: z.boolean().optional(),
  /** Trash-mode query: only soft-deleted records are returned. */
  deletedOnly: z.boolean().optional(),
});
export type RecordQuery = z.infer<typeof RecordQuerySchema>;

/** Bound internal body for POST /tables/:id/query.
 *
 * `source` is the canonical GQL read shape for the records surface. `query`
 * remains accepted while the existing toolbar builder still emits structured
 * patches for UI-only cases that do not have GQL syntax yet. The HTTP route
 * validates the separate public body before producing this UUID-backed shape.
 */
export const TableQueryBodySchema = z
  .object({
    source: z.string().trim().min(1).max(20_000).optional(),
    query: RecordQuerySchema.optional(),
    viewId: z.string().uuid().optional(),
    cursor: z.string().optional(),
    filePreviewFieldIds: z.array(z.string().uuid()).max(3).optional(),
  })
  .refine((body) => body.source !== undefined || body.query !== undefined, { message: "source or query is required" });

const ExportRelationModeSchema = z.enum(["ids", "labels", "fields"]);

const ExportFieldSpecSchema = z.object({
  fieldId: z.string().uuid(),
  label: z.string().trim().min(1).max(120).optional(),
  relation: z
    .object({
      mode: ExportRelationModeSchema,
      fieldIds: z.array(z.string().uuid()).max(20).optional(),
    })
    .optional(),
});
export type ExportFieldSpec = z.infer<typeof ExportFieldSpecSchema>;

export const ExportBodySchema = z.object({
  format: z.enum(["csv", "json"]).default("csv"),
  query: RecordQuerySchema.optional().default({}),
  fields: z.array(ExportFieldSpecSchema).max(200).optional(),
  csv: z
    .object({
      delimiter: z.enum([",", ";", "\t", "|"]).default(","),
    })
    .optional()
    .default({ delimiter: "," }),
  markdown: z.enum(["raw", "html"]).default("raw"),
});
export type ExportBody = z.infer<typeof ExportBodySchema>;

const GroupBucketSchema = z.object({
  keys: z.array(z.unknown()),
  values: z.record(z.string(), z.unknown()),
});

/**
 * Discriminated response envelope. Fields are populated based on what
 * the RecordQuery asked for (see comment block above).
 */
export const TableQueryResponseSchema = z.object({
  items: z.array(GridRecordSchema).optional(),
  aggregates: z.record(z.string(), z.unknown()).optional(),
  buckets: z.array(GroupBucketSchema).optional(),
  nextCursor: z.string().nullable(),
  /** Group-mode flag (only set when groupBy is non-empty). */
  explode: z.boolean().optional(),
  /** UUID → presentable label for relation-typed bucket keys (group
   *  mode) or relation-cell values (list mode). The UI reads this map
   *  before falling back to UUID-prefix or "—" so a grouped relation
   *  column doesn't show raw ids the way it would without a label
   *  resolver step on the response side. */
  relationLabels: z.record(z.string(), z.string()).optional(),
  /** recordId → fieldId → first image file metadata for card covers. */
  filePreviews: z
    .record(
      z.string().uuid(),
      z.record(
        z.string().uuid(),
        z.object({
          fileId: z.string().uuid(),
          fieldId: z.string().uuid(),
          recordId: z.string().uuid(),
          filename: z.string(),
          mimeType: z.string(),
          sizeBytes: z.number().int(),
        }),
      ),
    )
    .optional(),
});
export type TableQueryBody = z.infer<typeof TableQueryBodySchema>;
export type TableQueryResult = z.infer<typeof TableQueryResponseSchema>;

// ── GQL preview / execution ──────────────────────────────────────────────
//
// Bound internal request/result shapes for the query workspace. Public HTTP
// routes validate and project through api/gql-public.ts. The result is intentionally
// not GridRecord-shaped: GQL can select aliases, formula columns,
// joined fields, or grouped buckets that do not map to one editable record.

const DslQueryCurrentSourceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("table"), tableId: z.string().uuid() }),
    z.object({ kind: z.literal("view"), viewId: z.string().uuid() }),
  ])
  .optional();

const DslQuerySurfaceSchema = z
  .enum(["api", "cli", "custom-app", "document", "query-explorer", "records-view", "ssr", "workflow"])
  .optional();
export type DslQuerySurface = z.infer<typeof DslQuerySurfaceSchema>;

export const MAX_GQL_RESULT_CURSOR_LENGTH = 16_384;

export const DslQueryPreviewBodySchema = z.object({
  query: z.string().trim().min(1).max(20_000),
  /** Optional table scope for table/view pages where `from` is implicit. */
  currentTableId: z.string().uuid().optional(),
  currentSource: DslQueryCurrentSourceSchema,
  /** Optional caller surface for privacy-safe runtime observability. */
  surface: DslQuerySurfaceSchema,
  pageSize: z.number().int().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().max(MAX_GQL_RESULT_CURSOR_LENGTH).optional(),
});
export type DslQueryPreviewBody = z.infer<typeof DslQueryPreviewBodySchema>;

export const DslQueryExecuteBodySchema = DslQueryPreviewBodySchema.extend({
  limit: z.number().int().min(1).max(10_000).optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
  filePreviewFieldIds: z.array(z.string().uuid()).max(3).optional(),
});

export const DslQueryCompileViewBodySchema = z.object({
  query: z.string().trim().min(1).max(20_000),
  /** Optional table scope for table/view pages where `from` is implicit. */
  currentTableId: z.string().uuid().optional(),
  currentSource: DslQueryCurrentSourceSchema,
});

const DslQueryAutocompleteBaseBodySchema = z.object({
  query: z.string().max(20_000),
  /** UTF-16 offset in `query`; defaults to the end of the text. */
  caret: z.number().int().min(0).max(20_000).optional(),
  /** Optional table scope for table/view pages where `from` is implicit. */
  currentTableId: z.string().uuid().optional(),
  currentSource: DslQueryCurrentSourceSchema,
  contextKeys: z
    .array(
      z.custom<import("./query-dsl/parameters").DslQueryContextKey>(
        (value) =>
          typeof value === "string" &&
          (/^params\.[a-z][a-z0-9_]*$/.test(value) ||
            [
              "auth.id",
              "auth.name",
              "auth.username",
              "auth.email",
              "auth.subjects",
              "page.id",
              "page.title",
              "page.url",
              "app.id",
              "app.name",
              "base.id",
              "base.name",
              "time.now",
              "time.today",
              "time.timeZone",
            ].includes(value)),
        "Invalid GQL context key",
      ),
    )
    .max(100)
    .optional(),
});

export const DslQueryAutocompleteBodySchema = DslQueryAutocompleteBaseBodySchema.refine(
  (body) => body.caret === undefined || body.caret <= body.query.length,
  { message: "caret must be inside query", path: ["caret"] },
);

const DslQueryPreviewDiagnosticSchema = z.object({
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  length: z.number().int().min(1).optional(),
  message: z.string(),
});
export type DslQueryPreviewDiagnostic = z.infer<typeof DslQueryPreviewDiagnosticSchema>;

const DslQueryPreviewColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  tableId: z.string().uuid().optional(),
  fieldId: z.string().uuid().optional(),
  joinAlias: z.string().optional(),
  type: z.string(),
  sqlType: z.string(),
  aggregate: z.string().optional(),
});
export type DslQueryPreviewColumn = z.infer<typeof DslQueryPreviewColumnSchema>;

const DslQueryPreviewSuccessSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(["rows", "groups"]),
  columns: z.array(DslQueryPreviewColumnSchema),
  rows: z.array(
    z.object({
      recordId: z.string().uuid().optional(),
      tableId: z.string().uuid().optional(),
      recordMeta: z
        .object({
          version: z.number().int(),
          finalizedAt: z.string().datetime().nullable(),
          finalizedBy: z.string().uuid().nullable(),
          deletedAt: z.string().datetime().nullable(),
          createdBy: z.string().uuid().nullable(),
          updatedBy: z.string().uuid().nullable(),
          createdAt: z.string().datetime(),
          updatedAt: z.string().datetime(),
        })
        .optional(),
      values: z.record(z.string(), z.unknown()),
    }),
  ),
  limit: z.number().int(),
  truncated: z.boolean().optional(),
  page: z
    .object({
      size: z.number().int().min(1),
      start: z.number().int().min(0),
      returned: z.number().int().min(0),
      nextCursor: z.string().nullable(),
    })
    .optional(),
  /** Grouped result where one record can contribute to several buckets
   *  (multi-select / relation group keys). Bucket counts can exceed the
   *  record count; the UI should label this. */
  explode: z.boolean().optional(),
});

const DslQueryPreviewFailureSchema = z.object({
  ok: z.literal(false),
  diagnostics: z.array(DslQueryPreviewDiagnosticSchema),
});

export const DslQueryPreviewResponseSchema = z.union([DslQueryPreviewSuccessSchema, DslQueryPreviewFailureSchema]);
export type DslQueryPreviewResponse = z.infer<typeof DslQueryPreviewResponseSchema>;
export const DslQueryExecuteResponseSchema = DslQueryPreviewResponseSchema;
export type DslQueryExecuteResponse = z.infer<typeof DslQueryExecuteResponseSchema>;

const DslQueryCompletionKindSchema = z.enum(["keyword", "source", "field", "column", "alias", "function", "modifier", "literal"]);
export type DslQueryCompletionKind = z.infer<typeof DslQueryCompletionKindSchema>;

const DslQueryTextRangeSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});
export type DslQueryTextRange = z.infer<typeof DslQueryTextRangeSchema>;

const DslQueryCompletionTextEditSchema = DslQueryTextRangeSchema.extend({
  text: z.string(),
});

const DslQueryCompletionItemSchema = z.object({
  label: z.string(),
  kind: DslQueryCompletionKindSchema,
  detail: z.string().optional(),
  insertText: z.string(),
  textEdit: DslQueryCompletionTextEditSchema,
  commitCharacters: z.array(z.string()).optional(),
});
export type DslQueryCompletionItem = z.infer<typeof DslQueryCompletionItemSchema>;

export const DslQueryAutocompleteResponseSchema = z.object({
  ok: z.literal(true),
  diagnostics: z.array(DslQueryPreviewDiagnosticSchema),
  items: z.array(DslQueryCompletionItemSchema),
});
export type DslQueryAutocompleteResponse = z.infer<typeof DslQueryAutocompleteResponseSchema>;

const DslQueryCompileViewSuccessSchema = z.object({
  ok: z.literal(true),
  tableId: z.string().uuid(),
  source: z.string().trim().min(1).max(20_000),
});
export const DslQueryCompileViewResponseSchema = z.union([DslQueryCompileViewSuccessSchema, DslQueryPreviewFailureSchema]);
export type DslQueryCompileViewResponse = z.infer<typeof DslQueryCompileViewResponseSchema>;

// ── View entity ───────────────────────────────────────────────────────────
export const ViewUiSettingsSchema = z.object({
  displayConfig: RecordDisplayConfigSchema.optional(),
  columns: z.array(ColumnSpecSchema).optional(),
  groupedColumnOrder: z.array(z.string().min(1)).optional(),
  hiddenGroupedColumns: z.array(z.string().min(1)).optional(),
});
export type ViewUiSettings = z.infer<typeof ViewUiSettingsSchema>;

export const ViewSchema = z.object({
  id: z.string().uuid(),
  shortId: ShortIdSchema,
  tableId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  icon: IconNameSchema,
  /** Canonical data query for this view. */
  source: z.string().trim().min(1).max(20_000),
  /** View-owned presentation settings. Data semantics live in `source`. */
  ui: ViewUiSettingsSchema,
  /** null = shared (visible to all table-readers); else owner's user id. */
  ownerUserId: z.string().uuid().nullable(),
  position: z.number().int(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type View = z.infer<typeof ViewSchema>;

export const CreateViewSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).nullable().optional(),
  icon: IconNameSchema,
  source: z.string().trim().min(1).max(20_000).optional(),
  ui: ViewUiSettingsSchema.optional(),
  shared: z.boolean().optional(),
});

export const UpdateViewSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2_000).nullable().optional(),
  icon: IconNameSchema,
  source: z.string().trim().min(1).max(20_000).optional(),
  ui: ViewUiSettingsSchema.optional(),
  position: z.number().int().optional(),
  shared: z.boolean().optional(),
});

export const ViewListSchema = z.array(ViewSchema);

// ── Documents ─────────────────────────────────────────────────────────────
export const HtmlDocumentTemplateRendererSchema = z
  .object({
    kind: z.literal("html"),
    body: z.string().trim().min(1).max(200_000),
    header: z.string().trim().min(1).max(50_000).optional(),
    footer: z.string().trim().min(1).max(50_000).optional(),
    css: z.string().trim().min(1).max(50_000).optional(),
    numberTemplate: z.string().trim().min(1).max(5_000),
    filenameTemplate: z.string().trim().min(1).max(5_000),
  })
  .strict();
export type HtmlDocumentTemplateRenderer = z.infer<typeof HtmlDocumentTemplateRendererSchema>;

export const ProfileDocumentTemplateRendererSchema = z
  .object({
    kind: z.literal("profile"),
    id: z.string().regex(/^[a-z][a-z0-9.-]{2,99}$/),
    version: z.number().int().positive(),
    inputTemplate: z.string().trim().min(1).max(200_000),
  })
  .strict();
export type ProfileDocumentTemplateRenderer = z.infer<typeof ProfileDocumentTemplateRendererSchema>;

export const DocumentTemplateRendererSchema = z.discriminatedUnion("kind", [
  HtmlDocumentTemplateRendererSchema,
  ProfileDocumentTemplateRendererSchema,
]);
export type DocumentTemplateRenderer = z.infer<typeof DocumentTemplateRendererSchema>;

export const DocumentTemplateRendererSummarySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("html") }).strict(),
  ProfileDocumentTemplateRendererSchema.pick({ kind: true, id: true, version: true }).strict(),
]);
export type DocumentTemplateRendererSummary = z.infer<typeof DocumentTemplateRendererSummarySchema>;

export const DocumentTemplateSchema = z.object({
  id: z.string().uuid(),
  shortId: ShortIdSchema,
  tableId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  source: z.string().trim().min(1).max(20_000),
  renderer: DocumentTemplateRendererSchema,
  enabled: z.boolean(),
  position: z.number().int(),
  createdBy: z.string().uuid().nullable(),
  updatedBy: z.string().uuid().nullable(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DocumentTemplate = z.infer<typeof DocumentTemplateSchema>;

export const DocumentTemplateListSchema = z.array(DocumentTemplateSchema);

export const ReorderDocumentTemplatesSchema = z.object({
  templateIds: z
    .array(z.string().uuid())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, "template ids must be unique"),
});

const DocumentTemplateSummarySchema = DocumentTemplateSchema.pick({
  id: true,
  shortId: true,
  tableId: true,
  name: true,
  description: true,
  enabled: true,
  position: true,
  createdAt: true,
  updatedAt: true,
}).extend({ renderer: DocumentTemplateRendererSummarySchema });
export type DocumentTemplateSummary = z.infer<typeof DocumentTemplateSummarySchema>;

export const DocumentTemplateSummaryListSchema = z.array(DocumentTemplateSummarySchema);

export const CreateDocumentTemplateSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2_000).nullable().optional(),
    source: z.string().trim().min(1).max(20_000),
    renderer: DocumentTemplateRendererSchema,
    enabled: z.boolean().optional(),
  })
  .strict();
export type CreateDocumentTemplateInput = z.infer<typeof CreateDocumentTemplateSchema>;

export const UpdateDocumentTemplateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2_000).nullable().optional(),
    source: z.string().trim().min(1).max(20_000).optional(),
    renderer: DocumentTemplateRendererSchema.optional(),
    enabled: z.boolean().optional(),
    position: z.number().int().optional(),
  })
  .strict();
export type UpdateDocumentTemplateInput = z.infer<typeof UpdateDocumentTemplateSchema>;

export const DocumentTemplateDraftPreviewSchema = z
  .object({
    source: z.string().trim().min(1).max(20_000),
    renderer: DocumentTemplateRendererSchema,
    recordId: z.string().uuid(),
  })
  .strict();

export const RecordSnapshotSchema = z.object({
  id: z.string().uuid(),
  shortId: ShortIdSchema,
  baseId: z.string().uuid(),
  tableId: z.string().uuid(),
  recordId: z.string().uuid(),
  root: z.record(z.string(), z.unknown()),
  graph: z.record(z.string(), z.unknown()),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type RecordSnapshot = z.infer<typeof RecordSnapshotSchema>;

const RecordSnapshotSummarySchema = RecordSnapshotSchema.pick({
  id: true,
  shortId: true,
  baseId: true,
  tableId: true,
  recordId: true,
  createdBy: true,
  createdAt: true,
});
export type RecordSnapshotSummary = z.infer<typeof RecordSnapshotSummarySchema>;

export const RecordSnapshotListResponseSchema = z.object({
  items: z.array(RecordSnapshotSummarySchema),
});
export type RecordSnapshotListResponse = z.infer<typeof RecordSnapshotListResponseSchema>;

export const DocumentArtifactSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    fileId: z.string().uuid(),
    filename: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(255),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type DocumentArtifact = z.infer<typeof DocumentArtifactSchema>;

const DocumentSchema = z.object({
  id: z.string().uuid(),
  shortId: ShortIdSchema,
  templateId: z.string().uuid(),
  workflowRunId: z.string().uuid().nullable(),
  snapshotId: z.string().uuid(),
  baseId: z.string().uuid(),
  tableId: z.string().uuid(),
  recordId: z.string().uuid(),
  documentNumber: z.string(),
  filename: z.string(),
  tags: z.array(z.string()),
  templateSnapshot: z.record(z.string(), z.unknown()),
  renderData: z.record(z.string(), z.unknown()),
  artifacts: z.array(DocumentArtifactSchema).min(1).max(8),
  profile: z.object({ id: z.string(), version: z.number().int().positive() }).strict().nullable(),
  validationStatus: z.enum(["valid", "warning"]).nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type Document = z.infer<typeof DocumentSchema>;

export const DocumentSummarySchema = DocumentSchema.pick({
  id: true,
  shortId: true,
  templateId: true,
  workflowRunId: true,
  snapshotId: true,
  baseId: true,
  tableId: true,
  recordId: true,
  documentNumber: true,
  filename: true,
  tags: true,
  artifacts: true,
  profile: true,
  validationStatus: true,
  createdBy: true,
  createdAt: true,
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

export const DocumentSummaryListSchema = z.object({
  items: z.array(DocumentSummarySchema),
  total: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  hasMore: z.boolean().optional(),
  nextOffset: z.number().int().nonnegative().nullable().optional(),
  nextCursor: z.string().nullable().optional(),
});
export type DocumentSummaryList = z.infer<typeof DocumentSummaryListSchema>;

const DocumentLinkTtlSchema = z.enum(["1d", "7d", "30d", "90d"]);
export type DocumentLinkTtl = z.infer<typeof DocumentLinkTtlSchema>;

export const DocumentLinkSchema = z.object({
  id: z.string().uuid(),
  shortId: ShortIdSchema,
  documentId: z.string().uuid(),
  baseId: z.string().uuid(),
  tableId: z.string().uuid(),
  recordId: z.string().uuid(),
  comment: z.string().nullable(),
  createdBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  revokedBy: z.string().uuid().nullable(),
  lastAccessedAt: z.string().datetime().nullable(),
  accessCount: z.number().int().nonnegative(),
});
export type DocumentLink = z.infer<typeof DocumentLinkSchema>;

export const DocumentLinkListResponseSchema = z.object({
  items: z.array(DocumentLinkSchema),
});
export type DocumentLinkListResponse = z.infer<typeof DocumentLinkListResponseSchema>;

export const CreateDocumentLinkSchema = z.object({
  expiresIn: DocumentLinkTtlSchema.default("30d"),
  comment: z.string().trim().max(500).optional().nullable(),
});
export type CreateDocumentLinkInput = z.infer<typeof CreateDocumentLinkSchema>;

export const CreateDocumentLinkResponseSchema = z.object({
  link: DocumentLinkSchema,
  url: z.string(),
});
export type CreateDocumentLinkResponse = z.infer<typeof CreateDocumentLinkResponseSchema>;

const EMAIL_TEMPLATE_SAMPLE_DATA_MAX_BYTES = 50_000;

export const EmailTemplateSampleDataSchema = z.record(z.string().min(1).max(200), z.json()).superRefine((value, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > EMAIL_TEMPLATE_SAMPLE_DATA_MAX_BYTES) {
    ctx.addIssue({ code: "custom", message: "sample data must not exceed 50000 bytes" });
  }
});

export const EmailTemplateSchema = z.object({
  id: z.string().uuid(),
  shortId: ShortIdSchema,
  baseId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  subject: z.string(),
  html: z.string(),
  sampleData: EmailTemplateSampleDataSchema,
  enabled: z.boolean(),
  position: z.number().int(),
  createdBy: z.string().uuid().nullable(),
  updatedBy: z.string().uuid().nullable(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type EmailTemplate = z.infer<typeof EmailTemplateSchema>;

export const EmailTemplateListSchema = z.array(EmailTemplateSchema);

export const EmailTemplateDependencySchema = z.object({
  workflowId: z.string().uuid(),
  workflowShortId: ShortIdSchema,
  workflowName: z.string().min(1),
});

export const EmailTemplateDependencyMapSchema = z.record(z.string().uuid(), z.array(EmailTemplateDependencySchema));

export type EmailTemplateDependency = z.infer<typeof EmailTemplateDependencySchema>;
export type EmailTemplateDependencyMap = z.infer<typeof EmailTemplateDependencyMapSchema>;

export const CreateEmailTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).nullable().optional(),
  subject: z.string().trim().min(1).max(1_000),
  html: z.string().trim().min(1).max(200_000),
  sampleData: EmailTemplateSampleDataSchema.optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().optional(),
});
export type CreateEmailTemplateInput = z.infer<typeof CreateEmailTemplateSchema>;

export const UpdateEmailTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  subject: z.string().trim().min(1).max(1_000).optional(),
  html: z.string().trim().min(1).max(200_000).optional(),
  sampleData: EmailTemplateSampleDataSchema.optional(),
  enabled: z.boolean().optional(),
  position: z.number().int().optional(),
});
export type UpdateEmailTemplateInput = z.infer<typeof UpdateEmailTemplateSchema>;

const DocumentFolderSchema = z.object({
  kind: z.enum(["year", "month"]),
  key: z.string(),
  label: z.string(),
  path: z.array(z.string()),
  count: z.number().int().nonnegative(),
});
export type DocumentFolder = z.infer<typeof DocumentFolderSchema>;

export const DocumentBrowseResponseSchema = z.object({
  path: z.array(z.string()),
  folders: z.array(DocumentFolderSchema),
  items: z.array(DocumentSummarySchema),
  total: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().nullable().optional(),
});
export type DocumentBrowseResponse = z.infer<typeof DocumentBrowseResponseSchema>;

export const DocumentRecordBodySchema = z.object({
  recordId: z.string().uuid(),
  filename: z.string().trim().min(1).max(255).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional().default([]),
});

export const DocumentPreviewResponseSchema = z.object({
  html: z.string(),
  source: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type DocumentPreviewResponse = z.infer<typeof DocumentPreviewResponseSchema>;

export const CreateRecordSnapshotResponseSchema = z.object({
  snapshot: RecordSnapshotSchema,
});
export type CreateRecordSnapshotResponse = z.infer<typeof CreateRecordSnapshotResponseSchema>;

// ── Forms ────────────────────────────────────────────────────────────────
//
// Stored form config is JSONB. Keep the write contract here so API and
// service boundaries validate the same shape before anything reaches DB.
const InlineCreateFormFieldSchema = z.object({
  fieldId: z.string().uuid(),
  label: z.string().optional(),
  helpText: z.string().optional(),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
});

const InlineCreateConfigSchema = z.object({
  enabled: z.boolean().optional(),
  fields: z.array(InlineCreateFormFieldSchema).optional(),
});

export const UserInputFormFieldEntrySchema = z.object({
  kind: z.literal("user_input"),
  fieldId: z.string().uuid(),
  label: z.string().optional(),
  helpText: z.string().optional(),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  inlineCreate: InlineCreateConfigSchema.optional(),
});

const FormValueFieldEntrySchema = z.object({
  kind: z.literal("form_value"),
  fieldId: z.string().uuid(),
  value: z.unknown(),
});

const FormFieldEntrySchema = z.discriminatedUnion("kind", [UserInputFormFieldEntrySchema, FormValueFieldEntrySchema]);

export const FormValidationRuleSchema = z
  .object({
    leftFieldId: z.string().uuid(),
    operator: z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]),
    rightFieldId: z.string().uuid(),
    message: z.string().trim().min(1).max(240),
    errorFieldId: z.string().uuid().optional(),
  })
  .strict();
export type FormValidationRule = z.infer<typeof FormValidationRuleSchema>;

export const FormConfigSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(FormFieldEntrySchema),
  validations: z.array(FormValidationRuleSchema).max(20).optional(),
  submitLabel: z.string().optional(),
  successMessage: z.string().optional(),
  redirectUrl: z.string().nullable().optional(),
  // Optional title image (base64 data-URL). Frontend caps source
  // dimensions before emitting; the server still enforces a hard cap.
  titleImage: z.string().max(1_000_000).optional(),
});

// ── Lists ─────────────────────────────────────────────────────────────────
export const BaseListSchema = z.object({
  items: z.array(BaseSchema),
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
});
export const TableListSchema = z.array(TableSchema);
export const FieldListSchema = z.array(FieldSchema);

// ── Field-dependents preflight ────────────────────────────────────────────
const FieldDependentSchema = z.object({
  type: z.enum(["view", "form", "formula", "lookup", "rollup", "relation_display", "audit_policy"]),
  resourceId: z.string().uuid(),
  resourceName: z.string(),
  context: z.string().optional(),
  blocking: z.boolean(),
});
export const FieldDependentsResponseSchema = z.object({
  dependents: z.array(FieldDependentSchema),
  hasBlocking: z.boolean(),
});

// ── Relation lookup ───────────────────────────────────────────────────────
// Backs `GET /api/grids/tables/:tableId/lookup` — the search endpoint
// the RelationPicker uses to populate its dropdown. Each item is a
// pre-formatted label so the client doesn't need to know about
// `presentable` field rules.
const RelationLookupItemSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
});
export const RelationLookupResponseSchema = z.object({
  items: z.array(RelationLookupItemSchema),
});
export type RelationLookupItem = z.infer<typeof RelationLookupItemSchema>;
