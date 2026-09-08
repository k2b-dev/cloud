import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import type { Field } from "../contracts";
import {
  type ExportBody,
  ExportBodySchema,
  FormatSpecSchema,
  MAX_FILTER_DEPTH,
  MAX_FILTER_GROUP_ITEMS,
  MAX_FILTER_NODES,
  type RecordQuery,
  RecordQuerySchema,
  ShortIdSchema,
} from "../contracts";
import { rewriteGroupedColumnKeys } from "../presentation-ids";
import { gridsService } from "../service";
import { projectPublicIds, resolvePublicIds } from "../service/public-resources";

const PublicFilterLeafSchema = z.object({
  fieldId: ShortIdSchema,
  op: z.string(),
  value: z.unknown().optional(),
  caseInsensitive: z.boolean().optional(),
});

type PublicFilterTree = z.infer<typeof PublicFilterLeafSchema> | { op: "AND" | "OR"; filters: PublicFilterTree[] };

const publicFilterWithinBounds = (value: unknown): boolean => {
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

const RecursivePublicFilterTreeSchema: z.ZodType<PublicFilterTree, PublicFilterTree> = z.lazy(() =>
  z.union([
    PublicFilterLeafSchema,
    z.object({ op: z.enum(["AND", "OR"]), filters: z.array(RecursivePublicFilterTreeSchema).max(MAX_FILTER_GROUP_ITEMS) }),
  ]),
);

const PublicFilterTreeSchema = z
  .custom<PublicFilterTree>(publicFilterWithinBounds, "filter is too large or deeply nested")
  .pipe(RecursivePublicFilterTreeSchema) as z.ZodType<PublicFilterTree>;

const PublicFieldSortSpecSchema = z.object({
  source: z.literal("field").optional(),
  fieldId: ShortIdSchema,
  direction: z.enum(["asc", "desc"]),
  nullsFirst: z.boolean().optional(),
});
const PublicRecordSortSpecSchema = z.object({
  source: z.literal("record"),
  key: z.enum(["createdAt", "updatedAt", "deletedAt"]),
  direction: z.enum(["asc", "desc"]),
  nullsFirst: z.boolean().optional(),
});
const PublicFieldReferenceSchema = z.object({
  fieldId: ShortIdSchema,
  label: z.string().trim().min(1).max(120).optional(),
  format: FormatSpecSchema.optional(),
});
const PublicComputedColumnSchema = z.object({
  kind: z.literal("computed"),
  id: z.string().regex(/^computed_[A-Za-z0-9]{5,32}$/),
  label: z.string().trim().min(1).max(120),
  expression: z.string().trim().min(1).max(5000),
  format: FormatSpecSchema.optional(),
});
const PublicAggregateFieldSchema = z.union([ShortIdSchema, z.literal("*")]);

export const PublicRecordQuerySchema = RecordQuerySchema.extend({
  filter: PublicFilterTreeSchema.optional(),
  search: z.object({ q: z.string().min(1), fieldIds: z.array(ShortIdSchema).optional() }).optional(),
  recordMeta: z
    .object({
      ids: z.array(ShortIdSchema).max(100).optional(),
      finalizationStates: z
        .array(z.enum(["draft", "awaitingReview", "finalized"]))
        .max(3)
        .optional(),
      users: z
        .object({
          createdBy: z.array(z.string().uuid()).max(50).optional(),
          updatedBy: z.array(z.string().uuid()).max(50).optional(),
          deletedBy: z.array(z.string().uuid()).max(50).optional(),
        })
        .optional(),
    })
    .optional(),
  sort: z
    .array(z.union([PublicRecordSortSpecSchema, PublicFieldSortSpecSchema]))
    .max(16)
    .optional()
    .describe("Record ordering. Grouped queries use groupBy direction and groupSort instead."),
  groupBy: z
    .array(
      PublicFieldReferenceSchema.extend({
        direction: z.enum(["asc", "desc"]).optional(),
        nullsFirst: z.boolean().optional(),
        granularity: z.enum(["day", "week", "month", "quarter", "year"]).optional(),
      }),
    )
    .max(3)
    .optional(),
  groupSort: z
    .array(
      z.object({
        fieldId: PublicAggregateFieldSchema,
        agg: z.enum(["count", "countEmpty", "countUnique", "sum", "avg", "min", "max", "median", "earliest", "latest"]),
        direction: z.enum(["asc", "desc"]).optional(),
        nullsFirst: z.boolean().optional(),
      }),
    )
    .max(3)
    .optional()
    .describe("Order groups by aggregate values, then by groupBy keys for ties."),
  aggregations: z
    .array(
      z.object({
        fieldId: PublicAggregateFieldSchema,
        agg: z.enum(["count", "countEmpty", "countUnique", "sum", "avg", "min", "max", "median", "earliest", "latest"]),
        label: z.string().optional(),
        format: FormatSpecSchema.optional(),
      }),
    )
    .max(32)
    .optional(),
  columns: z
    .array(z.union([PublicFieldReferenceSchema, PublicComputedColumnSchema]))
    .max(100)
    .optional(),
});

export type PublicRecordQuery = z.infer<typeof PublicRecordQuerySchema>;

export const PublicTableQueryBodySchema = z
  .object({
    source: z.string().trim().min(1).max(20_000).optional(),
    query: PublicRecordQuerySchema.optional(),
    viewId: ShortIdSchema.optional(),
    cursor: z.string().optional(),
    filePreviewFieldIds: z.array(ShortIdSchema).max(3).optional(),
  })
  .refine((body) => body.source !== undefined || body.query !== undefined, { message: "source or query is required" });
export type PublicTableQueryBody = z.infer<typeof PublicTableQueryBodySchema>;

const PublicExportFieldSpecSchema = z.object({
  fieldId: ShortIdSchema,
  label: z.string().trim().min(1).max(120).optional(),
  relation: z.object({ mode: z.enum(["ids", "labels", "fields"]), fieldIds: z.array(ShortIdSchema).max(20).optional() }).optional(),
});

export const PublicExportBodySchema = ExportBodySchema.omit({ query: true, fields: true }).extend({
  query: PublicRecordQuerySchema.optional().default({}),
  fields: z.array(PublicExportFieldSpecSchema).max(200).optional(),
});
export type PublicExportBody = z.infer<typeof PublicExportBodySchema>;

type PublicQueryDeps = {
  listFields?: typeof gridsService.field.listByTable;
  resolveIds?: typeof resolvePublicIds;
};

export const toPublicRecordQuery = async (query: RecordQuery, fields: readonly Field[]): Promise<PublicRecordQuery> => {
  const fieldsByInternalId = new Map(fields.map((field) => [field.id, field]));
  const relationRecordIds: string[] = [];
  const collectRelationValues = (filter: RecordQuery["filter"]): void => {
    if (!filter) return;
    if ("filters" in filter) {
      for (const child of filter.filters) collectRelationValues(child);
      return;
    }
    if (fieldsByInternalId.get(filter.fieldId)?.type === "relation") relationRecordIds.push(...relationValueIds(filter.value));
  };
  collectRelationValues(query.filter);
  const recordIds = [...(query.recordMeta?.ids ?? []), ...relationRecordIds];
  const records = await projectPublicIds("record", recordIds);
  const publicFieldId = (internalId: string): string => {
    if (internalId === "*") return internalId;
    const publicId = fieldsByInternalId.get(internalId)?.shortId;
    if (!publicId) throw new Error(`Cannot project query field ${internalId}`);
    return publicId;
  };
  const publicRecordId = (internalId: string): string => {
    const publicId = records.get(internalId);
    if (!publicId) throw new Error(`Cannot project query record ${internalId}`);
    return publicId;
  };
  const projectFilter = (filter: RecordQuery["filter"]): PublicFilterTree | undefined => {
    if (!filter) return undefined;
    if ("filters" in filter)
      return { ...filter, filters: filter.filters.map(projectFilter).filter((item): item is PublicFilterTree => !!item) };
    const field = fieldsByInternalId.get(filter.fieldId);
    return {
      ...filter,
      fieldId: publicFieldId(filter.fieldId),
      ...(field?.type === "relation"
        ? {
            value: Array.isArray(filter.value)
              ? filter.value.map((id) => (typeof id === "string" ? publicRecordId(id) : id))
              : typeof filter.value === "string"
                ? publicRecordId(filter.value)
                : filter.value,
          }
        : {}),
    };
  };
  const groupedColumnOrder = rewriteGroupedColumnKeys(query.groupedColumnOrder, publicFieldId);
  if (!groupedColumnOrder.ok) throw new Error(groupedColumnOrder.error.message);
  const hiddenGroupedColumns = rewriteGroupedColumnKeys(query.hiddenGroupedColumns, publicFieldId);
  if (!hiddenGroupedColumns.ok) throw new Error(hiddenGroupedColumns.error.message);
  return PublicRecordQuerySchema.parse({
    ...query,
    filter: projectFilter(query.filter),
    search: query.search ? { ...query.search, fieldIds: query.search.fieldIds?.map(publicFieldId) } : undefined,
    recordMeta: query.recordMeta ? { ...query.recordMeta, ids: query.recordMeta.ids?.map(publicRecordId) } : undefined,
    sort: query.sort?.map((item) => (item.source === "record" ? item : { ...item, fieldId: publicFieldId(item.fieldId) })),
    groupBy: query.groupBy?.map((item) => ({ ...item, fieldId: publicFieldId(item.fieldId) })),
    groupSort: query.groupSort?.map((item) => ({ ...item, fieldId: publicFieldId(item.fieldId) })),
    aggregations: query.aggregations?.map((item) => ({ ...item, fieldId: publicFieldId(item.fieldId) })),
    columns: query.columns?.map((item) => ("kind" in item ? item : { ...item, fieldId: publicFieldId(item.fieldId) })),
    groupedColumnOrder: groupedColumnOrder.data,
    hiddenGroupedColumns: hiddenGroupedColumns.data,
  });
};

const fieldId = (fieldsByPublicId: ReadonlyMap<string, Field>, publicId: string): Result<string> => {
  const field = fieldsByPublicId.get(publicId);
  return field ? ok(field.id) : fail(err.badInput("Unknown field ID"));
};

const relationValueIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];

