import { sql } from "bun";
import type { FormulaSqlExpression } from "./formula-sql-values";

/** The database helpers catch only arithmetic domain errors, never resource failures. */
export const formulaNumericResult = (value: unknown, present: unknown): FormulaSqlExpression => {
  const errorSql = sql`(${present} AND ${value} IS NULL)`;
  const rowSql = sql`SELECT calculation.value, (${present} AND calculation.value IS NULL) AS error
    FROM (SELECT ${value} AS value OFFSET 0) calculation OFFSET 0`;
  return { type: "numeric", sql: value, errorSql, rowSql };
};

export const formulaNumericOperation = (operation: string, left: unknown, right: unknown = sql`NULL::numeric`): FormulaSqlExpression =>
  formulaNumericResult(
    sql`grids.try_formula_numeric(${operation}, ${left}, ${right})`,
    operation === "floor" || operation === "ceil" ? sql`${left} IS NOT NULL` : sql`(${left} IS NOT NULL AND ${right} IS NOT NULL)`,
  );

export const formulaNumericAggregate = (operation: string, values: unknown, emptyZero = false): FormulaSqlExpression => {
  const rowSql = sql`SELECT CASE WHEN ${emptyZero} AND cardinality(input.values) = 0 THEN 0::numeric ELSE output.value END AS value,
    (cardinality(input.values) > 0 AND output.value IS NULL) AS error
    FROM (SELECT array_remove(${values}, NULL) AS values OFFSET 0) input
    CROSS JOIN LATERAL (SELECT grids.try_formula_numeric_aggregate(${operation}, input.values) AS value OFFSET 0) output OFFSET 0`;
  return {
    type: "numeric",
    sql: sql`(SELECT value FROM (${rowSql}) aggregate_result)`,
    errorSql: sql`(SELECT error FROM (${rowSql}) aggregate_result)`,
    rowSql,
  };
};

/** Preserve inherited errors without discarding a jointly evaluated value/error row. */
export const withFormulaErrors = (expression: FormulaSqlExpression, inherited: unknown | undefined): FormulaSqlExpression => {
  if (inherited === undefined) return expression;
  const errorSql = expression.errorSql === undefined ? inherited : sql`(${inherited} OR ${expression.errorSql})`;
  return {
    type: expression.type,
    sql: sql`CASE WHEN ${errorSql} THEN NULL ELSE ${expression.sql} END`,
    errorSql,
    ...(expression.rowSql === undefined
      ? {}
      : {
          rowSql: sql`SELECT CASE WHEN ${inherited} THEN NULL ELSE calculation.value END AS value,
        (${inherited} OR calculation.error) AS error FROM (${expression.rowSql}) calculation OFFSET 0`,
        }),
  };
};
