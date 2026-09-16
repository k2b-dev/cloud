import { normalizeTimeZone } from "@k2b/cloud/shared";
import { type DateContext, dates } from "@k2b/stdlib";
import { sql } from "bun";
import { DATEADD_RANGE } from "../formula/date-range";
import {
  type FormulaFunctionName,
  formulaFunctionArity,
  formulaFunctionForName,
  isListFormulaFunction,
  type ListFormulaFunctionName,
} from "../formula/function-catalog";
import { FORMULA_ROUND_PLACES } from "../formula/numeric";
import type { Expr } from "../formula/types";
import { formulaNumericAggregate, formulaNumericOperation, withFormulaErrors } from "./formula-numeric-sql";
import {
  type FormulaSqlCompileResult,
  type FormulaSqlExpression,
  type FormulaSqlType,
  formulaSqlAnyError,
  formulaSqlAsBoolean,
  formulaSqlAsDate,
  formulaSqlAsNumeric,
  formulaSqlAsText,
  formulaSqlAsTimestamp,
  formulaSqlError,
  formulaSqlFail,
  formulaSqlOk,
  joinFormulaSql,
} from "./formula-sql-values";

const DATE_UNITS = new Set(["day", "days", "month", "months", "year", "years", "hour", "hours", "minute", "minutes"]);
const DIFF_UNITS = new Set(["day", "days", "hour", "hours", "minute", "minutes", "second", "seconds"]);

const SHORT_CIRCUIT_FUNCTIONS = new Set<FormulaFunctionName>(["IF", "IFEMPTY", "IFERROR", "AND", "OR"]);
type FunctionCompileContext = {
  dateConfig?: DateContext;
  now: Date;
  compileList?: (fn: ListFormulaFunctionName, args: Expr[]) => FormulaSqlCompileResult;
};
type FormulaFunctionContext = {
  sourceArgs: Expr[];
  compiled: FormulaSqlExpression[];
  compileContext: FunctionCompileContext;
  arg: (index: number) => FormulaSqlExpression;
  numericArg: (index: number) => unknown;
  textArg: (index: number) => unknown;
  boolArg: (index: number) => unknown;
};
type FormulaFunctionCompiler = (context: FormulaFunctionContext) => FormulaSqlCompileResult;
type FormulaDateKind = "date" | "datetime";

const DATE_LITERAL = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_LITERAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[zZ]|[+-]\d{2}:?\d{2})$/;

const literalString = (expression: Expr): string | null =>
  expression.kind === "literal" && typeof expression.value === "string" ? expression.value.toLowerCase() : null;

const conditionalType = (
  fn: string,
  left: FormulaSqlExpression,
  right: FormulaSqlExpression,
): { ok: true; type: FormulaSqlType } | { ok: false; error: string } => {
  if (left.type === right.type) return { ok: true, type: left.type };
  if (left.type === "unknown") return { ok: true, type: right.type };
  if (right.type === "unknown") return { ok: true, type: left.type };
  return { ok: false, error: `${fn} branches must have the same type or use null; got ${left.type} and ${right.type}` };
};

const conditionalResult = (
  fn: string,
  left: FormulaSqlExpression,
  right: FormulaSqlExpression,
  sqlFragment: (left: unknown, right: unknown) => unknown,
  errorSql: unknown | undefined,
): FormulaSqlCompileResult => {
  const result = conditionalType(fn, left, right);
  if (!result.ok) return formulaSqlFail(result.error);
  // A null-only expression becomes a text column when staged in a subquery.
  // Cast it to the chosen branch type before CASE resolves its SQL types.
  const branch = (expression: FormulaSqlExpression) =>
    expression.type === "unknown" && result.type !== "unknown"
      ? sql`(${expression.sql})::${sql.unsafe(result.type === "datetime" ? "timestamptz" : result.type === "json" ? "jsonb" : result.type)}`
      : expression.sql;
  return formulaSqlOk(sqlFragment(branch(left), branch(right)), result.type, errorSql);
};

const shortCircuitErrors = (args: FormulaSqlExpression[], continueWhen: boolean): unknown | undefined => {
  let reached = sql`true`;
  const errors: unknown[] = [];
  for (const arg of args) {
    if (arg.errorSql !== undefined) errors.push(sql`(${reached} AND ${arg.errorSql})`);
    const truthy = formulaSqlAsBoolean(arg);
    reached = sql`(${reached} AND ${continueWhen ? truthy : sql`NOT ${truthy}`})`;
  }
  return errors.length === 0 ? undefined : sql`(${joinFormulaSql(errors, sql` OR `)})`;
};

