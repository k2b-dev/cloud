import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import {
  DslQueryAutocompleteBodySchema,
  DslQueryCompileViewBodySchema,
  DslQueryExecuteBodySchema,
  DslQueryPreviewBodySchema,
  type DslQueryPreviewResponse,
  DslQueryPreviewResponseSchema,
  ShortIdSchema,
} from "../contracts";
import { gridsService } from "../service";
import { projectPublicIds } from "../service/public-resources";
import type { DslCurrentSource } from "./gql-runtime";

const PublicDslCurrentSourceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("table"), tableId: ShortIdSchema }),
    z.object({ kind: z.literal("view"), viewId: ShortIdSchema }),
  ])
  .optional();

const publicScope = {
  currentTableId: ShortIdSchema.optional(),
  currentSource: PublicDslCurrentSourceSchema,
};

export const PublicDslQueryPreviewBodySchema = DslQueryPreviewBodySchema.omit({ currentTableId: true, currentSource: true }).extend(
  publicScope,
);
export const PublicDslQueryExecuteBodySchema = DslQueryExecuteBodySchema.omit({
  currentTableId: true,
  currentSource: true,
  filePreviewFieldIds: true,
}).extend({ ...publicScope, filePreviewFieldIds: z.array(ShortIdSchema).max(3).optional() });
export const PublicDslQueryCompileViewBodySchema = DslQueryCompileViewBodySchema.omit({ currentTableId: true, currentSource: true }).extend(
  publicScope,
);
const { currentTableId: _currentTableId, currentSource: _currentSource, ...autocompleteShape } = DslQueryAutocompleteBodySchema.shape;
export const PublicDslQueryAutocompleteBodySchema = z
  .object({ ...autocompleteShape, ...publicScope })
  .refine((body) => body.caret === undefined || body.caret <= body.query.length, {
    message: "caret must be inside query",
    path: ["caret"],
  });

const PublicDslQueryPreviewColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  tableId: ShortIdSchema.optional(),
  fieldId: ShortIdSchema.optional(),
  joinAlias: z.string().optional(),
  type: z.string(),
  sqlType: z.string(),
  aggregate: z.string().optional(),
});
const PublicDslQueryPreviewSuccessSchema = DslQueryPreviewResponseSchema.options[0].omit({ columns: true, rows: true }).extend({
  columns: z.array(PublicDslQueryPreviewColumnSchema),
  rows: z.array(
    DslQueryPreviewResponseSchema.options[0].shape.rows.element.omit({ recordId: true, tableId: true }).extend({
      recordId: ShortIdSchema.optional(),
      tableId: ShortIdSchema.optional(),
    }),
  ),
});
export const PublicDslQueryPreviewResponseSchema = z.union([PublicDslQueryPreviewSuccessSchema, DslQueryPreviewResponseSchema.options[1]]);
export type PublicDslQueryPreviewResponse = z.infer<typeof PublicDslQueryPreviewResponseSchema>;
export const PublicDslQueryExecuteResponseSchema = PublicDslQueryPreviewResponseSchema;
export const PublicDslQueryCompileViewResponseSchema = z.union([
  z.object({ ok: z.literal(true), tableId: ShortIdSchema, source: z.string().trim().min(1).max(20_000) }),
  DslQueryPreviewResponseSchema.options[1],
]);

type PublicGqlScope = {
  currentTableId?: string;
  currentSource?: { kind: "table"; tableId: string } | { kind: "view"; viewId: string };
  filePreviewFieldIds?: string[];
};

type GqlPublicDeps = {
  getTableByShortId?: typeof gridsService.table.getByShortId;
  getViewByShortId?: typeof gridsService.view.getByShortId;
  getTable?: typeof gridsService.table.get;
  listFields?: typeof gridsService.field.listByTable;
};

