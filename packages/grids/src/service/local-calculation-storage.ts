import { sql } from "bun";
import type { SqlClient } from "./audit";
import { mapFieldRow } from "./field-read";
import { capturedCalculationJsonSql, finalizedFieldSql } from "./finalized-field-sql";
import { compileFormulaAstToSql } from "./formula-sql-compiler";
import { type FormulaSqlExpression, joinFormulaSql } from "./formula-sql-values";
import { planLocalCalculations } from "./local-calculations";
import { compileObjectListProjection } from "./object-list-projection";
import type { Field } from "./types";

const identifier = (value: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error("Invalid local calculation alias");
  return sql.unsafe(value);
};

/** A write-time dependency graph: each list/formula provides value and error
 * together, and later steps refer to those columns rather than inlining it. */
export const compileLocalCalculationStorage = (fields: Field[], recordAlias = "r"): unknown => {
  const plan = planLocalCalculations(fields);
  const computed = new Map<string, FormulaSqlExpression>();
  const joins: unknown[] = [];
  const add = (id: string, expression: FormulaSqlExpression) => {
    const alias = identifier(`${recordAlias}_local_${joins.length}`);
    const row = expression.rowSql ?? sql`SELECT ${expression.sql} AS value, ${expression.errorSql ?? sql`false`} AS error`;
    joins.push(sql`CROSS JOIN LATERAL (SELECT value, COALESCE(error, false) AS error FROM (${row}) calculated OFFSET 0) ${alias}`);
    const value = sql`${alias}.value`;
    computed.set(id, { type: expression.type, sql: value, errorSql: sql`${alias}.error` });
  };
  for (const field of plan.objectLists) {
    const compiled = compileObjectListProjection(field, recordAlias);
    if (!compiled.ok) throw new Error(compiled.error);
    add(field.id, compiled.expression);
  }
  for (const step of plan.steps) {
    const compiled = compileFormulaAstToSql(step.ast, {
      fields,
      recordAlias,
      computedFieldSql: computed,
      useFinalizedFormulaValues: false,
    });
    if (!compiled.ok) throw new Error(compiled.error);
    add(step.field.id, compiled.expression);
  }
  // jsonb_object_agg avoids PostgreSQL's function-argument limit for wide tables.
  const object = (entries: unknown[]) =>
    entries.length
      ? sql`(SELECT jsonb_object_agg(k, v) FROM (VALUES ${joinFormulaSql(
          entries.map((entry) => sql`(${entry})`),
          sql`, `,
        )}) pairs(k, v))`
      : sql`'{}'::jsonb`;
  // Normalize heterogeneous values to JSON; decimals stay exact strings.
  const valuePairs = [...computed].map(([id, expression]) => {
    const value =
      expression.type === "numeric"
        ? sql`(${expression.sql})::text`
        : expression.type === "unknown"
          ? sql`(${expression.sql})::jsonb`
          : expression.sql;
    return sql`${id}::text, COALESCE(to_jsonb(${value}), 'null'::jsonb)`;
  });
  const errorPairs = [...computed].map(([id, expression]) => sql`${id}::text, to_jsonb(${expression.errorSql})`);
  return sql`(SELECT jsonb_build_object('signature', ${plan.signature}::text, 'inputs', md5(${identifier(recordAlias)}.data::text), 'values', ${object(valuePairs)}, 'errors', ${object(errorPairs)})
    FROM (SELECT 1) local_seed ${joinFormulaSql(joins, sql` `)})`;
};

export const calculateLocalRecordValues = async (client: SqlClient, fields: Field[], data: Record<string, unknown>): Promise<unknown> => {
  const expression = compileLocalCalculationStorage(fields);
  const [row] = await client<Array<{ calculations: unknown }>>`
    SELECT ${expression} AS calculations FROM (SELECT ${data}::jsonb AS data, NULL::timestamptz AS finalized_at) r`;
  if (!row) throw new Error("Missing local calculation result");
  return row.calculations;
};

/** Caller holds the schema/table write lock. This changes derived state only;
 * user versions, audit events and immutable finalized records remain untouched. */
export const refreshLocalCalculations = async (client: SqlClient, tableId: string): Promise<void> => {
  const [table] = await client<Array<{ kind: string }>>`SELECT kind FROM grids.tables WHERE id = ${tableId}::uuid`;
  if (!table || table.kind !== "stored") return;
  // Backfill includes trash: restoring a table/base must expose current values.
  // Public field readers intentionally hide trashed parents and cannot be used here.
  const rows = await client<Array<Record<string, unknown>>>`SELECT * FROM grids.fields
    WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL ORDER BY position, created_at`;
  const fields = rows.map(mapFieldRow);
  const plan = planLocalCalculations(fields);
  const expression = compileLocalCalculationStorage(fields);
  await client`UPDATE grids.records r SET local_calculations = ${expression}
    WHERE r.table_id = ${tableId}::uuid AND r.finalized_at IS NULL
      AND r.local_calculations->>'signature' IS DISTINCT FROM ${plan.signature}`;
};

/** No live fallback: missing/stale materializations are an invariant failure.
 * Frozen values still use their original provenance and captured types. */
export const storedLocalCalculationSqlMap = (
  fields: Field[],
  options: { recordAlias?: string; authorizedTableIds?: ReadonlySet<string>; requireCapturedValues?: boolean } = {},
): Map<string, FormulaSqlExpression> => {
  const plan = planLocalCalculations(fields);
  const recordAlias = options.recordAlias ?? "r";
  const row = identifier(recordAlias);
  const expressions = new Map<string, FormulaSqlExpression>();
  for (const [id, type] of Object.entries(plan.types)) {
    const source = sql`grids.current_local_calculations(${row}.local_calculations, ${plan.signature}, ${id})`;
    const json = sql`${source}->'values'->${id}`;
    // Unknown scalar formulas contain legitimate nulls. Extract SQL NULL,
    // matching captured scalar values, instead of returning a JSON null value.
    const text = sql`(${json}) #>> '{}'`;
    const value =
      type === "numeric"
        ? sql`(${text})::numeric`
        : type === "boolean"
          ? sql`(${text})::boolean`
          : type === "date"
            ? sql`(${text})::date`
            : type === "datetime"
              ? sql`(${text})::timestamptz`
              : type === "json"
                ? json
                : text;
    const errorSql = sql`COALESCE((${source}->'errors'->>${id})::boolean, false)`;
    expressions.set(
      id,
      plan.objectListIds.has(id)
        ? {
            type: "unknown",
            sql: sql`CASE WHEN ${row}.finalized_at IS NOT NULL THEN ${capturedCalculationJsonSql(id, recordAlias, options.requireCapturedValues, options.authorizedTableIds)} ELSE ${value} END`,
            errorSql: sql`CASE WHEN ${row}.finalized_at IS NOT NULL THEN false ELSE ${errorSql} END`,
          }
        : finalizedFieldSql(id, { sql: value, type, errorSql }, recordAlias, options.authorizedTableIds, options.requireCapturedValues),
    );
  }
  return expressions;
};