const formulaDateKind = (source: Expr, compiled: FormulaSqlExpression): FormulaDateKind | null => {
  if (compiled.type === "date" || compiled.type === "datetime") return compiled.type;
  if (source.kind !== "literal" || typeof source.value !== "string") return null;
  if (DATE_LITERAL.test(source.value)) return "date";
  if (INSTANT_LITERAL.test(source.value)) return "datetime";
  return null;
};

const dateOperand = (
  source: Expr,
  compiled: FormulaSqlExpression,
  timeZone: string,
): { kind: FormulaDateKind; localDate: unknown; localTimestamp: unknown; instant: unknown } | null => {
  const kind = formulaDateKind(source, compiled);
  if (!kind) return null;
  if (kind === "date") {
    const date = compiled.type === "date" ? formulaSqlAsDate(compiled) : sql`grids.try_iso_date((${compiled.sql})::text)`;
    return {
      kind,
      localDate: date,
      localTimestamp: sql`(${date})::timestamp`,
      instant: sql`((${date})::timestamp AT TIME ZONE 'UTC')`,
    };
  }
  const instant = compiled.type === "datetime" ? formulaSqlAsTimestamp(compiled) : sql`grids.try_timestamptz((${compiled.sql})::text)`;
  return {
    kind,
    localDate: sql`((${instant}) AT TIME ZONE ${timeZone})::date`,
    localTimestamp: sql`(${instant}) AT TIME ZONE ${timeZone}`,
    instant,
  };
};

const dateOperandError = (fn: string): FormulaSqlCompileResult =>
  formulaSqlFail(`${fn} expects date/datetime fields or ISO date/instant literals`);

const intervalFor = (amount: unknown, unit: string): unknown => {
  if (unit === "day" || unit === "days") return sql`${amount} * INTERVAL '1 day'`;
  if (unit === "month" || unit === "months") return sql`${amount} * INTERVAL '1 month'`;
  if (unit === "year" || unit === "years") return sql`${amount} * INTERVAL '1 year'`;
  if (unit === "hour" || unit === "hours") return sql`${amount} * INTERVAL '1 hour'`;
  return sql`${amount} * INTERVAL '1 minute'`;
};

// Text slicing saturates at the input length, as in the formula evaluator.
// Clamp while still numeric: a large valid number must never overflow int casts.
const boundedTextOffset = (text: unknown, amount: unknown): unknown => sql`LEAST(CHAR_LENGTH(${text}), GREATEST(FLOOR(${amount}), 0))::int`;

const numericValues = (args: FormulaSqlExpression[], aggregate: "MIN" | "MAX"): unknown => {
  if (args.length === 0) return sql`NULL::numeric`;
  const rows = joinFormulaSql(
    args.map((arg) => sql`(${formulaSqlAsNumeric(arg)})`),
    sql`, `,
  );
  const fn = aggregate === "MIN" ? sql`MIN(v)` : sql`MAX(v)`;
  return sql`(SELECT ${fn} FROM (VALUES ${rows}) AS formula_values(v) WHERE v IS NOT NULL)`;
};

