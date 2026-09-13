import { sql } from "bun";
import { type ObjectListColumn, ObjectListConfigSchema } from "../field-types/object-list";
import { SelectConfigSchema } from "../field-types/select";
import { planObjectListCalculations } from "../formula/object-list-plan";
import type { Expr } from "../formula/types";
import { normalizeRefKey } from "../ref-syntax";
import { scalarSqlTypeForField, storageOf } from "./field-storage";
import {
  type FormulaSqlCompileResult,
  type FormulaSqlExpression,
  formulaSqlFail,
  formulaSqlOk,
  formulaSqlOrErrors,
  joinFormulaSql,
} from "./formula-sql-values";

type RowCompiler = (ast: Expr, resolve: (ref: string) => FormulaSqlExpression | string | null) => FormulaSqlCompileResult;
type RowPlan = { columns: Map<string, FormulaSqlExpression>; json: unknown; errorSql: unknown; joins: unknown };

// Match String.trim() and String.length used by the canonical text validator.
// PostgreSQL's default trim removes only spaces; length counts code points.
const textTrimCharacters =
  " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

const normalizedSelect = (column: ObjectListColumn, source: unknown): FormulaSqlCompileResult => {
  const parsed = SelectConfigSchema.safeParse(column.config);
  if (!parsed.success) return formulaSqlFail(`Invalid select configuration: ${column.name}`);
  const config = parsed.data;
  const absent = sql`${source} IS NULL OR ${source} = 'null'::jsonb OR ${source} = '\"\"'::jsonb`;
  const array = sql`CASE WHEN jsonb_typeof(${source}) = 'array' THEN ${source} ELSE '[]'::jsonb END`;
  // The scalar validator removes empty IDs and duplicates, retaining first order.
  const normalized = sql`(SELECT jsonb_agg(value ORDER BY first_position) FROM (
    SELECT value, min(position) AS first_position FROM jsonb_array_elements(${array}) WITH ORDINALITY AS choices(value, position)
    WHERE value <> '\"\"'::jsonb GROUP BY value
  ) unique_choices)`;
  const count = sql`COALESCE(jsonb_array_length(${normalized}), 0)`;
  const invalidOption = sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${array}) AS choices(value)
    WHERE jsonb_typeof(value) <> 'string' OR
      (value <> '\"\"'::jsonb AND NOT ((value #>> '{}') = ANY(${sql.array(
        config.options.map((option) => option.id),
        "TEXT",
      )}::text[]))))`;
  const error = sql`CASE WHEN ${absent} THEN ${column.required}
    WHEN jsonb_typeof(${source}) <> 'array' OR ${invalidOption} THEN true
    WHEN ${count} = 0 THEN ${column.required}
    ELSE (${count} < ${config.minSelected ?? 0} OR ${count} > ${config.multiple ? (config.maxSelected ?? config.options.length) : 1}) END`;
  return formulaSqlOk(normalized, "unknown", error);
};

const normalizedCalculation = (column: ObjectListColumn, expression: FormulaSqlExpression): FormulaSqlCompileResult => {
  const type = scalarSqlTypeForField(column);
  if (type === "unknown") return formulaSqlFail(`List column ${column.name}: ${column.type} does not support calculations`);
  if (expression.type !== "unknown" && expression.type !== type)
    return formulaSqlFail(`Calculated list column ${column.name} must return ${type}, not ${expression.type}`);
  let value = expression.sql;
  const errors: unknown[] = [expression.errorSql ?? sql`false`];
  if (column.required) errors.push(sql`${value} IS NULL`);
  const config = column.config;
  if (type === "numeric") {
    const places = config.integerOnly ? 0 : typeof config.decimalPlaces === "number" ? config.decimalPlaces : undefined;
    if (places !== undefined) {
      errors.push(sql`COALESCE(${value} <> round((${value})::numeric, ${places}::int), false)`);
      value = sql`round((${value})::numeric, ${places}::int)`;
    } else if (column.type === "number") {
      // Match the scalar number validator: without an explicit scale, remove
      // insignificant zeroes rather than retaining a SQL function's scale.
      value = sql`trim_scale((${value})::numeric)`;
    }
    if (typeof config.precision === "number") {
      const fractional = places === undefined ? sql`min_scale((${value})::numeric)` : sql`${places}::int`;
      errors.push(sql`COALESCE(${fractional} > ${config.precision}::int, false)`);
      errors.push(sql`COALESCE(abs(${value}) >= power(10::numeric, ${config.precision}::int - ${fractional}), false)`);
    }
    if (typeof config.min === "string" || typeof config.min === "number")
      errors.push(sql`COALESCE(${value} < ${String(config.min)}::numeric, false)`);
    if (typeof config.max === "string" || typeof config.max === "number")
      errors.push(sql`COALESCE(${value} > ${String(config.max)}::numeric, false)`);
    if (column.type === "percent") {
      errors.push(sql`COALESCE(${value} < 0 OR ${value} > ${config.range === "fraction" ? 1 : 100}, false)`);
      value = sql`round((${value})::numeric, ${typeof config.decimals === "number" ? config.decimals : 2}::int)`;
    }
    if (column.type === "duration") {
      errors.push(sql`COALESCE(${value} < 0, false)`);
      value = sql`round((${value})::numeric)`;
    }
  } else if (type === "text") {
    value = column.type === "longtext" || config.multiline ? value : sql`btrim(${value}, ${textTrimCharacters})`;
    value = sql`NULLIF(${value}, '')`;
    if (column.required) errors.push(sql`${value} IS NULL`);
    const length = sql`length(regexp_replace(${value}, ${"[\u{10000}-\u{10ffff}]"}, 'xx', 'g'))`;
    if (typeof config.minLength === "number") errors.push(sql`COALESCE(${length} < ${config.minLength}, false)`);
    if (typeof config.maxLength === "number") errors.push(sql`COALESCE(${length} > ${config.maxLength}, false)`);
    // Input cells are validated by the scalar write owner; schema changes also
    // validate retained rows under the table lock. Only calculated cells need
    // this constraint evaluated here. Do not substitute PostgreSQL's different
    // regex dialect for the JavaScript validator.
    if (column.formula && config.regex !== undefined)
      return formulaSqlFail(`Calculated list column ${column.name} uses a regex constraint not supported in SQL`);
  } else if (type === "date" || type === "datetime") {
    const cast = (bound: string) => (type === "date" ? sql`${bound}::date` : sql`${bound}::timestamptz`);
    if (typeof config.min === "string") errors.push(sql`COALESCE(${value} < ${cast(config.min)}, false)`);
    if (typeof config.max === "string") errors.push(sql`COALESCE(${value} > ${cast(config.max)}, false)`);
  }
  return formulaSqlOk(value, type, formulaSqlOrErrors(errors));
};

/** Compile row-local expressions through the normal formula compiler and scalar storage owner. */
export const compileObjectListRow = (
  configRaw: unknown,
  rowAlias: string,
  compile: RowCompiler,
): { ok: true; plan: RowPlan } | { ok: false; error: string } => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(rowAlias)) return { ok: false, error: "Invalid list row alias" };
  const parsed = ObjectListConfigSchema.safeParse(configRaw);
  if (!parsed.success) return { ok: false, error: "Invalid object-list configuration" };
  const config = parsed.data;
  const calculations = planObjectListCalculations(config.fields);
  if (!calculations.ok) return calculations;
  const columns = new Map<string, FormulaSqlExpression>();
  const joins: unknown[] = [];
  for (const column of config.fields) {
    if (column.formula) continue;
    const projection = storageOf(column).project(column, rowAlias);
    const type = scalarSqlTypeForField(column);
    const raw = sql`${sql.unsafe(rowAlias)}.data->${column.id}`;
    const expression: FormulaSqlExpression = { sql: projection ?? raw, type };
    if (type === "numeric") {
      const parsed = sql`grids.try_numeric(${sql.unsafe(rowAlias)}.data->>${column.id})`;
      const finite = sql`CASE WHEN (${parsed})::text IN ('NaN', 'Infinity', '-Infinity') THEN NULL ELSE ${parsed} END`;
      const absent = sql`${raw} IS NULL OR ${raw} = 'null'::jsonb OR ${raw} = '\"\"'::jsonb`;
      expression.sql = finite;
      expression.errorSql = sql`NOT (${absent}) AND (jsonb_typeof(${raw}) NOT IN ('string', 'number') OR ${finite} IS NULL)`;
    }
    if (column.type === "select") {
      const checked = normalizedSelect(column, expression.sql);
      if (!checked.ok) return checked;
      columns.set(column.id, { ...checked.expression, select: column });
      continue;
    }
    // Stored values can become invalid after tightening a column's constraints.
    // Reuse the same scalar checks as calculated cells, not a null/zero fallback.
    if (type !== "unknown") {
      const checked = normalizedCalculation(column, expression);
      if (!checked.ok) return checked;
      columns.set(column.id, checked.expression);
    } else columns.set(column.id, expression);
  }
  for (const [index, step] of calculations.plan.steps.entries()) {
    const column = config.fields.find((field) => field.id === step.id)!;
    const compiled = compile(step.ast, (ref) => {
      const key = normalizeRefKey(ref);
      const id = Object.hasOwn(calculations.plan.references, key) ? calculations.plan.references[key] : undefined;
      const expression = id ? columns.get(id) : undefined;
      return expression?.type === "unknown" && !expression.select
        ? `List column ${ref} has no scalar formula value`
        : (expression ?? `Unknown list column ${ref}`);
    });
    if (!compiled.ok) return compiled;
    const normalized = normalizedCalculation(column, compiled.expression);
    if (!normalized.ok) return normalized;
    const alias = sql.unsafe(`${rowAlias}_calc_${index}`);
    // Keep each dependency a scalar result rather than exponentially inlining
    // its expression at every reference. OFFSET 0 prevents subquery pull-up.
    joins.push(sql`CROSS JOIN LATERAL (SELECT ${normalized.expression.sql} AS value,
      COALESCE(${normalized.expression.errorSql ?? sql`false`}, false) AS error OFFSET 0) ${alias}`);
    columns.set(column.id, { sql: sql`${alias}.value`, type: normalized.expression.type, errorSql: sql`${alias}.error` });
  }
  const entries = config.fields.map((column) => {
    const expression = columns.get(column.id)!;
    const value =
      column.type === "number"
        ? sql`(${expression.sql})::text`
        : expression.type === "datetime"
          ? sql`to_char((${expression.sql}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
          : expression.sql;
    return sql`jsonb_build_object(${column.id}::text, ${value})`;
  });
  const json = entries.slice(1).reduce((previous, entry) => sql`${previous} || ${entry}`, entries[0]!);
  return {
    ok: true,
    plan: {
      columns,
      json,
      errorSql: formulaSqlOrErrors([...columns.values()].map((column) => column.errorSql)) ?? sql`false`,
      joins: joinFormulaSql(joins, sql` `),
    },
  };
};

