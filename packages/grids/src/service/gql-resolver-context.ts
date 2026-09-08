import { sql } from "bun";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import type { DslResolverContext, DslTableSource, DslViewSource } from "../query-dsl/resolver";
import { resolveDslQueryToRecordQuery } from "../query-dsl/resolver";
import { collectDslFieldTableIds, needsDslViewCatalog } from "../query-dsl/source-plan";
import type { DslQueryAst } from "../query-dsl/types";
import type { SqlClient } from "./audit";
import * as fields from "./fields";
import * as tables from "./tables";
import type { Field } from "./types";

type DbRow = Record<string, unknown>;

const loadBaseGqlDslViews = async (baseId: string, client: SqlClient = sql): Promise<DslViewSource[]> => {
  const rows = await client<DbRow[]>`
    SELECT v.id, v.short_id, v.name, v.table_id, v.source
    FROM grids.views v
    JOIN grids.tables t ON t.id = v.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE t.base_id = ${baseId}::uuid
      AND v.deleted_at IS NULL
    ORDER BY v.position, v.created_at
  `;
  return rows.map((row) => ({
    kind: "view" as const,
    id: row.id as string,
    shortId: row.short_id as string,
    name: row.name as string,
    tableId: row.table_id as string,
    source: row.source as string,
    query: {},
  }));
};

type TrustedGqlResolverContextLoaders = {
  listTablesByBase: typeof tables.listByBase;
  listFieldsByTables: typeof fields.listByTables;
  listViewsByBase: typeof loadBaseGqlDslViews;
};

const defaultLoaders: TrustedGqlResolverContextLoaders = {
  listTablesByBase: tables.listByBase,
  listFieldsByTables: fields.listByTables,
  listViewsByBase: loadBaseGqlDslViews,
};

const transactionLoaders = (client: SqlClient): TrustedGqlResolverContextLoaders => ({
  listTablesByBase: (baseId) => tables.listByBase(baseId, { client }),
  listFieldsByTables: (tableIds) => fields.listByTables(tableIds, client),
  listViewsByBase: (baseId) => loadBaseGqlDslViews(baseId, client),
});

export const hydrateDslViewQueries = (params: {
  tables: DslTableSource[];
  views: DslViewSource[];
  fieldsByTableId: Record<string, Field[]>;
}): DslViewSource[] =>
  params.views.flatMap((view) => {
    if (!view.source) return [view];
    const parsed = parseGridsQueryDsl(view.source);
    if (!parsed.ok) return [];
    const currentTable = params.tables.find((table) => table.id === view.tableId);
    const resolved = resolveDslQueryToRecordQuery(parsed.ast, {
      ...(currentTable ? { currentTable } : {}),
      tables: params.tables,
      views: [],
      fieldsByTableId: params.fieldsByTableId,
    });
    // A View reference must preserve its complete saved scope. Some valid
    // standalone GQL plans cannot be represented by nested RecordQuery sources;
    // keep those unavailable instead of silently falling back to the whole table.
    return resolved.ok ? [{ ...view, query: resolved.plan.query }] : [];
  });

export const buildTrustedGqlResolverContext = async (
  params: {
    baseId: string;
    currentTableId?: string;
    ast: DslQueryAst;
    purpose: "custom-app-render" | "document-template-render" | "saved-view-render";
    client?: SqlClient;
  },
  loaders: TrustedGqlResolverContextLoaders = params.client ? transactionLoaders(params.client) : defaultLoaders,
): Promise<DslResolverContext> => {
  void params.purpose;
  const baseTables = await loaders.listTablesByBase(params.baseId);
  const dslTables: DslTableSource[] = baseTables.map((table) => ({
    kind: "table",
    id: table.id,
    shortId: table.shortId,
    name: table.name,
  }));
  const viewsCatalog = needsDslViewCatalog(params.ast) ? await loaders.listViewsByBase(params.baseId) : [];
  const currentTable = params.currentTableId ? dslTables.find((table) => table.id === params.currentTableId) : undefined;
  const fieldTableIds =
    viewsCatalog.length > 0
      ? dslTables.map((table) => table.id)
      : collectDslFieldTableIds({
          ast: params.ast,
          currentTableId: params.currentTableId,
          tables: dslTables,
          views: viewsCatalog,
        });
  const fieldGroups = await loaders.listFieldsByTables(fieldTableIds);
  const fieldsByTableId = Object.fromEntries(fieldTableIds.map((tableId) => [tableId, fieldGroups.get(tableId) ?? []])) as Record<
    string,
    Field[]
  >;
  const views = hydrateDslViewQueries({ tables: dslTables, views: viewsCatalog, fieldsByTableId });

  return {
    ...(currentTable ? { currentTable } : {}),
    tables: dslTables,
    views,
    fieldsByTableId,
  };
};
