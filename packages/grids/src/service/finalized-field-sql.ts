import { sql } from "bun";
import type { FormulaSqlExpression } from "./formula-sql-values";
import { assertSqlIdentifier } from "./sql-ident";

export const isMissingCapturedCalculationError = (error: unknown): boolean =>
  error instanceof Error && error.message === "grids: missing captured calculation";

export const capturedCalculationJsonSql = (
  fieldId: string,
  recordAlias: string,
  requireCapture = false,
  authorizedTableIds?: ReadonlySet<string>,
): unknown => {
  const row = sql.unsafe(assertSqlIdentifier(recordAlias));
  const value = authorizedFinalizedValueSql(fieldId, sql`${row}.data->${fieldId}`, recordAlias, authorizedTableIds);
  return requireCapture
    ? sql`grids.require_captured_calculation(COALESCE(${row}.finalized_computed_types ? ${fieldId}, false) AND ${row}.data ? ${fieldId}, ${value})`
    : value;
};

/** Unknown legacy provenance is not a grant in a restricted read. */
export const authorizedFinalizedValueSql = (
  fieldId: string,
  value: unknown,
  recordAlias: string,
  authorizedTableIds?: ReadonlySet<string>,
): unknown => {
  if (authorizedTableIds === undefined) return value;
  const row = sql.unsafe(assertSqlIdentifier(recordAlias));
  return sql`CASE WHEN ${row}.finalized_computed_dependencies->${fieldId} <@ ${[...authorizedTableIds]}::jsonb THEN ${value} ELSE NULL END`;
};

/** A finalized record owns its captured value; never evaluate its live expression. */
export const finalizedFieldSql = (
  fieldId: string,
  live: FormulaSqlExpression,
  recordAlias: string,
  authorizedTableIds?: ReadonlySet<string>,
  requireCapture = false,
): FormulaSqlExpression => {
  const row = sql.unsafe(assertSqlIdentifier(recordAlias));
  const text = sql`(${capturedCalculationJsonSql(fieldId, recordAlias, requireCapture, authorizedTableIds)}) #>> '{}'`;
  const stored =
    live.type === "numeric"
      ? sql`(${text})::numeric`
      : live.type === "boolean"
        ? sql`(${text})::boolean`
        : live.type === "date"
          ? sql`(${text})::date`
          : live.type === "datetime"
            ? sql`(${text})::timestamptz`
            : text;
  return {
    type: live.type,
    sql: sql`CASE WHEN ${row}.finalized_at IS NOT NULL THEN ${stored} ELSE ${live.sql} END`,
    ...(live.errorSql === undefined
      ? {}
      : {
          errorSql: sql`CASE WHEN ${row}.finalized_at IS NOT NULL THEN false ELSE ${live.errorSql} END`,
        }),
  };
};
