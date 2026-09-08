import type { DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import type { ComputedColumnSpec } from "../contracts";
import { decimalStringToCanonical } from "../formula/numeric";
import type { SqlClient } from "./audit";
import { get as getField } from "./field-read";
import { storageOf } from "./field-storage";
import { compileFormulaSourceToSql, type FormulaSqlExpression, type FormulaSqlType } from "./formula-sql-compiler";
import { liveRecordParentJoinSql } from "./parent-checks";
import { type ExpansionViewer, resolveReadableTableIds } from "./relation-access";
import { assertSqlIdentifier } from "./sql-ident";
import type { Field } from "./types";

/**
 * Per-row SELECT-list projections for lookup and rollup fields.
 *
 * These values are part of the main records query as correlated subqueries
 * over the `record_links` junction:
 *
 *  - One query per page instead of per-field follow-up queries.
 *  - Single source of truth — no JS/SQL drift between filter scope and
 *    enrichment scope.
 *  - Filter / sort / group on lookup-rollup values becomes a tractable
 *    extension (the values are already real columns in the result set).
 *
 * Each projection is an independent correlated subquery rather than a
 * LEFT JOIN; that lets us mix any number of lookup/rollup fields on a
 * row without combinatorial join blow-up. Postgres' per-row evaluation
 * of correlated subqueries is fine here: relation cardinalities are
 * small (records typically link to 0–10 targets) and `record_links`
 * has the (from_record_id, from_field_id, position) index that makes
 * each subquery a tiny index scan.
 */

type ComputedProjectionOutputType = "text" | "numeric" | "decimal" | "int" | "date" | "timestamptz" | "boolean" | "json";

export type ComputedProjection = {
  /** The lookup/rollup field whose value this projection produces. */
  fieldId: string;
  /** SQL alias under which the value is exposed in the SELECT list. */
  alias: string;
  /** Effective output type — used to normalize bun-sql values into JSON-safe record.data. */
  outputType: ComputedProjectionOutputType;
  /** Bare projection expression (no `AS alias`) over base record alias `r`.
   *  Set for lookup/rollup; reusable wherever a scalar expression is needed
   *  (GQL select/sort/filter/formula operand). */
  expr?: any;
  /** The full SQL fragment to embed AFTER `r.*,` in the SELECT list. */
  fragment: any;
};

/** Maps a projection output type onto the formula-compiler's SQL type system so
 *  GQL can treat lookup/rollup values like any other typed expression. */
const computedOutputToFormulaType = (output: ComputedProjectionOutputType): FormulaSqlType => {
  switch (output) {
    case "numeric":
    case "decimal":
    case "int":
      return "numeric";
    case "date":
      return "date";
    case "timestamptz":
      return "datetime";
    case "boolean":
      return "boolean";
    case "json":
      return "unknown";
    default:
      return "text";
  }
};

const lookupAlias = (fieldId: string): string => `lkp_${fieldId.replace(/-/g, "")}`;
const rollupAlias = (fieldId: string): string => `rlp_${fieldId.replace(/-/g, "")}`;
const formulaAlias = (fieldId: string): string => `fml_${fieldId.replace(/-/g, "")}`;

const stableAliasHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const computedColumnAlias = (columnId: string): string => {
  const slug = columnId
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 32);
  return `ccl_${slug}_${stableAliasHash(columnId)}`;
};

const outputTypeForFormula = (type: FormulaSqlType): ComputedProjection["outputType"] => {
  if (type === "numeric") return "decimal";
  if (type === "date") return "date";
  if (type === "datetime") return "timestamptz";
  if (type === "boolean") return "boolean";
  return "text";
};

const decimalProjectionValue = (raw: unknown): string | null => {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const value = String(raw);
  return decimalStringToCanonical(value) ?? value;
};

type RelationComputedConfig = {
  relationFieldId?: string;
  targetFieldId?: string;
  agg?: "count" | "sum" | "avg" | "min" | "max";
};

const computedTargetTableIds = (fields: Field[]): string[] => {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  return fields.flatMap((field) => {
    if (field.deletedAt || (field.type !== "lookup" && field.type !== "rollup")) return [];
    const relationFieldId = (field.config as RelationComputedConfig).relationFieldId;
    const relationField = relationFieldId ? fieldsById.get(relationFieldId) : null;
    if (!relationField || relationField.type !== "relation" || relationField.deletedAt) return [];
    const targetTableId = (relationField.config as { targetTableId?: string }).targetTableId;
    return targetTableId ? [targetTableId] : [];
  });
};

