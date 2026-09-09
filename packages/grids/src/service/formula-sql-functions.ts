import { type DateContext, dates } from "@k2b/stdlib";
import { normalizeTimeZone } from "@k2b/cloud/shared";
import { sql } from "bun";
import { type FormulaFunctionName, formulaFunctionArity, formulaFunctionForName } from "../formula/function-catalog";
import type { Expr } from "../formula/types";
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
  formulaSqlOrErrors,
  joinFormulaSql,
} from "./formula-sql-values";

const DATE_UNITS = new Set(["day", "days", "month", "months", "year", "years", "hour", "hours", "minute", "minutes"]);
const DIFF_UNITS = new Set(["day", "days", "hour", "hours", "minute", "minutes", "second", "seconds"]);

const SHORT_CIRCUIT_FUNCTIONS = new Set<FormulaFunctionName>(["IF", "IFEMPTY", "IFERROR", "AND", "OR"]);
type FunctionCompileContext = { dateConfig?: DateContext; now: Date };
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
  sqlFragment: unknown,
  errorSql: unknown | undefined,
): FormulaSqlCompileResult => {
  const result = conditionalType(fn, left, right);
  return result.ok ? formulaSqlOk(sqlFragment, result.type, errorSql) : formulaSqlFail(result.error);
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

const numericValues = (args: FormulaSqlExpression[], aggregate: "AVG" | "MIN" | "MAX" | "MEDIAN" | "SUM"): unknown => {
  if (args.length === 0) return sql`NULL::numeric`;
  const rows = joinFormulaSql(
    args.map((arg) => sql`(${formulaSqlAsNumeric(arg)})`),
    sql`, `,
  );
  if (aggregate === "MEDIAN") {
    return sql`(
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v)::numeric
      FROM (VALUES ${rows}) AS formula_values(v)
      WHERE v IS NOT NULL
    )`;
  }
  const fn = aggregate === "AVG" ? sql`AVG(v)` : aggregate === "MIN" ? sql`MIN(v)` : aggregate === "MAX" ? sql`MAX(v)` : sql`SUM(v)`;
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
  const interval = intervalFor(amount, unit);
  const nextLocal = sql`(${date.localTimestamp} + ${interval})`;
  const timeUnit = unit.startsWith("hour") || unit.startsWith("minute");
  if (date.kind === "date" && !timeUnit) return formulaSqlOk(sql`(${nextLocal})::date`, "date");
  return formulaSqlOk(sql`(${nextLocal} AT TIME ZONE ${timeZone})`, "datetime");
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
  ABS: ({ numericArg }) => formulaSqlOk(sql`ABS(${numericArg(0)})`, "numeric"),
  ROUND: ({ numericArg }) => formulaSqlOk(sql`ROUND(${numericArg(0)}, COALESCE(FLOOR(${numericArg(1)})::int, 0))`, "numeric"),
  FLOOR: ({ numericArg }) => formulaSqlOk(sql`FLOOR(${numericArg(0)})`, "numeric"),
  CEIL: ({ numericArg }) => formulaSqlOk(sql`CEIL(${numericArg(0)})`, "numeric"),
  SQRT: ({ numericArg }) => {
    const value = numericArg(0);
    return formulaSqlOk(sql`CASE WHEN ${value} < 0 THEN NULL ELSE SQRT(${value}) END`, "numeric", sql`(${value} < 0)`);
  },
  POW: ({ numericArg }) => formulaSqlOk(sql`POWER(${numericArg(0)}, ${numericArg(1)})`, "numeric"),
  MOD: ({ numericArg }) => {
    const dividend = numericArg(0);
    const divisor = numericArg(1);
    return formulaSqlOk(sql`MOD(${dividend}, NULLIF(${divisor}, 0))`, "numeric", sql`(${dividend} IS NOT NULL AND ${divisor} = 0)`);
  },
  SUM: ({ compiled }) => formulaSqlOk(numericValues(compiled, "SUM"), "numeric"),
  AVG: ({ compiled }) => formulaSqlOk(numericValues(compiled, "AVG"), "numeric"),
  MEAN: ({ compiled }) => formulaSqlOk(numericValues(compiled, "AVG"), "numeric"),
  MEDIAN: ({ compiled }) => formulaSqlOk(numericValues(compiled, "MEDIAN"), "numeric"),
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
    return formulaSqlOk(sql`(${part} / NULLIF(${total}, 0) * 100)`, "numeric", sql`(${part} IS NOT NULL AND ${total} = 0)`);
  },
  CONCAT: ({ compiled }) =>
    formulaSqlOk(compiled.length === 0 ? sql`''::text` : sql`CONCAT(${joinFormulaSql(compiled.map(formulaSqlAsText), sql`, `)})`, "text"),
  LEN: ({ textArg }) => formulaSqlOk(sql`CHAR_LENGTH(${textArg(0)})::numeric`, "numeric"),
  LOWER: ({ textArg }) => formulaSqlOk(sql`LOWER(${textArg(0)})`, "text"),
  UPPER: ({ textArg }) => formulaSqlOk(sql`UPPER(${textArg(0)})`, "text"),
  TRIM: ({ textArg }) => formulaSqlOk(sql`TRIM(${textArg(0)})`, "text"),
  LEFT: ({ textArg, numericArg }) => formulaSqlOk(sql`LEFT(${textArg(0)}, GREATEST(FLOOR(${numericArg(1)})::int, 0))`, "text"),
  RIGHT: ({ textArg, numericArg }) => formulaSqlOk(sql`RIGHT(${textArg(0)}, GREATEST(FLOOR(${numericArg(1)})::int, 0))`, "text"),
  SUBSTRING: ({ textArg, numericArg }) =>
    formulaSqlOk(
      sql`SUBSTRING(${textArg(0)} FROM GREATEST(FLOOR(${numericArg(1)})::int, 0) + 1 FOR GREATEST(FLOOR(${numericArg(2)})::int, 0))`,
      "text",
    ),
  REPLACE: ({ textArg }) => formulaSqlOk(sql`REPLACE(${textArg(0)}, ${textArg(1)}, ${textArg(2)})`, "text"),
  IF: ({ arg, boolArg }) => {
    const condition = boolArg(0);
    const errorSql =
      arg(0).errorSql === undefined && arg(1).errorSql === undefined && arg(2).errorSql === undefined
        ? undefined
        : sql`(${formulaSqlError(arg(0))} OR CASE WHEN ${condition} THEN ${formulaSqlError(arg(1))} ELSE ${formulaSqlError(arg(2))} END)`;
    return conditionalResult("IF", arg(1), arg(2), sql`CASE WHEN ${condition} THEN ${arg(1).sql} ELSE ${arg(2).sql} END`, errorSql);
  },
  IFEMPTY: ({ arg }) => {
    const empty = sql`(${arg(0).sql} IS NULL OR (${arg(0).sql})::text = '')`;
    const errorSql =
      arg(0).errorSql === undefined && arg(1).errorSql === undefined
        ? undefined
        : sql`(${formulaSqlError(arg(0))} OR (${empty} AND ${formulaSqlError(arg(1))}))`;
    return conditionalResult("IFEMPTY", arg(0), arg(1), sql`CASE WHEN ${empty} THEN ${arg(1).sql} ELSE ${arg(0).sql} END`, errorSql);
  },
  IFERROR: ({ arg }) => {
    const sourceError = formulaSqlError(arg(0));
    const errorSql =
      arg(0).errorSql === undefined || arg(1).errorSql === undefined ? undefined : sql`(${sourceError} AND ${arg(1).errorSql})`;
    return conditionalResult("IFERROR", arg(0), arg(1), sql`CASE WHEN ${sourceError} THEN ${arg(1).sql} ELSE ${arg(0).sql} END`, errorSql);
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
} satisfies Record<FormulaFunctionName, FormulaFunctionCompiler>;

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
  const results = compileArgs(args);
  const error = results.find((result): result is Extract<FormulaSqlCompileResult, { ok: false }> => !result.ok);
  if (error) return error;
  const compiled = results.map((result) => (result as Extract<FormulaSqlCompileResult, { ok: true }>).expression);
  const arg = (index: number): FormulaSqlExpression => compiled[index] ?? { sql: sql`NULL`, type: "unknown" };
  const compiler = FORMULA_FUNCTION_COMPILERS[upper as FormulaFunctionName] as FormulaFunctionCompiler | undefined;
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
  return formulaSqlOk(
    result.expression.sql,
    result.expression.type,
    formulaSqlOrErrors([formulaSqlAnyError(compiled), result.expression.errorSql]),
  );
};
