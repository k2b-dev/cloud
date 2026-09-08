import type { FormulaSqlExpression, FormulaSqlType } from "../service/formula-sql-compiler";
import type { Field } from "../service/types";

export type DslSqlOutputColumn = {
  key: string;
  label: string;
  tableId: string;
  fieldId?: string;
  joinAlias?: string;
  type: string;
  sqlType: FormulaSqlType | "json";
};

export type DslSqlCompileOptions = {
  fieldsByTableId: Record<string, Field[]>;
  /** Physical row source for the base table. Stored tables omit this and keep
   * the direct grids.records fast path. Combined tables provide one guarded,
   * canonical SQL relation with the same record shape. */
  recordSource?: DslSqlRecordSource;
  /** Federated row sources for joined target tables, keyed by canonical table id. */
  recordSourcesByTableId?: Map<string, DslSqlRecordSource>;
  timeZone?: string;
  /** Null omits an inner grouped-source limit; outer result pages remain bounded. */
  limit?: number | null;
  offset?: number;
  cursorValues?: unknown[];
  /** Offset decoded from a server-signed cursor when a keyset token would be too large. */
  cursorOffset?: number;
  joinFanoutLimit?: number;
  /** Pre-compiled full-text search predicate built asynchronously by the caller. */
  searchClause?: unknown;
  /** Pre-built SQL for lookup/rollup fields by field id. */
  computedFieldSql?: Map<string, FormulaSqlExpression>;
  /** Pre-built lookup/rollup SQL for joined scopes by GQL join alias. */
  computedFieldSqlByJoinAlias?: Map<string, Map<string, FormulaSqlExpression>>;
  /** Pre-compiled search predicate for the saved view used as source. */
  viewSourceSearchClause?: unknown;
};

type DslSqlStoredRecordSource = {
  kind: "stored";
  relation: unknown;
  tableId: string;
  relationMappings: [];
};

export type DslSqlFederatedRecordSource = {
  kind: "federated";
  relation: unknown;
  tableId: string;
  revision: number;
  revisionId: string;
  revisionToken: string;
  sourceTableIds: string[];
  relationMappings: Array<{ targetFieldId: string; sourceTableId: string; sourceFieldId: string }>;
};

export type DslSqlRecordSource = DslSqlStoredRecordSource | DslSqlFederatedRecordSource;

export type DslSqlCompiledQuery = {
  sql: unknown;
  columns: DslSqlOutputColumn[];
  joinAliases: Record<string, string>;
  limit: number;
  offset: number;
  cursorValuesFromRow: (row: Record<string, unknown>) => unknown[];
};

export type DslSqlCompileResult = { ok: true; query: DslSqlCompiledQuery } | { ok: false; error: string };

export type DslSqlGroupOutputColumn =
  | {
      kind: "group";
      key: string;
      label: string;
      fieldId: string;
      tableId?: string;
      type: string;
      sqlType: DslSqlOutputColumn["sqlType"];
    }
  | {
      kind: "aggregate";
      key: string;
      label: string;
      fieldId: string | "*";
      agg: string;
      sqlType: FormulaSqlType;
    };

type DslSqlCompiledGroupQuery = {
  sql: unknown;
  columns: DslSqlGroupOutputColumn[];
  limit: number | null;
  offset: number;
  cursorable: boolean;
  cursorValuesFromRow?: (row: Record<string, unknown>) => unknown[];
};

export type DslSqlGroupCompileResult = { ok: true; query: DslSqlCompiledGroupQuery } | { ok: false; error: string };

export type DslSqlAggregateOutputColumn = {
  key: string;
  label: string;
  fieldId: string | "*";
  agg: string;
  sqlType: FormulaSqlType;
};

type DslSqlCompiledAggregateQuery = {
  sql: unknown;
  columns: DslSqlAggregateOutputColumn[];
  limit: 1;
  offset: 0;
};

export type DslSqlAggregateCompileResult = { ok: true; query: DslSqlCompiledAggregateQuery } | { ok: false; error: string };

export const dslSqlOffset = (options: DslSqlCompileOptions, planOffset = 0): number => {
  if (options.cursorValues) return 0;
  if (options.cursorOffset !== undefined) return Math.max(options.cursorOffset, 0);
  return Math.min(Math.max(options.offset ?? planOffset, 0), 10_000);
};