const compileDateAdd = (
  args: Expr[],
  compiled: FormulaSqlExpression[],
  compileContext: FunctionCompileContext,
): FormulaSqlCompileResult => {
  const unit = literalString(args[2] ?? { kind: "literal", value: "days" });
  if (unit === null || !DATE_UNITS.has(unit)) return formulaSqlFail("DATEADD needs a literal unit: days, months, years, hours, or minutes");
  const timeZone = normalizeTimeZone(compileContext.dateConfig?.timeZone, "UTC");
  const date = dateOperand(args[0]!, compiled[0]!, timeZone);
  if (!date) return dateOperandError("DATEADD");
  const amount = sql`TRUNC(${formulaSqlAsNumeric(compiled[1]!)})`;
  const min = sql`${DATEADD_RANGE.minDate}::date`;
  const max = sql`${DATEADD_RANGE.maxDate}::date`;
  const minTimestamp = sql`${min}::timestamp`;
  const maxTimestamp = sql`(${max}::timestamp + INTERVAL '1 day' - INTERVAL '1 microsecond')`;
  const year = sql`EXTRACT(YEAR FROM ${date.localDate})`;
  const month = sql`EXTRACT(MONTH FROM ${date.localDate})`;
  const timeUnit = unit.startsWith("hour") || unit.startsWith("minute");
  const divisor = unit.startsWith("hour") ? 3600 : 60;
  // Validate the destination before interval arithmetic. Even a generic plan
  // must never multiply an unbounded user value into a PostgreSQL interval.
  const lower = unit.startsWith("year")
    ? sql`(${DATEADD_RANGE.minYear} - ${year})`
    : unit.startsWith("month")
      ? sql`((${DATEADD_RANGE.minYear} - ${year}) * 12 + 1 - ${month})`
      : timeUnit
        ? sql`CEIL(EXTRACT(EPOCH FROM (${minTimestamp} - ${date.localTimestamp})) / ${divisor})`
        : sql`(${min} - ${date.localDate})`;
  const upper = unit.startsWith("year")
    ? sql`(${DATEADD_RANGE.maxYear} - ${year})`
    : unit.startsWith("month")
      ? sql`((${DATEADD_RANGE.maxYear} - ${year}) * 12 + 12 - ${month})`
      : timeUnit
        ? sql`FLOOR(EXTRACT(EPOCH FROM (${maxTimestamp} - ${date.localTimestamp})) / ${divisor})`
        : sql`(${max} - ${date.localDate})`;
  const valid = sql`(${date.localDate} BETWEEN ${min} AND ${max} AND ${amount} BETWEEN ${lower} AND ${upper})`;
  const interval = intervalFor(sql`CASE WHEN ${valid} THEN ${amount} ELSE 0 END`, unit);
  const nextLocal = sql`(${date.localTimestamp} + ${interval})`;
  const isDate = date.kind === "date" && !timeUnit;
  const value = isDate ? sql`(${nextLocal})::date` : sql`(${nextLocal} AT TIME ZONE ${timeZone})`;
  const resultValid = isDate
    ? valid
    : sql`(${valid} AND ${value} >= (${minTimestamp} AT TIME ZONE 'UTC')
    AND ${value} <= (${maxTimestamp} AT TIME ZONE 'UTC'))`;
  const error = sql`(${date.localTimestamp} IS NOT NULL AND ${amount} IS NOT NULL AND NOT ${resultValid})`;
  return formulaSqlOk(sql`CASE WHEN ${resultValid} THEN ${value} ELSE NULL END`, isDate ? "date" : "datetime", error);
};

const compileDateDiff = (
  args: Expr[],
  compiled: FormulaSqlExpression[],
  compileContext: FunctionCompileContext,
): FormulaSqlCompileResult => {
  const unit = literalString(args[2] ?? { kind: "literal", value: "days" });
  if (unit === null || !DIFF_UNITS.has(unit)) return formulaSqlFail("DATEDIFF needs a literal unit: days, hours, minutes, or seconds");
  const timeZone = normalizeTimeZone(compileContext.dateConfig?.timeZone, "UTC");
  const from = dateOperand(args[0]!, compiled[0]!, timeZone);
  const to = dateOperand(args[1]!, compiled[1]!, timeZone);
  if (!from || !to) return dateOperandError("DATEDIFF");
  if (unit === "day" || unit === "days") {
    return formulaSqlOk(sql`(${to.localDate} - ${from.localDate})::numeric`, "numeric");
  }
  const seconds = sql`EXTRACT(EPOCH FROM (${to.instant} - ${from.instant}))`;
  if (unit === "hour" || unit === "hours") return formulaSqlOk(sql`FLOOR(${seconds} / 3600)::numeric`, "numeric");
  if (unit === "minute" || unit === "minutes") return formulaSqlOk(sql`FLOOR(${seconds} / 60)::numeric`, "numeric");
  return formulaSqlOk(sql`FLOOR(${seconds})::numeric`, "numeric");
};