export const fromPublicRecordQuery = async (
  tableId: string,
  query: PublicRecordQuery,
  deps: PublicQueryDeps = {},
): Promise<Result<RecordQuery>> => {
  const fields = await (deps.listFields ?? gridsService.field.listByTable)(tableId);
  const fieldsByPublicId = new Map(fields.map((field) => [field.shortId, field]));
  const relationIds: string[] = [];
  const visitFilter = (filter: PublicFilterTree | undefined): Result<RecordQuery["filter"]> => {
    if (!filter) return ok(undefined);
    if ("filters" in filter) {
      const converted = filter.filters.map(visitFilter);
      const failed = converted.find((item) => !item.ok);
      if (failed && !failed.ok) return failed;
      return ok({ op: filter.op, filters: converted.flatMap((item) => (item.ok && item.data ? [item.data] : [])) });
    }
    const resolved = fieldId(fieldsByPublicId, filter.fieldId);
    if (!resolved.ok) return resolved;
    const field = fieldsByPublicId.get(filter.fieldId)!;
    if (field.type === "relation") relationIds.push(...relationValueIds(filter.value));
    return ok({ ...filter, fieldId: resolved.data });
  };
  const filter = visitFilter(query.filter);
  if (!filter.ok) return filter;

  const recordPublicIds = query.recordMeta?.ids ?? [];
  const resolveIds = deps.resolveIds ?? resolvePublicIds;
  const [records, relations] = await Promise.all([resolveIds("record", recordPublicIds), resolveIds("record", relationIds)]);
  if (records.size !== new Set(recordPublicIds).size) return fail(err.badInput("Unknown record ID"));
  if (relations.size !== new Set(relationIds).size) return fail(err.badInput("Unknown related record ID"));

  const resolveField = (publicId: string): string | null => fieldsByPublicId.get(publicId)?.id ?? null;
  const resolveAggregateField = (publicId: string): string | null => (publicId === "*" ? "*" : resolveField(publicId));
  const mapList = <T extends { fieldId: string }>(items: readonly T[] | undefined, resolve: (id: string) => string | null) => {
    if (!items) return ok(undefined);
    const converted = items.map((item) => {
      const id = resolve(item.fieldId);
      return id ? { ...item, fieldId: id } : null;
    });
    return converted.some((item) => !item) ? fail(err.badInput("Unknown field ID")) : ok(converted as T[]);
  };
  const searchIds = query.search?.fieldIds?.map(resolveField);
  if (searchIds?.some((id) => !id)) return fail(err.badInput("Unknown field ID"));
  const fieldSorts = query.sort?.map((sort) => (sort.source === "record" ? sort : { ...sort, fieldId: resolveField(sort.fieldId) }));
  if (fieldSorts?.some((sort) => "fieldId" in sort && !sort.fieldId)) return fail(err.badInput("Unknown field ID"));
  const groupBy = mapList(query.groupBy, resolveField);
  if (!groupBy.ok) return groupBy;
  const groupSort = mapList(query.groupSort, resolveAggregateField);
  if (!groupSort.ok) return groupSort;
  const aggregations = mapList(query.aggregations, resolveAggregateField);
  if (!aggregations.ok) return aggregations;
  const columns = query.columns?.map((column) => {
    if (!("fieldId" in column)) return column;
    const id = resolveField(column.fieldId);
    return id ? { ...column, fieldId: id } : null;
  });
  if (columns?.some((column) => !column)) return fail(err.badInput("Unknown field ID"));
  const groupedColumnOrder = rewriteGroupedColumnKeys(query.groupedColumnOrder, resolveField);
  if (!groupedColumnOrder.ok) return groupedColumnOrder;
  const hiddenGroupedColumns = rewriteGroupedColumnKeys(query.hiddenGroupedColumns, resolveField);
  if (!hiddenGroupedColumns.ok) return hiddenGroupedColumns;
  const rewriteRelationFilter = (value: RecordQuery["filter"]): RecordQuery["filter"] => {
    if (!value) return value;
    if ("filters" in value) {
      return {
        ...value,
        filters: value.filters
          .map((child) => rewriteRelationFilter(child))
          .filter((child): child is NonNullable<typeof child> => Boolean(child)),
      };
    }
    const field = fields.find((candidate) => candidate.id === value.fieldId);
    if (field?.type !== "relation") return value;
    const publicIds = relationValueIds(value.value);
    const converted = publicIds.map((id) => relations.get(id)!);
    return { ...value, value: Array.isArray(value.value) ? converted : (converted[0] ?? value.value) };
  };
  const internal = {
    ...query,
    ...(filter.data ? { filter: rewriteRelationFilter(filter.data) } : { filter: undefined }),
    ...(query.search ? { search: { ...query.search, fieldIds: searchIds?.filter((id): id is string => Boolean(id)) } } : {}),
    ...(query.recordMeta ? { recordMeta: { ...query.recordMeta, ids: query.recordMeta.ids?.map((id) => records.get(id)!) } } : {}),
    sort: fieldSorts as RecordQuery["sort"],
    groupBy: groupBy.data,
    groupSort: groupSort.data,
    aggregations: aggregations.data,
    columns: columns?.filter((column): column is NonNullable<typeof column> => Boolean(column)),
    groupedColumnOrder: groupedColumnOrder.data,
    hiddenGroupedColumns: hiddenGroupedColumns.data,
  } satisfies RecordQuery;
  return ok(internal);
};