export const readableComputedTargetTableIds = async (
  fields: Field[],
  viewer?: ExpansionViewer,
  authorizeTable?: (tableId: string) => Promise<boolean>,
): Promise<ReadonlySet<string> | undefined> => {
  const targetTableIds = [...new Set(computedTargetTableIds(fields))];
  if (authorizeTable) {
    const verdicts = await Promise.all(targetTableIds.map(async (tableId) => ((await authorizeTable(tableId)) ? tableId : null)));
    return new Set(verdicts.filter((tableId): tableId is string => tableId !== null));
  }
  return viewer ? resolveReadableTableIds(targetTableIds, viewer) : undefined;
};

type TargetFieldResolver = (id: string) => Promise<Field | null>;

const createTargetFieldResolver = (fieldsById: Map<string, Field>, client?: SqlClient): TargetFieldResolver => {
  const cache = new Map<string, Field | null>();
  return async (id) => {
    const local = fieldsById.get(id);
    if (local) return local;
    if (cache.has(id)) return cache.get(id) ?? null;
    const field = await getField(id, client);
    cache.set(id, field);
    return field;
  };
};

const lookupOutputType = (field: Field): ComputedProjectionOutputType => {
  const kind = storageOf(field).kind;
  if (kind === "numeric") return "numeric";
  if (kind === "date") return (field.config as { includeTime?: boolean }).includeTime ? "timestamptz" : "date";
  if (kind === "datetime") return "timestamptz";
  if (kind === "boolean") return "boolean";
  if (kind === "jsonbArray" || kind === "json") return "json";
  return "text";
};

const buildLookupProjection = async (options: {
  config: RelationComputedConfig;
  field: Field;
  recordAlias: string;
  resolveTargetField: TargetFieldResolver;
}): Promise<ComputedProjection | null> => {
  const { config, field, recordAlias, resolveTargetField } = options;
  if (!config.relationFieldId || !config.targetFieldId) return null;
  const targetField = await resolveTargetField(config.targetFieldId);
  if (!targetField || targetField.deletedAt) return null;

  const descriptor = storageOf(targetField);
  const projected =
    descriptor.kind === "jsonbArray" || descriptor.kind === "json"
      ? sql`t.data->${config.targetFieldId}`
      : descriptor.project(targetField, "t");
  if (!projected) return null;

  const expr = sql`
      (SELECT ${projected}
       FROM grids.record_links rl
       JOIN grids.records t ON t.id = rl.to_record_id
       ${liveRecordParentJoinSql("t", "tt", "tb")}
       WHERE rl.from_record_id = ${sql.unsafe(recordAlias)}.id
         AND rl.from_field_id = ${config.relationFieldId}::uuid
         AND t.deleted_at IS NULL
         AND t.data->${config.targetFieldId} IS NOT NULL
       ORDER BY rl.position
       LIMIT 1)`;
  const alias = lookupAlias(field.id);
  return {
    fieldId: field.id,
    alias,
    outputType: lookupOutputType(targetField),
    expr,
    fragment: sql`${expr} AS ${sql.unsafe(alias)}`,
  };
};

const rollupAggregateSql = (agg: RelationComputedConfig["agg"]): unknown | null => {
  if (agg === "sum") return sql`SUM`;
  if (agg === "avg") return sql`AVG`;
  if (agg === "min") return sql`MIN`;
  if (agg === "max") return sql`MAX`;
  return null;
};