export const fromPublicGqlScope = async (
  baseId: string,
  input: PublicGqlScope,
  deps: GqlPublicDeps = {},
): Promise<Result<{ currentTableId?: string; currentSource?: DslCurrentSource; filePreviewFieldIds?: string[] }>> => {
  const getTableByShortId = deps.getTableByShortId ?? gridsService.table.getByShortId;
  const getViewByShortId = deps.getViewByShortId ?? gridsService.view.getByShortId;
  const getTable = deps.getTable ?? gridsService.table.get;
  const currentTable = input.currentTableId ? await getTableByShortId(input.currentTableId) : null;
  if (input.currentTableId && (!currentTable || currentTable.baseId !== baseId)) return fail(err.notFound("Table"));

  let currentSource: DslCurrentSource;
  let sourceTable = currentTable;
  if (input.currentSource?.kind === "table") {
    const table = await getTableByShortId(input.currentSource.tableId);
    if (!table || table.baseId !== baseId) return fail(err.notFound("Table"));
    currentSource = { kind: "table", tableId: table.id };
    sourceTable = table;
  } else if (input.currentSource?.kind === "view") {
    const view = await getViewByShortId(input.currentSource.viewId);
    const table = view ? await getTable(view.tableId) : null;
    if (!view || !table || table.baseId !== baseId) return fail(err.notFound("View"));
    currentSource = { kind: "view", viewId: view.id };
    sourceTable = table;
  }

  let filePreviewFieldIds: string[] | undefined;
  if (input.filePreviewFieldIds) {
    if (!sourceTable) return fail(err.badInput("A table scope is required for file preview fields"));
    const fields = await (deps.listFields ?? gridsService.field.listByTable)(sourceTable.id);
    const byPublicId = new Map(fields.map((field) => [field.shortId, field.id]));
    const ids = input.filePreviewFieldIds.map((id) => byPublicId.get(id));
    if (ids.some((id) => !id)) return fail(err.badInput("Unknown field ID"));
    filePreviewFieldIds = ids.filter((id): id is string => Boolean(id));
  }
  return ok({
    ...(currentTable ? { currentTableId: currentTable.id } : {}),
    ...(currentSource ? { currentSource } : {}),
    ...(filePreviewFieldIds ? { filePreviewFieldIds } : {}),
  });
};

const requiredPublicId = (ids: ReadonlyMap<string, string>, internalId: string, resource: string): string => {
  const id = ids.get(internalId);
  if (!id) throw new Error(`Missing public ID for ${resource}`);
  return id;
};

export const toPublicGqlResponse = async (response: DslQueryPreviewResponse, deps: { projectIds?: typeof projectPublicIds } = {}) => {
  if (!response.ok) return response;
  const tableIds = [
    ...response.rows.flatMap((row) => (row.tableId ? [row.tableId] : [])),
    ...response.columns.flatMap((column) => (column.tableId ? [column.tableId] : [])),
  ];
  const fieldIds = response.columns.flatMap((column) => (column.fieldId ? [column.fieldId] : []));
  const recordIds = response.rows.flatMap((row) => (row.recordId ? [row.recordId] : []));
  const relationRecordIds = response.rows.flatMap((row) =>
    response.columns.flatMap((column) => {
      if (column.type !== "relation" || (column.sqlType !== "uuid" && column.sqlType !== "uuid[]")) return [];
      const value = row.values[column.key];
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : typeof value === "string"
          ? [value]
          : [];
    }),
  );
  const projectIds = deps.projectIds ?? projectPublicIds;
  const [tables, fields, records] = await Promise.all([
    projectIds("table", tableIds),
    projectIds("field", fieldIds),
    projectIds("record", [...recordIds, ...relationRecordIds]),
  ]);
  const columns = response.columns.map((column) => {
    const fieldId = column.fieldId ? requiredPublicId(fields, column.fieldId, "field") : undefined;
    const tableId = column.tableId ? requiredPublicId(tables, column.tableId, "table") : undefined;
    const key =
      column.fieldId && fieldId && (column.key === column.fieldId || column.key.startsWith(`${column.fieldId}__`))
        ? `${fieldId}${column.key.slice(column.fieldId.length)}`
        : column.key;
    return { ...column, key, ...(tableId ? { tableId } : {}), ...(fieldId ? { fieldId } : {}) };
  });
  return {
    ...response,
    columns,
    rows: response.rows.map((row) => ({
      ...row,
      ...(row.recordId ? { recordId: requiredPublicId(records, row.recordId, "record") } : {}),
      ...(row.tableId ? { tableId: requiredPublicId(tables, row.tableId, "table") } : {}),
      values: Object.fromEntries(
        response.columns.map((column, index) => {
          const value = row.values[column.key];
          const projected =
            column.type === "relation" && (column.sqlType === "uuid" || column.sqlType === "uuid[]")
              ? Array.isArray(value)
                ? value.map((item) => (typeof item === "string" ? requiredPublicId(records, item, "record") : item))
                : typeof value === "string"
                  ? requiredPublicId(records, value, "record")
                  : value
              : value;
          return [columns[index]!.key, projected];
        }),
      ),
    })),
  };
};
