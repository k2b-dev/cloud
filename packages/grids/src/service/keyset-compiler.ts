import { sql } from "bun";
import { validateFilterValue } from "./filter-compiler-validation";
import type { FormulaSqlType } from "./formula-sql-compiler";

const joinSql = (parts: unknown[], separator: unknown): unknown =>
  parts.slice(1).reduce((result, part) => sql`${result}${separator}${part}`, parts[0]!);

export type DslKeysetType = FormulaSqlType | "uuid";

export type DslKeysetColumn = {
  expression: unknown;
  type: DslKeysetType;
  direction: "asc" | "desc";
  nullsFirst?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

const validNumeric = (value: unknown): boolean => {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string" || !NUMBER.test(value)) return false;
  const [mantissa = "", exponentText = "0"] = value.replace(/^-/, "").toLowerCase().split("e");
  const [integer = "", fraction = ""] = mantissa.split(".");
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent)) return false;
  const firstDigit = `${integer}${fraction}`.search(/[1-9]/);
  const integerDigits = Math.max(0, integer.length + exponent - Math.max(0, firstDigit));
  // PostgreSQL's unconstrained numeric storage limits, not application precision.
  // https://www.postgresql.org/docs/current/datatype-numeric.html
  return integerDigits <= 131_072 && Math.max(0, fraction.length - exponent) <= 16_383;
};

const validValue = (type: DslKeysetType, value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  switch (type) {
    case "numeric":
      return validNumeric(value);
    case "boolean":
      return typeof value === "boolean";
    case "date":
      return validateFilterValue("date", "=", value, false) === null;
    case "datetime":
      return validateFilterValue("date", "=", value, true) === null;
    case "uuid":
      return typeof value === "string" && UUID.test(value);
    case "text":
      return typeof value === "string" && !value.includes("\0");
    case "unknown":
      return false;
  }
};

const castValue = (type: DslKeysetType, value: unknown): unknown => {
  if (value === null || value === undefined) {
    switch (type) {
      case "numeric":
        return sql`NULL::numeric`;
      case "boolean":
        return sql`NULL::boolean`;
      case "date":
        return sql`NULL::date`;
      case "datetime":
        return sql`NULL::timestamptz`;
      case "uuid":
        return sql`NULL::uuid`;
      case "text":
      case "unknown":
        return sql`NULL::text`;
    }
  }
  switch (type) {
    case "numeric":
      return sql`${value}::numeric`;
    case "boolean":
      return sql`${value}::boolean`;
    case "date":
      return sql`${value}::date`;
    case "datetime":
      return sql`${value}::timestamptz`;
    case "uuid":
      return sql`${value}::uuid`;
    case "text":
    case "unknown":
      return sql`${value}::text`;
  }
};

const after = (column: DslKeysetColumn, value: unknown): unknown => {
  const isNull = value === null || value === undefined;
  const nullsFirst = column.nullsFirst ?? false;
  if (isNull) return nullsFirst ? sql`${column.expression} IS NOT NULL` : sql`FALSE`;
  const comparison = column.direction === "desc" ? sql`<` : sql`>`;
  const compared = sql`${column.expression} ${comparison} ${castValue(column.type, value)}`;
  return nullsFirst ? compared : sql`(${compared} OR ${column.expression} IS NULL)`;
};

const equalPrefix = (columns: DslKeysetColumn[], values: unknown[], length: number): unknown => {
  const parts = columns
    .slice(0, length)
    .map((column, index) => sql`${column.expression} IS NOT DISTINCT FROM ${castValue(column.type, values[index])}`);
  return parts.length > 0 ? joinSql(parts, sql` AND `) : sql`TRUE`;
};

export const compileDslKeyset = (
  columns: DslKeysetColumn[],
  values: unknown[] | null | undefined,
):
  | { ok: true; orderBy: unknown; where: unknown; select: unknown; valuesFromRow: (row: Record<string, unknown>) => unknown[] }
  | { ok: false; error: string } => {
  if (columns.length === 0) return { ok: false, error: "query result has no stable cursor columns" };
  if (columns.some((column) => column.type === "unknown"))
    return { ok: false, error: "query sort contains a value that cannot be cursor-paginated" };
  if (values && (values.length !== columns.length || values.some((value, index) => !validValue(columns[index]!.type, value)))) {
    return { ok: false, error: "cursor values do not match this query ordering" };
  }

  const aliases = columns.map((_, index) => `__gql_cursor_${index}`);
  const orderBy = joinSql(
    columns.map(
      (column) =>
        sql`${column.expression} ${column.direction === "desc" ? sql`DESC` : sql`ASC`} ${column.nullsFirst ? sql`NULLS FIRST` : sql`NULLS LAST`}`,
    ),
    sql`, `,
  );
  const select = joinSql(
    columns.map((column, index) => {
      const cursorValue =
        column.type === "datetime"
          ? sql`to_char(${column.expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
          : column.type === "date"
            ? sql`to_char(${column.expression}, 'YYYY-MM-DD')`
            : column.expression;
      return sql`${cursorValue} AS ${sql.unsafe(aliases[index]!)}`;
    }),
    sql`, `,
  );
  const where = values
    ? joinSql(
        columns.map((column, index) => sql`(${equalPrefix(columns, values, index)} AND ${after(column, values[index])})`),
        sql` OR `,
      )
    : sql`TRUE`;
  return {
    ok: true,
    orderBy,
    where: sql`(${where})`,
    select,
    valuesFromRow: (row) => aliases.map((alias) => row[alias] ?? null),
  };
};