const buildRollupProjection = async (options: {
  config: RelationComputedConfig;
  field: Field;
  recordAlias: string;
  resolveTargetField: TargetFieldResolver;
}): Promise<ComputedProjection | null> => {
  const { config, field, recordAlias, resolveTargetField } = options;
  if (!config.relationFieldId) return null;
  const alias = rollupAlias(field.id);
  if (config.agg === "count") {
    const expr = sql`
        (SELECT count(*)::bigint
         FROM grids.record_links rl
         JOIN grids.records t ON t.id = rl.to_record_id
         ${liveRecordParentJoinSql("t", "tt", "tb")}
         WHERE rl.from_record_id = ${sql.unsafe(recordAlias)}.id
           AND rl.from_field_id = ${config.relationFieldId}::uuid
           AND t.deleted_at IS NULL)`;
    return {
      fieldId: field.id,
      alias,
      outputType: "int",
      expr,
      fragment: sql`${expr} AS ${sql.unsafe(alias)}`,
    };
  }

  if (!config.targetFieldId) return null;
  const aggregate = rollupAggregateSql(config.agg);
  if (!aggregate) return null;
  const targetField = await resolveTargetField(config.targetFieldId);
  if (!targetField || targetField.deletedAt) return null;
  const targetProjection = storageOf(targetField).project(targetField, "t");
  if (!targetProjection) return null;

  const expr = sql`
      (SELECT ${aggregate}(${targetProjection})
       FROM grids.record_links rl
       JOIN grids.records t ON t.id = rl.to_record_id
       ${liveRecordParentJoinSql("t", "tt", "tb")}
       WHERE rl.from_record_id = ${sql.unsafe(recordAlias)}.id
         AND rl.from_field_id = ${config.relationFieldId}::uuid
         AND t.deleted_at IS NULL)`;
  return {
    fieldId: field.id,
    alias,
    outputType: "numeric",
    expr,
    fragment: sql`${expr} AS ${sql.unsafe(alias)}`,
  };
};

/**
 * Walks the fields list and emits a projection per lookup/rollup that
 * has a complete config. Incomplete fields (config missing
 * relationFieldId / targetFieldId / agg) are silently skipped — the
 * UI lets users add the field first and configure later, so a partial
 * config is a normal intermediate state, not an error.
 *
 * Async because rollup/lookup `targetFieldId` lives on a DIFFERENT
 * table (the relation's target). The source-field list passed in only
 * has the current table's fields; we fetch missing target fields
 * one by one. Cross-table targets are common in real schemas, so
 * resolving them is necessary so the storage descriptor can project
 * the target field with the same rules as filters, sorts, and
 * aggregates. Without this lookup, cross-table rollup columns were
 * silently skipped.
 */
export const buildComputedProjections = async (
  fields: Field[],
  options: {
    client?: SqlClient;
    recordAlias?: string;
    authorizedTableIds?: ReadonlySet<string>;
  } = {},
): Promise<ComputedProjection[]> => {
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const out: ComputedProjection[] = [];
  const recordAlias = assertSqlIdentifier(options.recordAlias ?? "r");
  const resolveTargetField = createTargetFieldResolver(fieldsById, options.client);

  for (const field of fields) {
    if (field.deletedAt) continue;
    if (field.type !== "lookup" && field.type !== "rollup") continue;
    const cfg = field.config as RelationComputedConfig;
    if (!cfg.relationFieldId) continue;

    const relationField = fieldsById.get(cfg.relationFieldId);
    if (!relationField || relationField.type !== "relation") continue;
    const targetTableId = (relationField.config as { targetTableId?: string }).targetTableId;
    if (options.authorizedTableIds && (!targetTableId || !options.authorizedTableIds.has(targetTableId))) continue;
    const projection =
      field.type === "lookup"
        ? await buildLookupProjection({ config: cfg, field, recordAlias, resolveTargetField })
        : await buildRollupProjection({ config: cfg, field, recordAlias, resolveTargetField });
    if (projection) out.push(projection);
  }

  return out;
};

/**
 * Builds a `fieldId → typed SQL expression` map for the lookup/rollup fields on
 * a table, for the GQL compiler to treat them like any other scalar expression
 * (select / sort / filter / formula operand). Reuses the same correlated
 * subqueries as the records pipeline, so values match exactly.
 */
export const buildComputedFieldSqlMap = async (
  fields: Field[],
  options: {
    client?: SqlClient;
    recordAlias?: string;
    authorizedTableIds?: ReadonlySet<string>;
  } = {},
): Promise<Map<string, FormulaSqlExpression>> => {
  const projections = await buildComputedProjections(fields, options);
  return new Map(projections.map((p) => [p.fieldId, { sql: p.expr, type: computedOutputToFormulaType(p.outputType) }]));
};

/**
 * Emits SQL projections for formula fields that can be represented from
 * the current record row alone. Non-projectable formulas are skipped
 * deliberately; the read path keeps the JS evaluator as a compatibility
 * fallback for formulas that reference relations, lookup/rollup values,
 * select arrays, files, or other formula fields.
 */