export const compileObjectListValue = (
  field: { id: string; config: unknown; required?: boolean },
  recordAlias: string,
  compile: (ast: Expr, resolve: Parameters<RowCompiler>[1], rowAlias: string) => FormulaSqlCompileResult,
): FormulaSqlCompileResult => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(recordAlias)) return formulaSqlFail("Invalid record alias");
  const config = ObjectListConfigSchema.safeParse(field.config);
  if (!config.success) return formulaSqlFail("Invalid object-list configuration");
  const rowAlias = `${recordAlias}_item`;
  const row = compileObjectListRow(field.config, rowAlias, (ast, resolve) => compile(ast, resolve, rowAlias));
  if (!row.ok) return row;
  const source = sql`${sql.unsafe(recordAlias)}.data->${field.id}`;
  const stored = sql`${sql.unsafe(recordAlias)}.finalized_at IS NOT NULL`;
  const absent = sql`${source} IS NULL OR ${source} = 'null'::jsonb`;
  const array = sql`CASE WHEN jsonb_typeof(${source}) = 'array' THEN ${source} ELSE '[]'::jsonb END`;
  const rows = sql`jsonb_array_elements(${array}) WITH ORDINALITY AS ${sql.unsafe(rowAlias)}(data, position)`;
  const minimum = Math.max(field.required ? 1 : 0, config.data.minItems);
  const shapeError = sql`jsonb_typeof(${source}) <> 'array'
    OR jsonb_array_length(${array}) < ${minimum} OR jsonb_array_length(${array}) > ${config.data.maxItems}`;
  const rowError = sql`jsonb_typeof(${sql.unsafe(rowAlias)}.data) <> 'object' OR ${row.plan.errorSql}`;
  const errorSql = sql`CASE WHEN ${stored} THEN false WHEN ${absent} THEN ${minimum > 0}
    ELSE (${shapeError} OR (SELECT COALESCE(bool_or(${rowError}), false) FROM ${rows} ${row.plan.joins})) END`;
  const value = sql`CASE WHEN ${stored} OR ${absent} THEN ${source}
    ELSE (SELECT COALESCE(jsonb_agg(${row.plan.json} ORDER BY ${sql.unsafe(rowAlias)}.position), '[]'::jsonb) FROM ${rows} ${row.plan.joins}) END`;
  return formulaSqlOk(value, "unknown", errorSql);
};