const FORMULA_FUNCTION_COMPILERS = {
  HAS_OPTION: () => formulaSqlFail("HAS_OPTION needs a Select field and a literal option ID or label"),
  ABS: ({ numericArg }) => formulaSqlOk(sql`ABS(${numericArg(0)})`, "numeric"),
  ROUND: ({ numericArg }) => {
    const value = numericArg(0);
    const places = sql`COALESCE(TRUNC(${numericArg(1)}), 0)`;
    const valid = sql`${places} BETWEEN ${FORMULA_ROUND_PLACES.min} AND ${FORMULA_ROUND_PLACES.max}`;
    const safePlaces = sql`(CASE WHEN ${valid} THEN ${places} ELSE 0 END)::int`;
    return {
      ok: true,
      expression: withFormulaErrors(formulaNumericOperation("round", value, safePlaces), sql`(${value} IS NOT NULL AND NOT (${valid}))`),
    };
  },
  FLOOR: ({ numericArg }) => ({ ok: true, expression: formulaNumericOperation("floor", numericArg(0)) }),
  CEIL: ({ numericArg }) => ({ ok: true, expression: formulaNumericOperation("ceil", numericArg(0)) }),
  SQRT: ({ numericArg }) => {
    const value = numericArg(0);
    return formulaSqlOk(sql`CASE WHEN ${value} < 0 THEN NULL ELSE SQRT(trim_scale(${value})) END`, "numeric", sql`(${value} < 0)`);
  },
  POW: ({ numericArg }) => {
    const base = numericArg(0);
    const exponent = numericArg(1);
    const value = sql`grids.try_numeric_power(${base}, ${exponent})`;
    return formulaSqlOk(value, "numeric", sql`(${base} IS NOT NULL AND ${exponent} IS NOT NULL AND ${value} IS NULL)`);
  },
  MOD: ({ numericArg }) => {
    const dividend = numericArg(0);
    const divisor = numericArg(1);
    return { ok: true, expression: formulaNumericOperation("%", dividend, divisor) };
  },
  SUM: ({ compiled }) => ({
    ok: true,
    expression: formulaNumericAggregate("SUM", sql`ARRAY[${joinFormulaSql(compiled.map(formulaSqlAsNumeric), sql`, `)}]::numeric[]`),
  }),
  AVG: ({ compiled }) => ({
    ok: true,
    expression: formulaNumericAggregate("AVG", sql`ARRAY[${joinFormulaSql(compiled.map(formulaSqlAsNumeric), sql`, `)}]::numeric[]`),
  }),
  MEAN: ({ compiled }) => ({
    ok: true,
    expression: formulaNumericAggregate("AVG", sql`ARRAY[${joinFormulaSql(compiled.map(formulaSqlAsNumeric), sql`, `)}]::numeric[]`),
  }),
  MEDIAN: ({ compiled }) => ({
    ok: true,
    expression: formulaNumericAggregate("MEDIAN", sql`ARRAY[${joinFormulaSql(compiled.map(formulaSqlAsNumeric), sql`, `)}]::numeric[]`),
  }),
  MIN: ({ compiled }) => formulaSqlOk(numericValues(compiled, "MIN"), "numeric"),
  MAX: ({ compiled }) => formulaSqlOk(numericValues(compiled, "MAX"), "numeric"),
  COUNT: ({ compiled }) => {
    if (compiled.length === 0) return formulaSqlOk(sql`0::numeric`, "numeric");
    const parts = compiled.map(
      (expression) => sql`CASE WHEN ${expression.sql} IS NULL OR (${expression.sql})::text = '' THEN 0 ELSE 1 END`,
    );
    return formulaSqlOk(sql`(${joinFormulaSql(parts, sql` + `)})::numeric`, "numeric");
  },
  PERCENT: ({ numericArg }) => {
    const part = numericArg(0);
    const total = numericArg(1);
    return { ok: true, expression: formulaNumericOperation("percent", part, total) };
  },
  CONCAT: ({ compiled }) =>
    formulaSqlOk(compiled.length === 0 ? sql`''::text` : sql`CONCAT(${joinFormulaSql(compiled.map(formulaSqlAsText), sql`, `)})`, "text"),
  LEN: ({ textArg }) => formulaSqlOk(sql`CHAR_LENGTH(${textArg(0)})::numeric`, "numeric"),
  LOWER: ({ textArg }) => formulaSqlOk(sql`LOWER(${textArg(0)})`, "text"),
  UPPER: ({ textArg }) => formulaSqlOk(sql`UPPER(${textArg(0)})`, "text"),
  TRIM: ({ textArg }) => formulaSqlOk(sql`TRIM(${textArg(0)})`, "text"),
  LEFT: ({ textArg, numericArg }) => formulaSqlOk(sql`LEFT(${textArg(0)}, ${boundedTextOffset(textArg(0), numericArg(1))})`, "text"),
  RIGHT: ({ textArg, numericArg }) => formulaSqlOk(sql`RIGHT(${textArg(0)}, ${boundedTextOffset(textArg(0), numericArg(1))})`, "text"),
  SUBSTRING: ({ textArg, numericArg }) =>
    formulaSqlOk(
      sql`SUBSTRING(${textArg(0)} FROM ${boundedTextOffset(textArg(0), numericArg(1))} + 1 FOR ${boundedTextOffset(textArg(0), numericArg(2))})`,
      "text",
    ),
  REPLACE: ({ textArg }) => formulaSqlOk(sql`REPLACE(${textArg(0)}, ${textArg(1)}, ${textArg(2)})`, "text"),
  IF: ({ arg, boolArg }) => {
    const condition = boolArg(0);
    const errorSql =
      arg(0).errorSql === undefined && arg(1).errorSql === undefined && arg(2).errorSql === undefined
        ? undefined
        : sql`(${formulaSqlError(arg(0))} OR CASE WHEN ${condition} THEN ${formulaSqlError(arg(1))} ELSE ${formulaSqlError(arg(2))} END)`;
    return conditionalResult(
      "IF",
      arg(1),
      arg(2),
      (then, otherwise) => sql`CASE WHEN ${condition} THEN ${then} ELSE ${otherwise} END`,
      errorSql,
    );
  },
  IFEMPTY: ({ arg }) => {
    const empty = sql`(${arg(0).sql} IS NULL OR (${arg(0).sql})::text = '')`;
    const errorSql =
      arg(0).errorSql === undefined && arg(1).errorSql === undefined
        ? undefined
        : sql`(${formulaSqlError(arg(0))} OR (${empty} AND ${formulaSqlError(arg(1))}))`;
    return conditionalResult(
      "IFEMPTY",
      arg(0),
      arg(1),
      (value, fallback) => sql`CASE WHEN ${empty} THEN ${fallback} ELSE ${value} END`,
      errorSql,
    );
  },
  IFERROR: ({ arg }) => {
    const sourceError = formulaSqlError(arg(0));
    const errorSql =
      arg(0).errorSql === undefined || arg(1).errorSql === undefined ? undefined : sql`(${sourceError} AND ${arg(1).errorSql})`;
    return conditionalResult(
      "IFERROR",
      arg(0),
      arg(1),
      (value, fallback) => sql`CASE WHEN ${sourceError} THEN ${fallback} ELSE ${value} END`,
      errorSql,
    );
  },
  AND: ({ compiled }) =>
    formulaSqlOk(
      compiled.length === 0 ? sql`true` : sql`(${joinFormulaSql(compiled.map(formulaSqlAsBoolean), sql` AND `)})`,
      "boolean",
      shortCircuitErrors(compiled, true),
    ),
  OR: ({ compiled }) =>
    formulaSqlOk(
      compiled.length === 0 ? sql`false` : sql`(${joinFormulaSql(compiled.map(formulaSqlAsBoolean), sql` OR `)})`,
      "boolean",
      shortCircuitErrors(compiled, false),
    ),
  NOT: ({ boolArg }) => formulaSqlOk(sql`NOT ${boolArg(0)}`, "boolean"),
  ISBLANK: ({ arg }) => formulaSqlOk(sql`(${arg(0).sql} IS NULL OR (${arg(0).sql})::text = '')`, "boolean"),
  CONTAINS: ({ textArg }) => formulaSqlOk(sql`POSITION(${textArg(1)} IN ${textArg(0)}) > 0`, "boolean"),
  STARTSWITH: ({ textArg }) => formulaSqlOk(sql`POSITION(${textArg(1)} IN ${textArg(0)}) = 1`, "boolean"),
  ENDSWITH: ({ textArg }) => formulaSqlOk(sql`RIGHT(${textArg(0)}, CHAR_LENGTH(${textArg(1)})) = ${textArg(1)}`, "boolean"),
  ICONTAINS: ({ textArg }) => formulaSqlOk(sql`POSITION(LOWER(${textArg(1)}) IN LOWER(${textArg(0)})) > 0`, "boolean"),
  ISTARTSWITH: ({ textArg }) => formulaSqlOk(sql`POSITION(LOWER(${textArg(1)}) IN LOWER(${textArg(0)})) = 1`, "boolean"),
  IENDSWITH: ({ textArg }) => formulaSqlOk(sql`RIGHT(LOWER(${textArg(0)}), CHAR_LENGTH(${textArg(1)})) = LOWER(${textArg(1)})`, "boolean"),
  TODAY: ({ compileContext }) => {
    const timeZone = normalizeTimeZone(compileContext.dateConfig?.timeZone, "UTC");
    return formulaSqlOk(sql`${dates.formatDateKey(compileContext.now, { ...compileContext.dateConfig, timeZone })}::date`, "date");
  },
  NOW: ({ compileContext }) => formulaSqlOk(sql`${compileContext.now.toISOString()}::timestamptz`, "datetime"),
  YEAR: ({ sourceArgs, arg, compileContext }) => {
    const timeZone = normalizeTimeZone(compileContext.dateConfig?.timeZone, "UTC");
    const date = dateOperand(sourceArgs[0]!, arg(0), timeZone);
    return date ? formulaSqlOk(sql`EXTRACT(YEAR FROM ${date.localDate})::numeric`, "numeric") : dateOperandError("YEAR");
  },
  MONTH: ({ sourceArgs, arg, compileContext }) => {
    const timeZone = normalizeTimeZone(compileContext.dateConfig?.timeZone, "UTC");
    const date = dateOperand(sourceArgs[0]!, arg(0), timeZone);
    return date ? formulaSqlOk(sql`EXTRACT(MONTH FROM ${date.localDate})::numeric`, "numeric") : dateOperandError("MONTH");
  },
  DAY: ({ sourceArgs, arg, compileContext }) => {
    const timeZone = normalizeTimeZone(compileContext.dateConfig?.timeZone, "UTC");
    const date = dateOperand(sourceArgs[0]!, arg(0), timeZone);
    return date ? formulaSqlOk(sql`EXTRACT(DAY FROM ${date.localDate})::numeric`, "numeric") : dateOperandError("DAY");
  },
  DATEADD: ({ sourceArgs, compiled, compileContext }) => compileDateAdd(sourceArgs, compiled, compileContext),
  DATEDIFF: ({ sourceArgs, compiled, compileContext }) => compileDateDiff(sourceArgs, compiled, compileContext),
} satisfies Record<Exclude<FormulaFunctionName, ListFormulaFunctionName>, FormulaFunctionCompiler>;