export const buildFormulaSqlProjections = (
  fields: Field[],
  options: { dateConfig?: DateContext; now?: Date; recordAlias?: string } = {},
): ComputedProjection[] => {
  const out: ComputedProjection[] = [];
  const now = options.now ?? new Date();
  const recordAlias = assertSqlIdentifier(options.recordAlias ?? "r");
  for (const field of fields) {
    if (field.deletedAt || field.type !== "formula") continue;
    const expression = (field.config as { expression?: unknown }).expression;
    if (typeof expression !== "string" || expression.trim().length === 0) continue;
    const compiled = compileFormulaSourceToSql(expression, {
      fields,
      recordAlias,
      dateConfig: options.dateConfig,
      now,
    });
    if (!compiled.ok) continue;
    const alias = formulaAlias(field.id);
    out.push({
      fieldId: field.id,
      alias,
      outputType: outputTypeForFormula(compiled.expression.type),
      expr: compiled.expression.sql,
      fragment: sql`${compiled.expression.sql} AS ${sql.unsafe(alias)}`,
    });
  }
  return out;
};

/**
 * SQL projections for view-level computed columns (`ComputedColumnSpec`).
 *
 * These are the same display-formula expressions the GQL preview compiles
 * to SQL. Evaluating them in SQL here too — instead of the post-query JS
 * evaluator — makes a saved view's computed cell render identically to its
 * GQL preview, and gives one consistent semantics (NULLIF-guarded division,
 * `IS NOT DISTINCT FROM` equality, decimal-safe numerics). Columns whose
 * expression cannot project to SQL (e.g. references to relation / select /
 * lookup values) return in `jsColumnIds` for the JS fallback.
 */
export const buildComputedColumnSqlProjections = (
  columns: ComputedColumnSpec[] | undefined,
  fields: Field[],
  options: { dateConfig?: DateContext; now?: Date } = {},
): { projections: ComputedProjection[]; sqlColumnIds: Set<string> } => {
  const projections: ComputedProjection[] = [];
  const sqlColumnIds = new Set<string>();
  const now = options.now ?? new Date();
  for (const column of columns ?? []) {
    if (column.expression.trim().length === 0) continue;
    const compiled = compileFormulaSourceToSql(column.expression, {
      fields,
      recordAlias: "r",
      dateConfig: options.dateConfig,
      now,
    });
    if (!compiled.ok) continue; // not SQL-projectable → JS evaluator handles it
    const alias = computedColumnAlias(column.id);
    projections.push({
      fieldId: column.id,
      alias,
      outputType: outputTypeForFormula(compiled.expression.type),
      fragment: sql`${compiled.expression.sql} AS ${sql.unsafe(alias)}`,
    });
    sqlColumnIds.add(column.id);
  }
  return { projections, sqlColumnIds };
};

const normalizeProjectionValue = (outputType: ComputedProjectionOutputType, raw: unknown): unknown => {
  switch (outputType) {
    case "decimal":
      return decimalProjectionValue(raw);
    case "numeric":
    case "int": {
      const value = typeof raw === "number" ? raw : Number(raw as string);
      return Number.isFinite(value) ? value : null;
    }
    case "date":
      return raw instanceof Date ? raw.toISOString().slice(0, 10) : raw;
    case "timestamptz":
      return raw instanceof Date ? raw.toISOString() : raw;
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      return null;
    default:
      return raw;
  }
};

/**
 * Reads the computed-column values from a result row and merges them
 * into `record.data` under the lookup/rollup field's id. After this,
 * downstream code can treat the value as if it lived in JSONB.
 */
export const applyComputedProjections = (
  rows: Array<Record<string, unknown>>,
  recordsById: Map<string, { data: Record<string, unknown> }>,
  projections: ComputedProjection[],
): void => {
  if (projections.length === 0) return;
  for (const row of rows) {
    const id = row.id as string;
    const rec = recordsById.get(id);
    if (!rec) continue;
    for (const p of projections) {
      const raw = row[p.alias];
      if (raw === null || raw === undefined) {
        rec.data[p.fieldId] = null;
        continue;
      }
      rec.data[p.fieldId] = normalizeProjectionValue(p.outputType, raw);
    }
  }
};
