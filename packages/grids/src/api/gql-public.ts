import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import {
  DslQueryAutocompleteBodySchema,
  DslQueryCompileViewBodySchema,
  DslQueryExecuteBodySchema,
  DslQueryPreviewBodySchema,
  DslQueryPreviewResponseSchema,
  ShortIdSchema,
} from "../contracts";
import { type DslQueryContextInput, type DslQueryParameterValue, GqlParametersSchema } from "../query-dsl/parameters";
import { gridsService } from "../service";
import type { DslCurrentSource } from "./gql-runtime";
import { apiMessagesForLocale } from "./messages";

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

// Names use the same namespace as GQL autocomplete. Values are data, never
// expression source or trusted auth/page context. Literal text shares GQL's
// 20,000-character source budget; membership lists share its 10,000-row cap.
export const PublicGqlParametersSchema = GqlParametersSchema;

export const publicGqlParameterContext = (parameters?: z.infer<typeof PublicGqlParametersSchema>): DslQueryContextInput => {
  const context: Partial<Record<`params.${string}`, DslQueryParameterValue>> = {};
  for (const [name, value] of Object.entries(parameters ?? {})) context[`params.${name}`] = value;
  return context;
};

export const PublicDslQueryPreviewBodySchema = DslQueryPreviewBodySchema.omit({ currentTableId: true, currentSource: true }).extend({
  ...publicScope,
  parameters: PublicGqlParametersSchema.optional(),
});
export const PublicDslQueryExecuteBodySchema = DslQueryExecuteBodySchema.omit({
  currentTableId: true,
  currentSource: true,
  filePreviewFieldIds: true,
}).extend({
  ...publicScope,
  parameters: PublicGqlParametersSchema.optional(),
  filePreviewFieldIds: z.array(ShortIdSchema).max(3).optional(),
});
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
  locale?: string;
};

export const fromPublicGqlScope = async (
  baseId: string,
  input: PublicGqlScope,
  deps: GqlPublicDeps = {},
): Promise<Result<{ currentTableId?: string; currentSource?: DslCurrentSource; filePreviewFieldIds?: string[] }>> => {
  const t = apiMessagesForLocale(deps.locale);
  const getTableByShortId = deps.getTableByShortId ?? gridsService.table.getByShortId;
  const getViewByShortId = deps.getViewByShortId ?? gridsService.view.getByShortId;
  const getTable = deps.getTable ?? gridsService.table.get;
  const currentTable = input.currentTableId ? await getTableByShortId(input.currentTableId) : null;
  if (input.currentTableId && (!currentTable || currentTable.baseId !== baseId))
    return fail({ ...err.notFound("Table"), message: t.tableNotFound });

  let currentSource: DslCurrentSource;
  let sourceTable = currentTable;
  if (input.currentSource?.kind === "table") {
    const table = await getTableByShortId(input.currentSource.tableId);
    if (!table || table.baseId !== baseId) return fail({ ...err.notFound("Table"), message: t.tableNotFound });
    currentSource = { kind: "table", tableId: table.id };
    sourceTable = table;
  } else if (input.currentSource?.kind === "view") {
    const view = await getViewByShortId(input.currentSource.viewId);
    const table = view ? await getTable(view.tableId) : null;
    if (!view || !table || table.baseId !== baseId) return fail({ ...err.notFound("View"), message: t.viewNotFound });
    currentSource = { kind: "view", viewId: view.id };
    sourceTable = table;
  }

  let filePreviewFieldIds: string[] | undefined;
  if (input.filePreviewFieldIds) {
    if (!sourceTable) return fail(err.badInput(t.filePreviewNeedsTable));
    const fields = await (deps.listFields ?? gridsService.field.listByTable)(sourceTable.id);
    const byPublicId = new Map(fields.map((field) => [field.shortId, field.id]));
    const ids = input.filePreviewFieldIds.map((id) => byPublicId.get(id));
    if (ids.some((id) => !id)) return fail(err.badInput(t.unknownFieldId));
    filePreviewFieldIds = ids.filter((id): id is string => Boolean(id));
  }
  return ok({
    ...(currentTable ? { currentTableId: currentTable.id } : {}),
    ...(currentSource ? { currentSource } : {}),
    ...(filePreviewFieldIds ? { filePreviewFieldIds } : {}),
  });
};