export const fromPublicExportBody = async (
  tableId: string,
  body: PublicExportBody,
  deps: PublicQueryDeps = {},
): Promise<Result<ExportBody>> => {
  const query = await fromPublicRecordQuery(tableId, body.query, deps);
  if (!query.ok) return query;
  const listFields = deps.listFields ?? gridsService.field.listByTable;
  const fields = await listFields(tableId);
  const byPublicId = new Map(fields.map((field) => [field.shortId, field]));
  const convertedFields: NonNullable<ExportBody["fields"]> = [];
  for (const spec of body.fields ?? []) {
    const field = byPublicId.get(spec.fieldId);
    if (!field) return fail(err.badInput("Unknown field ID"));
    let relation = spec.relation;
    if (relation?.fieldIds) {
      const targetTableId = field.type === "relation" ? (field.config as { targetTableId?: unknown }).targetTableId : null;
      if (typeof targetTableId !== "string") return fail(err.badInput("Relation field expansion requires a relation field"));
      const targets = new Map((await listFields(targetTableId)).map((target) => [target.shortId, target.id]));
      const ids = relation.fieldIds.map((id) => targets.get(id));
      if (ids.some((id) => !id)) return fail(err.badInput("Unknown relation target field ID"));
      relation = { ...relation, fieldIds: ids.filter((id): id is string => Boolean(id)) };
    }
    convertedFields.push({ ...spec, fieldId: field.id, relation });
  }
  return ok({ ...body, query: query.data, fields: body.fields ? convertedFields : undefined });
};
