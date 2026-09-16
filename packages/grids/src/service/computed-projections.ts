import type { DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import type { ComputedColumnSpec } from "../contracts";
import { decimalStringToCanonical } from "../formula/numeric";
import { collectFieldRefs, parseFormula } from "../formula/parser";
import { normalizeRefKey } from "../ref-syntax";
import type { SqlClient } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";
import { get as getField, listByTable } from "./field-read";
import { storageOf } from "./field-storage";
import { capturedCalculationJsonSql, finalizedFieldSql } from "./finalized-field-sql";
import {
  compileFormulaFieldToSql,
  compileFormulaSourceToSql,
  type FormulaSqlExpression,
  type FormulaSqlType,
  MAX_FORMULA_INLINE_DEPTH,
} from "./formula-sql-compiler";
import { storedLocalCalculationSqlMap } from "./local-calculation-storage";
import { numericAverageSql } from "./numeric-division-sql";
import { liveRecordParentJoinSql } from "./parent-checks";
import { type ExpansionViewer, resolveReadableTableIds } from "./relation-access";
import { assertSqlIdentifier } from "./sql-ident";
import type { Field, GridRecord } from "./types";

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
  /** An invalid calculated list still exposes its source cells for editing. */
  preserveSourceOnError?: boolean;
  errorSql?: unknown;
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

const withErrorProjection = (projection: ComputedProjection): ComputedProjection =>
  projection.errorSql === undefined
    ? projection
    : {
        ...projection,
        fragment: sql`${projection.fragment}, COALESCE(${projection.errorSql}, false) AS ${sql.unsafe(`e_${projection.alias}`)}`,
      };

/** Maps a projection output type onto the formula-compiler's SQL type system so
 *  GQL can treat lookup/rollup values like any other typed expression. */
export const computedOutputToFormulaType = (output: ComputedProjectionOutputType): FormulaSqlType => {
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
      return "json";
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
  if (type === "json") return "json";
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
  client?: SqlClient,
): Promise<ReadonlySet<string> | undefined> => {
  if (!viewer && !authorizeTable) return undefined;
  // Historical captures can reference tables absent from today's expression.
  // Resolve the Base's candidates once, still respecting narrowed viewers.
  const scope =
    fields[0] && fields.some((field) => ["formula", "lookup", "rollup"].includes(field.type))
      ? await (client ?? sql)<Array<{ id: string }>>`SELECT id::text FROM grids.tables
        WHERE base_id = (SELECT base_id FROM grids.tables WHERE id = ${fields[0].tableId}::uuid) AND deleted_at IS NULL`
      : [];
  const targetTableIds = [...new Set([...computedTargetTableIds(fields), ...scope.map((table) => table.id)])];
  if (authorizeTable) {
    const verdicts = await Promise.all(targetTableIds.map(async (tableId) => ((await authorizeTable(tableId)) ? tableId : null)));
    return new Set(verdicts.filter((tableId): tableId is string => tableId !== null));
  }
  return viewer ? resolveReadableTableIds(targetTableIds, viewer, client) : undefined;
};

type TargetFieldResolver = (id: string) => Promise<Field | null>;

const createTargetFieldResolver = (fieldsById: Map<string, Field>, options: ComputedOptions): TargetFieldResolver => {
  const knownFields = new Map(
    Object.values(options.fieldsByTableId ?? {})
      .flat()
      .map((field) => [field.id, field]),
  );
  const cache = new Map<string, Field | null>();
  return async (id) => {
    const local = fieldsById.get(id);
    if (local) return local;
    const known = knownFields.get(id);
    if (known) return known;
    if (cache.has(id)) return cache.get(id) ?? null;
    const field = await getField(id, options.client);
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

type ComputedOptions = {
  /** Stored rows use transactionally materialized local calculations. Virtual rows stay live. */
  useStoredLocalValues?: boolean;
  /** Query/export evaluation must not turn absent historical captures into incomplete totals. */
  requireCapturedValues?: boolean;
  client?: SqlClient;
  /** Reuse the query's already loaded schema for cross-table dependencies. */
  fieldsByTableId?: Readonly<Record<string, Field[]>>;
  recordAlias?: string;
  authorizedTableIds?: ReadonlySet<string>;
  now?: Date;
  dateConfig?: DateContext;
  /** Internal traversal guard; matches the formula compiler's supported inline depth. */
  stack?: ReadonlySet<string>;
  fieldIds?: ReadonlySet<string>;
};

const formulaComputedDependencies = (root: Field, fields: Field[]): Set<string> => {
  const visited = new Set<string>();
  const needed = new Set<string>();
  const visit = (field: Field) => {
    if (visited.has(field.id)) return;
    visited.add(field.id);
    if (field.type === "lookup" || field.type === "rollup") {
      needed.add(field.id);
      return;
    }
    if (field.type !== "formula" || typeof field.config.expression !== "string") return;
    const parsed = parseFormula(field.config.expression);
    if (!parsed.ok) return;
    for (const ref of collectFieldRefs(parsed.ast)) {
      for (const dependency of fields) {
        if (!dependency.deletedAt && [dependency.shortId, dependency.name].some((key) => normalizeRefKey(key) === normalizeRefKey(ref)))
          visit(dependency);
      }
    }
  };
  visit(root);
  return needed;
};

const targetValue = async (
  field: Field,
  alias: string,
  options: ComputedOptions,
): Promise<{
  sql: unknown;
  errorSql?: unknown;
  outputType: ComputedProjectionOutputType;
} | null> => {
  const descriptor = storageOf(field);
  if (field.type === "object_list" && options.useStoredLocalValues) {
    const fields = options.fieldsByTableId?.[field.tableId] ?? (await listByTable(field.tableId, false, options.client));
    const prepared = storedLocalCalculationSqlMap(fields, { ...options, recordAlias: alias }).get(field.id);
    if (prepared) return { ...prepared, outputType: "json" };
  }
  if (field.type === "formula") {
    const fields = options.fieldsByTableId?.[field.tableId] ?? (await listByTable(field.tableId, false, options.client));
    const computedFieldSql = await buildComputedFieldSqlMap(fields, {
      ...options,
      recordAlias: alias,
      fieldIds: new Set([field.id, ...formulaComputedDependencies(field, fields)]),
    });
    const prepared = computedFieldSql.get(field.id);
    if (prepared) return { ...prepared, outputType: outputTypeForFormula(prepared.type) };
    const compiled = compileFormulaFieldToSql(field, {
      fields,
      recordAlias: alias,
      computedFieldSql,
      authorizedTableIds: options.authorizedTableIds,
      requireCapturedValues: options.requireCapturedValues,
      now: options.now,
      dateConfig: options.dateConfig,
    });
    return compiled.ok ? { ...compiled.expression, outputType: outputTypeForFormula(compiled.expression.type) } : null;
  }
  if (field.type === "lookup" || field.type === "rollup") {
    const fields = options.fieldsByTableId?.[field.tableId] ?? (await listByTable(field.tableId, false, options.client));
    const projections = await buildComputedProjections(fields, { ...options, recordAlias: alias, fieldIds: new Set([field.id]) });
    const projection = projections.find((item) => item.fieldId === field.id);
    return projection ? { sql: projection.expr, errorSql: projection.errorSql, outputType: projection.outputType } : null;
  }
  const projected =
    descriptor.kind === "jsonbArray" || descriptor.kind === "json"
      ? sql`${sql.unsafe(alias)}.data->${field.id}`
      : descriptor.project(field, alias);
  return projected === null ? null : { sql: projected, outputType: lookupOutputType(field) };
};

const buildLookupProjection = async (options: {
  targetTableId: string;
  config: RelationComputedConfig;
  field: Field;
  recordAlias: string;
  resolveTargetField: TargetFieldResolver;
  context: ComputedOptions;
}): Promise<ComputedProjection | null> => {
  const { config, field, recordAlias, resolveTargetField } = options;
  if (!config.relationFieldId || !config.targetFieldId) return null;
  const targetField = await resolveTargetField(config.targetFieldId);
  if (!targetField || targetField.deletedAt || targetField.tableId !== options.targetTableId) return null;

  const targetAlias = `${recordAlias}_t`;
  const value = await targetValue(targetField, targetAlias, options.context);
  if (!value) return null;
  const target = sql.unsafe(targetAlias);
  const source = sql`
       FROM grids.record_links rl
       JOIN grids.records ${target} ON ${target}.id = rl.to_record_id
       ${liveRecordParentJoinSql(targetAlias, "tt", "tb")}
       WHERE rl.from_record_id = ${sql.unsafe(recordAlias)}.id
         AND rl.from_field_id = ${config.relationFieldId}::uuid
         AND ${target}.deleted_at IS NULL
         AND ${target}.table_id = ${targetField.tableId}::uuid
         AND (${value.sql} IS NOT NULL OR ${value.errorSql ?? sql`false`})
       ORDER BY rl.position
       LIMIT 1`;

  const expr = sql`
      (SELECT ${value.sql} ${source})`;
  const alias = lookupAlias(field.id);
  return {
    fieldId: field.id,
    alias,
    outputType: value.outputType,
    ...(value.errorSql === undefined ? {} : { errorSql: sql`COALESCE((SELECT ${value.errorSql} ${source}), false)` }),
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
  targetTableId: string;
  config: RelationComputedConfig;
  field: Field;
  recordAlias: string;
  resolveTargetField: TargetFieldResolver;
  context: ComputedOptions;
}): Promise<ComputedProjection | null> => {
  const { config, field, recordAlias, resolveTargetField } = options;
  if (!config.relationFieldId) return null;
  const alias = rollupAlias(field.id);
  if (config.agg === "count") {
    const targetAlias = `${recordAlias}_t`;
    const target = sql.unsafe(targetAlias);
    const expr = sql`
        (SELECT count(*)::bigint
         FROM grids.record_links rl
         JOIN grids.records ${target} ON ${target}.id = rl.to_record_id
         ${liveRecordParentJoinSql(targetAlias, "tt", "tb")}
         WHERE rl.from_record_id = ${sql.unsafe(recordAlias)}.id
           AND rl.from_field_id = ${config.relationFieldId}::uuid
           AND ${target}.deleted_at IS NULL
           AND ${target}.table_id = ${options.targetTableId}::uuid)`;
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
  if (!targetField || targetField.deletedAt || targetField.tableId !== options.targetTableId) return null;
  const targetAlias = `${recordAlias}_t`;
  const value = await targetValue(targetField, targetAlias, options.context);
  if (!value) return null;
  const numeric = ["numeric", "decimal", "int"].includes(value.outputType);
  if (!numeric && (!(config.agg === "min" || config.agg === "max") || !["text", "date", "timestamptz"].includes(value.outputType)))
    return null;
  const target = sql.unsafe(targetAlias);
  const source = sql`
       FROM grids.record_links rl
       JOIN grids.records ${target} ON ${target}.id = rl.to_record_id
       ${liveRecordParentJoinSql(targetAlias, "tt", "tb")}
       WHERE rl.from_record_id = ${sql.unsafe(recordAlias)}.id
         AND rl.from_field_id = ${config.relationFieldId}::uuid
         AND ${target}.deleted_at IS NULL
         AND ${target}.table_id = ${targetField.tableId}::uuid`;

  const aggregateValue = config.agg === "avg" ? numericAverageSql(value.sql) : sql`${aggregate}(${value.sql})`;
  const expr = sql`(SELECT ${aggregateValue} ${source})`;
  return {
    fieldId: field.id,
    alias,
    outputType: numeric ? "numeric" : value.outputType,
    ...(value.errorSql === undefined ? {} : { errorSql: sql`COALESCE((SELECT bool_or(${value.errorSql}) ${source}), false)` }),
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
 * has the current table's fields; reuse the supplied query schema or fetch
 * missing target fields. Cross-table targets are common in real schemas, so
 * resolving them is necessary so the storage descriptor can project
 * the target field with the same rules as filters, sorts, and
 * aggregates. Without this lookup, cross-table rollup columns were
 * silently skipped.
 */
export const buildComputedProjections = async (fields: Field[], options: ComputedOptions = {}): Promise<ComputedProjection[]> => {
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const out: ComputedProjection[] = [];
  const recordAlias = assertSqlIdentifier(options.recordAlias ?? "r");
  const resolveTargetField = createTargetFieldResolver(fieldsById, options);

  for (const field of fields) {
    if (field.deletedAt) continue;
    if (field.type !== "lookup" && field.type !== "rollup") continue;
    if (options.fieldIds && !options.fieldIds.has(field.id)) continue;
    if (options.stack?.has(field.id) || (options.stack?.size ?? 0) >= MAX_FORMULA_INLINE_DEPTH) continue;
    const context = { ...options, stack: new Set([...(options.stack ?? []), field.id]) };
    const cfg = field.config as RelationComputedConfig;
    if (!cfg.relationFieldId) continue;

    const relationField = fieldsById.get(cfg.relationFieldId);
    if (!relationField || relationField.type !== "relation") continue;
    const targetTableId = (relationField.config as { targetTableId?: string }).targetTableId;
    if (!targetTableId) continue;
    if (options.authorizedTableIds && (!targetTableId || !options.authorizedTableIds.has(targetTableId))) continue;
    const projection =
      field.type === "lookup"
        ? await buildLookupProjection({ config: cfg, field, recordAlias, resolveTargetField, context, targetTableId })
        : await buildRollupProjection({ config: cfg, field, recordAlias, resolveTargetField, context, targetTableId });
    if (projection) {
      const frozen =
        projection.outputType === "json"
          ? sql`CASE WHEN ${sql.unsafe(recordAlias)}.finalized_at IS NOT NULL THEN ${capturedCalculationJsonSql(field.id, recordAlias, options.requireCapturedValues, options.authorizedTableIds)} ELSE ${projection.expr} END`
          : finalizedFieldSql(
              field.id,
              { sql: projection.expr, type: computedOutputToFormulaType(projection.outputType) },
              recordAlias,
              options.authorizedTableIds,
              options.requireCapturedValues,
            ).sql;
      const errorSql =
        projection.errorSql === undefined
          ? undefined
          : sql`CASE WHEN ${sql.unsafe(recordAlias)}.finalized_at IS NOT NULL THEN false ELSE ${projection.errorSql} END`;
      out.push({ ...projection, errorSql, expr: frozen, fragment: sql`${frozen} AS ${sql.unsafe(projection.alias)}` });
    }
  }

  return out.map(withErrorProjection);
};

/**
 * Builds a `fieldId → typed SQL expression` map for lookup/rollup fields and
 * optionally the live formulas owned by a virtual table. These allow
 * the GQL compiler to treat them like any other scalar expression
 * (select / sort / filter / formula operand). Reuses the same correlated
 * subqueries as the records pipeline, so values match exactly.
 */
export const buildComputedFieldSqlMap = async (
  fields: Field[],
  options: ComputedOptions & { useFinalizedFormulaValues?: boolean; finalizedOnly?: boolean } = {},
): Promise<Map<string, FormulaSqlExpression>> => {
  const projections = await buildComputedProjections(fields, options);
  const expressions = new Map<string, FormulaSqlExpression>(
    projections.map((p) => [p.fieldId, { sql: p.expr, errorSql: p.errorSql, type: computedOutputToFormulaType(p.outputType) }]),
  );
  const stored = options.useStoredLocalValues ? storedLocalCalculationSqlMap(fields, options) : new Map<string, FormulaSqlExpression>();
  for (const [fieldId, expression] of stored) {
    if (!options.fieldIds || options.fieldIds.has(fieldId)) expressions.set(fieldId, expression);
  }
  const dependencies = new Map([...expressions, ...stored]);
  // Reuse the same captured-value authorization in projections, predicates and
  // aggregates. Combined rows explicitly opt out of their own frozen formulas.
  for (const field of fields) {
    if (field.deletedAt || field.type !== "formula") continue;
    if (options.fieldIds && !options.fieldIds.has(field.id)) continue;
    if (stored.has(field.id)) continue;
    const compiled = compileFormulaFieldToSql(field, {
      fields,
      recordAlias: options.recordAlias,
      dateConfig: options.dateConfig,
      now: options.now,
      useFinalizedFormulaValues: options.useFinalizedFormulaValues,
      requireCapturedValues: options.requireCapturedValues,
      authorizedTableIds: options.authorizedTableIds,
      computedFieldSql: dependencies,
    });
    if (compiled.ok) expressions.set(field.id, compiled.expression);
  }
  // A finalized-only source never consumes live calculations. Keep the row guard:
  // PostgreSQL may evaluate expressions before applying the source predicate.
  if (options.finalizedOnly && options.useFinalizedFormulaValues !== false) {
    for (const [fieldId, expression] of expressions) {
      const recordAlias = options.recordAlias ?? "r";
      expressions.set(
        fieldId,
        expression.type === "json" || fields.some((field) => field.id === fieldId && field.type === "object_list")
          ? {
              type: "json",
              sql: sql`CASE WHEN ${sql.unsafe(assertSqlIdentifier(recordAlias))}.finalized_at IS NOT NULL THEN ${capturedCalculationJsonSql(fieldId, recordAlias, options.requireCapturedValues, options.authorizedTableIds)} END`,
            }
          : finalizedFieldSql(
              fieldId,
              { type: expression.type, sql: sql`NULL` },
              recordAlias,
              options.authorizedTableIds,
              options.requireCapturedValues,
            ),
      );
    }
  }
  return expressions;
};

/**
 * Emits SQL projections for formula fields that can be represented from
 * the current record row alone. Non-projectable formulas are skipped
 * here; lookup/rollup dependencies are supplied by the computed-field map.
 * Schema authoring validates complete formulas before accepting changes.
 */
export const buildFormulaSqlProjections = (
  fields: Field[],
  options: {
    dateConfig?: DateContext;
    now?: Date;
    recordAlias?: string;
    useFinalizedFormulaValues?: boolean;
    computedFieldSql?: Map<string, FormulaSqlExpression>;
    authorizedTableIds?: ReadonlySet<string>;
  } = {},
): ComputedProjection[] => {
  const out: ComputedProjection[] = [];
  const now = options.now ?? new Date();
  const recordAlias = assertSqlIdentifier(options.recordAlias ?? "r");
  for (const field of fields) {
    if (field.deletedAt) continue;
    const prepared = options.computedFieldSql?.get(field.id);
    if (field.type !== "formula" && !(field.type === "object_list" && prepared)) continue;
    const expression = (field.config as { expression?: unknown }).expression;
    if (!prepared && (typeof expression !== "string" || expression.trim().length === 0)) continue;
    const compiled = prepared
      ? { ok: true as const, expression: prepared }
      : compileFormulaFieldToSql(field, {
          fields,
          computedFieldSql: options.computedFieldSql,
          recordAlias,
          dateConfig: options.dateConfig,
          now,
          useFinalizedFormulaValues: options.useFinalizedFormulaValues,
          authorizedTableIds: options.authorizedTableIds,
        });
    if (!compiled.ok) continue;
    const alias = formulaAlias(field.id);
    out.push({
      fieldId: field.id,
      alias,
      outputType: field.type === "object_list" ? "json" : outputTypeForFormula(compiled.expression.type),
      preserveSourceOnError: field.type === "object_list",
      expr: compiled.expression.sql,
      errorSql: compiled.expression.errorSql,
      fragment: sql`${compiled.expression.sql} AS ${sql.unsafe(alias)}`,
    });
  }
  return out.map(withErrorProjection);
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
  options: {
    dateConfig?: DateContext;
    now?: Date;
    computedFieldSql?: Map<string, FormulaSqlExpression>;
    authorizedTableIds?: ReadonlySet<string>;
  } = {},
): { projections: ComputedProjection[]; sqlColumnIds: Set<string> } => {
  const projections: ComputedProjection[] = [];
  const sqlColumnIds = new Set<string>();
  const now = options.now ?? new Date();
  for (const column of columns ?? []) {
    if (column.expression.trim().length === 0) continue;
    const compiled = compileFormulaSourceToSql(column.expression, {
      documentMetadata: true,
      fields,
      recordAlias: "r",
      computedFieldSql: options.computedFieldSql,
      authorizedTableIds: options.authorizedTableIds,
      dateConfig: options.dateConfig,
      now,
    });
    if (!compiled.ok) continue; // not SQL-projectable → JS evaluator handles it
    const alias = computedColumnAlias(column.id);
    projections.push({
      fieldId: column.id,
      alias,
      outputType: outputTypeForFormula(compiled.expression.type),
      errorSql: compiled.expression.errorSql,
      fragment: sql`${compiled.expression.sql} AS ${sql.unsafe(alias)}`,
    });
    sqlColumnIds.add(column.id);
  }
  return { projections: projections.map(withErrorProjection), sqlColumnIds };
};

export const normalizeProjectionValue = (outputType: ComputedProjectionOutputType, raw: unknown): unknown => {
  switch (outputType) {
    case "decimal":
    case "numeric":
      return decimalProjectionValue(raw);
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
  recordsById: Map<string, Pick<GridRecord, "data" | "fieldErrors">>,
  projections: ComputedProjection[],
  locale?: string,
): void => {
  if (projections.length === 0) return;
  for (const row of rows) {
    const id = row.id as string;
    const rec = recordsById.get(id);
    if (!rec) continue;
    for (const p of projections) {
      if (p.errorSql !== undefined && row[`e_${p.alias}`] === true) {
        if (!p.preserveSourceOnError) rec.data[p.fieldId] = null;
        rec.fieldErrors ??= {};
        rec.fieldErrors[p.fieldId] = getGridsCrudMessages(locale).calculationFailed;
        continue;
      }
      const raw = row[p.alias];
      if (raw === null || raw === undefined) {
        rec.data[p.fieldId] = null;
        continue;
      }
      rec.data[p.fieldId] = normalizeProjectionValue(p.outputType, raw);
    }
  }
};