const formatArity = (spec: { min: number; max: number }): string => {
  if (spec.min === spec.max) return spec.min === 1 ? "1 argument" : `${spec.min} arguments`;
  if (spec.max === Number.POSITIVE_INFINITY) return `at least ${spec.min} argument${spec.min === 1 ? "" : "s"}`;
  return `${spec.min}-${spec.max} arguments`;
};

export const compileFormulaFunction = (
  fn: string,
  args: Expr[],
  compileContext: FunctionCompileContext,
  compileArgs: (args: Expr[]) => FormulaSqlCompileResult[],
): FormulaSqlCompileResult => {
  const upper = fn.toUpperCase();
  const spec = formulaFunctionForName(upper);
  if (!spec) return formulaSqlFail(`Unsupported formula function ${fn}`);
  const arity = formulaFunctionArity(spec);
  if (args.length < arity.min || args.length > arity.max) {
    return formulaSqlFail(`${upper} needs ${formatArity(arity)}; got ${args.length}`);
  }
  if (isListFormulaFunction(upper))
    return compileContext.compileList?.(upper, args) ?? formulaSqlFail("Object-list context is not available");
  const results = compileArgs(args);
  const error = results.find((result): result is Extract<FormulaSqlCompileResult, { ok: false }> => !result.ok);
  if (error) return error;
  const compiled = results.map((result) => (result as Extract<FormulaSqlCompileResult, { ok: true }>).expression);
  const arg = (index: number): FormulaSqlExpression => compiled[index] ?? { sql: sql`NULL`, type: "unknown" };
  const compiler = FORMULA_FUNCTION_COMPILERS[upper as Exclude<FormulaFunctionName, ListFormulaFunctionName>] as
    | FormulaFunctionCompiler
    | undefined;
  if (!compiler) return formulaSqlFail(`Unsupported formula function ${fn}`);
  const result = compiler({
    sourceArgs: args,
    compiled,
    compileContext,
    arg,
    numericArg: (index) => formulaSqlAsNumeric(arg(index)),
    textArg: (index) => formulaSqlAsText(arg(index)),
    boolArg: (index) => formulaSqlAsBoolean(arg(index)),
  });
  if (!result.ok || SHORT_CIRCUIT_FUNCTIONS.has(upper as FormulaFunctionName)) return result;
  return { ok: true, expression: withFormulaErrors(result.expression, formulaSqlAnyError(compiled)) };
};
