import { sql } from "bun";
import type { FormulaSqlExpression } from "./formula-sql-values";
import { assertSqlIdentifier } from "./sql-ident";

/** A finalized record owns its captured value; never evaluate its live expression. */
export const finalizedFieldSql = (fieldId: string, live: FormulaSqlExpression, recordAlias: string): FormulaSqlExpression => {
  const row = sql.unsafe(assertSqlIdentifier(recordAlias));
  const text = sql`${row}.data->>${fieldId}`;
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
