import { normalizeTimeZone } from "@k2b/cloud/shared";
import { sql } from "bun";
import { ObjectListConfigSchema } from "../field-types/object-list";
import type { ListFormulaFunctionName } from "../formula/function-catalog";
import { parseFormula } from "../formula/parser";
import type { BinOp, Expr } from "../formula/types";
import { normalizeRefKey } from "../ref-syntax";
import { scalarSqlTypeForField, storageOf } from "./field-storage";
import { finalizedFieldSql } from "./finalized-field-sql";
import { compileFormulaFunction } from "./formula-sql-functions";
import {
  type FormulaSqlCompileResult,
  type FormulaSqlExpression,
  type FormulaSqlType,
  formulaSqlAnyError,
  formulaSqlAsBoolean,
  formulaSqlAsDate,
  formulaSqlAsNullableText,
  formulaSqlAsNumeric,
  formulaSqlAsTimestamp,
  formulaSqlError,
  formulaSqlFail,
  formulaSqlLiteral,
  formulaSqlOk,
  formulaSqlOrErrors,
} from "./formula-sql-values";
import { numericAverageSql, numericDivideSql } from "./numeric-division-sql";
import { compileObjectListValue } from "./object-list-sql";
import type { Field } from "./types";

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/i;
export const MAX_FORMULA_INLINE_DEPTH = 8;

export type FormulaSqlFieldResolver = (ref: string) => (FormulaSqlExpression & { objectListConfig?: Field["config"] }) | string | null;

type FormulaSqlCompileOptions = {
  fields: Field[];
  /** Trusted SQL alias for the records table. Defaults to `r`. */
  recordAlias?: string;
  dateConfig?: import("@k2b/stdlib").DateContext;
  now?: Date;
  resolveField?: FormulaSqlFieldResolver;
  /** Pre-built typed SQL for computed fields (by field id). */
  computedFieldSql?: Map<string, FormulaSqlExpression>;
  /** Virtual tables calculate their own formulas over already projected source values. */
  useFinalizedFormulaValues?: boolean;
  /** GQL-only support for explicit scoped refs such as customer.name. */
  scopedRefs?: boolean;
};

type CompileContext = Required<Pick<FormulaSqlCompileOptions, "recordAlias" | "now">> &
  Pick<FormulaSqlCompileOptions, "dateConfig" | "resolveField" | "computedFieldSql" | "useFinalizedFormulaValues"> & {
    fieldsByRef: Map<string, Field[]>;
    inlineStack: Set<string>;
    depth: number;
  };

const addFieldRef = (map: Map<string, Field[]>, ref: string | null | undefined, field: Field): void => {
  if (!ref) return;
  const key = normalizeRefKey(ref);
  const existing = map.get(key) ?? [];
  if (!existing.some((item) => item.id === field.id)) existing.push(field);
  map.set(key, existing);
};

const buildFieldMap = (fields: Field[]): Map<string, Field[]> => {
  const map = new Map<string, Field[]>();
  for (const field of fields) {
    addFieldRef(map, field.shortId, field);
    addFieldRef(map, field.name, field);
  }
  return map;
};

const fieldByRef = (map: Map<string, Field[]>, ref: string): Field | string => {
  const candidates = (map.get(normalizeRefKey(ref)) ?? []).filter((field) => field.deletedAt === null);
  if (candidates.length === 0) return `Unknown formula field reference "${ref}"`;
  if (candidates.length > 1) return `Ambiguous formula field reference "${ref}"`;
  return candidates[0]!;
};

export const formulaSqlTypeForField = (field: Field): FormulaSqlType => scalarSqlTypeForField(field);

type ComparisonOperator = Extract<BinOp, "!=" | "<" | "<=" | "=" | ">" | ">=">;
type ArithmeticOperator = Extract<BinOp, "%" | "*" | "+" | "-" | "/">;

const NUMERIC_COMPARISON_RE = "^-?[0-9]+(\\.[0-9]+)?$";
const DATE_COMPARISON_RE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";
const INSTANT_COMPARISON_RE = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,9})?)?([zZ]|[+-][0-9]{2}:?[0-9]{2})$";

type ComparisonValue = {
  raw: unknown;
  numeric: unknown;
  numericShaped: unknown;
  temporal: unknown;
  temporalShaped: unknown;
  boolean: unknown;
  booleanShaped: boolean;
};

const comparisonValue = (expression: FormulaSqlExpression, timeZone: string): ComparisonValue => {
  const raw = formulaSqlAsNullableText(expression);
  const textLike = expression.type === "text" || expression.type === "unknown";
  const numericShaped = expression.type === "numeric" ? sql`true` : textLike ? sql`(${raw} ~ ${NUMERIC_COMPARISON_RE})` : sql`false`;
  const temporalShaped =
    expression.type === "date" || expression.type === "datetime"
      ? sql`true`
      : textLike
        ? sql`(${raw} ~ ${DATE_COMPARISON_RE} OR ${raw} ~ ${INSTANT_COMPARISON_RE})`
        : sql`false`;
  const temporal =
    expression.type === "date"
      ? sql`(${formulaSqlAsDate(expression)})::timestamp AT TIME ZONE ${timeZone}`
      : expression.type === "datetime"
        ? formulaSqlAsTimestamp(expression)
        : sql`CASE
            WHEN ${raw} ~ ${DATE_COMPARISON_RE} THEN (grids.try_iso_date(${raw}))::timestamp AT TIME ZONE ${timeZone}
            WHEN ${raw} ~ ${INSTANT_COMPARISON_RE} THEN grids.try_timestamptz(${raw})
            ELSE NULL::timestamptz
          END`;
  return {
    raw,
    numeric: formulaSqlAsNumeric(expression),
    numericShaped,
    temporal,
    temporalShaped,
    boolean: expression.type === "boolean" ? expression.sql : sql`NULL::boolean`,
    booleanShaped: expression.type === "boolean",
  };
};

const orderedComparison = (op: Exclude<ComparisonOperator, "!=" | "=">, left: unknown, right: unknown): unknown => {
  if (op === "<") return sql`(${left} < ${right})`;
  if (op === "<=") return sql`(${left} <= ${right})`;
  if (op === ">") return sql`(${left} > ${right})`;
  return sql`(${left} >= ${right})`;
};

const equalityComparison = (left: ComparisonValue, right: ComparisonValue): unknown => {
  const numericMode = sql`(${left.numericShaped} OR ${right.numericShaped})`;
  const temporalMode = sql`(${left.temporalShaped} OR ${right.temporalShaped})`;
  const booleanMode = left.booleanShaped || right.booleanShaped;
  return sql`CASE
    WHEN ${left.raw} IS NULL OR ${right.raw} IS NULL THEN (${left.raw} IS NULL AND ${right.raw} IS NULL)
    WHEN ${numericMode} THEN (${left.numeric} IS NOT DISTINCT FROM ${right.numeric})
    WHEN ${temporalMode} THEN (${left.temporal} IS NOT DISTINCT FROM ${right.temporal})
    WHEN ${booleanMode} THEN ${left.booleanShaped && right.booleanShaped ? sql`(${left.boolean} IS NOT DISTINCT FROM ${right.boolean})` : sql`false`}
    ELSE (${left.raw} IS NOT DISTINCT FROM ${right.raw})
  END`;
};

const orderingComparison = (op: Exclude<ComparisonOperator, "!=" | "=">, left: ComparisonValue, right: ComparisonValue): unknown => {
  const numericMode = sql`(${left.numericShaped} OR ${right.numericShaped})`;
  const temporalMode = sql`(${left.temporalShaped} OR ${right.temporalShaped})`;
  const booleanMode = left.booleanShaped || right.booleanShaped;
  return sql`CASE
    WHEN ${left.raw} IS NULL OR ${right.raw} IS NULL THEN NULL::boolean
    WHEN ${numericMode} THEN ${orderedComparison(op, left.numeric, right.numeric)}
    WHEN ${temporalMode} THEN ${orderedComparison(op, left.temporal, right.temporal)}
    WHEN ${booleanMode} THEN ${left.booleanShaped && right.booleanShaped ? orderedComparison(op, left.boolean, right.boolean) : sql`NULL::boolean`}
    ELSE ${orderedComparison(op, left.raw, right.raw)}
  END`;
};

const compileComparison = (
  op: ComparisonOperator,
  leftExpression: FormulaSqlExpression,
  rightExpression: FormulaSqlExpression,
  context: CompileContext,
): FormulaSqlCompileResult => {
  const timeZone = normalizeTimeZone(context.dateConfig?.timeZone, "UTC");
  const left = comparisonValue(leftExpression, timeZone);
  const right = comparisonValue(rightExpression, timeZone);
  const errorSql = formulaSqlAnyError([leftExpression, rightExpression]);
  if (op === "=" || op === "!=") {
    const equal = equalityComparison(left, right);
    return formulaSqlOk(op === "=" ? equal : sql`NOT ${equal}`, "boolean", errorSql);
  }
  return formulaSqlOk(orderingComparison(op, left, right), "boolean", errorSql);
};

const compileArithmetic = (op: ArithmeticOperator, left: FormulaSqlExpression, right: FormulaSqlExpression): FormulaSqlCompileResult => {
  const inheritedError = formulaSqlAnyError([left, right]);
  if (op === "+") {
    if (left.type === "text" && right.type === "text") {
      const leftText = formulaSqlAsNullableText(left);
      const rightText = formulaSqlAsNullableText(right);
      const leftNumeric = formulaSqlAsNumeric(left);
      const rightNumeric = formulaSqlAsNumeric(right);
      return formulaSqlOk(
        sql`CASE
          WHEN ${leftText} IS NULL OR ${rightText} IS NULL THEN NULL::text
          WHEN ${leftNumeric} IS NOT NULL AND ${rightNumeric} IS NOT NULL
            THEN trim_scale(${leftNumeric} + ${rightNumeric})::text
          ELSE ${leftText} || ${rightText}
        END`,
        "text",
        inheritedError,
      );
    }
    return formulaSqlOk(sql`(${formulaSqlAsNumeric(left)} + ${formulaSqlAsNumeric(right)})`, "numeric", inheritedError);
  }
  if (op === "-") return formulaSqlOk(sql`(${formulaSqlAsNumeric(left)} - ${formulaSqlAsNumeric(right)})`, "numeric", inheritedError);
  if (op === "*") return formulaSqlOk(sql`(${formulaSqlAsNumeric(left)} * ${formulaSqlAsNumeric(right)})`, "numeric", inheritedError);
  const leftSql = formulaSqlAsNumeric(left);
  const rightSql = formulaSqlAsNumeric(right);
  const ownError = sql`(${leftSql} IS NOT NULL AND ${rightSql} = 0)`;
  const errorSql = formulaSqlOrErrors([inheritedError, ownError]);
  if (op === "/") {
    return formulaSqlOk(numericDivideSql(leftSql, rightSql), "numeric", errorSql);
  }
  return formulaSqlOk(sql`MOD(${leftSql}, NULLIF(${rightSql}, 0))`, "numeric", errorSql);
};

const compileBinaryOperator = (
  op: BinOp,
  left: FormulaSqlExpression,
  right: FormulaSqlExpression,
  context: CompileContext,
): FormulaSqlCompileResult => {
  if (op === "&&" || op === "||") {
    const leftSql = formulaSqlAsBoolean(left);
    const rightSql = formulaSqlAsBoolean(right);
    const evaluateRight = op === "&&" ? leftSql : sql`NOT ${leftSql}`;
    const errorSql =
      left.errorSql === undefined && right.errorSql === undefined
        ? undefined
        : sql`(${formulaSqlError(left)} OR (${evaluateRight} AND ${formulaSqlError(right)}))`;
    return formulaSqlOk(op === "&&" ? sql`(${leftSql} AND ${rightSql})` : sql`(${leftSql} OR ${rightSql})`, "boolean", errorSql);
  }
  if (op === "=" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
    return compileComparison(op, left, right, context);
  }
  return compileArithmetic(op, left, right);
};

const inlineFormulaField = (field: Field, context: CompileContext): FormulaSqlCompileResult => {
  if (context.inlineStack.has(field.id)) return formulaSqlFail(`Formula field "${field.name}" references itself (cycle)`);
  if (context.depth >= MAX_FORMULA_INLINE_DEPTH) return formulaSqlFail(`Formula nesting is too deep at field "${field.name}"`);
  const expression = (field.config as { expression?: unknown }).expression;
  if (typeof expression !== "string" || expression.trim().length === 0) {
    return formulaSqlFail(`Formula field "${field.name}" has no expression`);
  }
  const parsed = parseFormula(expression);
  if (!parsed.ok) return formulaSqlFail(`Formula field "${field.name}": ${parsed.error}`);
  const inlineStack = new Set(context.inlineStack);
  inlineStack.add(field.id);
  const compiled = compileExpression(parsed.ast, { ...context, inlineStack, depth: context.depth + 1 });
  return compiled.ok && context.useFinalizedFormulaValues !== false
    ? { ok: true, expression: finalizedFieldSql(field.id, compiled.expression, context.recordAlias) }
    : compiled;
};

const compileFieldExpression = (expression: Extract<Expr, { kind: "field" }>, context: CompileContext): FormulaSqlCompileResult => {
  const custom = context.resolveField?.(expression.fieldId);
  if (typeof custom === "string") return formulaSqlFail(custom);
  if (custom) return formulaSqlOk(custom.sql, custom.type, custom.errorSql);
  const field = fieldByRef(context.fieldsByRef, expression.fieldId);
  if (typeof field === "string") return formulaSqlFail(field);
  if (field.type === "formula" || field.type === "lookup" || field.type === "rollup") {
    const computed = context.computedFieldSql?.get(field.id);
    if (computed) return formulaSqlOk(computed.sql, computed.type, computed.errorSql);
  }
  if (field.type === "formula") return inlineFormulaField(field, context);
  const projection = storageOf(field).project(field, context.recordAlias);
  if (projection === null) return formulaSqlFail(`Field ${field.name} (${field.type}) cannot be compiled into SQL formulas yet`);
  return formulaSqlOk(projection, formulaSqlTypeForField(field));
};

const compileUnaryExpression = (expression: Extract<Expr, { kind: "unop" }>, context: CompileContext): FormulaSqlCompileResult => {
  const operand = compileExpression(expression.operand, context);
  if (!operand.ok) return operand;
  if (expression.op === "-") {
    return formulaSqlOk(sql`(-${formulaSqlAsNumeric(operand.expression)})`, "numeric", operand.expression.errorSql);
  }
  return formulaSqlOk(sql`NOT ${formulaSqlAsBoolean(operand.expression)}`, "boolean", operand.expression.errorSql);
};

const compileBinaryExpression = (expression: Extract<Expr, { kind: "binop" }>, context: CompileContext): FormulaSqlCompileResult => {
  const left = compileExpression(expression.left, context);
  if (!left.ok) return left;
  const right = compileExpression(expression.right, context);
  if (!right.ok) return right;
  return compileBinaryOperator(expression.op, left.expression, right.expression, context);
};

const compileListReduction = (fn: ListFormulaFunctionName, args: Expr[], context: CompileContext): FormulaSqlCompileResult => {
  const list = args[0];
  if (list?.kind !== "field") return formulaSqlFail(`${fn} needs an object-list field reference`);
  const custom = context.resolveField?.(list.fieldId);
  if (typeof custom === "string") return formulaSqlFail(custom);
  let configValue: Field["config"];
  let value: FormulaSqlCompileResult;
  if (custom) {
    if (!custom.objectListConfig) return formulaSqlFail(`${list.fieldId} is not an object-list field`);
    configValue = custom.objectListConfig;
    value = { ok: true, expression: custom };
  } else {
    const field = fieldByRef(context.fieldsByRef, list.fieldId);
    if (typeof field === "string") return formulaSqlFail(field);
    if (field.type !== "object_list") return formulaSqlFail(`${field.name} is not an object-list field`);
    configValue = field.config;
    value = compileObjectListValue(field, context.recordAlias, (ast, resolveField, recordAlias) =>
      compileExpression(ast, { ...context, fieldsByRef: new Map(), resolveField, recordAlias }),
    );
  }
  if (!value.ok) return value;
  const source = value.expression.sql;
  let reduction: unknown;
  if (fn === "LIST_COUNT") reduction = sql`jsonb_array_length(${source})::numeric`;
  else {
    const columnRef = args[1];
    if (columnRef?.kind !== "literal" || typeof columnRef.value !== "string")
      return formulaSqlFail(`${fn} needs a literal column name or ID`);
    const config = ObjectListConfigSchema.safeParse(configValue);
    if (!config.success) return formulaSqlFail("Invalid object-list configuration");
    const key = normalizeRefKey(columnRef.value);
    const column = config.data.fields.find((candidate) => normalizeRefKey(candidate.id) === key || normalizeRefKey(candidate.name) === key);
    if (!column || !["number", "percent", "duration"].includes(column.type)) return formulaSqlFail(`${fn} needs a numeric list column`);
    const aggregate = sql.unsafe(fn.slice("LIST_".length));
    const rows = sql`jsonb_array_elements(${source}) AS list_value(data)`;
    const numericValue = sql`grids.canonical_numeric(list_value.data->>${column.id})`;
    const aggregateValue = fn === "LIST_AVG" ? numericAverageSql(numericValue) : sql`${aggregate}(${numericValue})`;
    const aggregated = sql`(SELECT ${aggregateValue} FROM ${rows})`;
    reduction = fn === "LIST_SUM" ? sql`COALESCE(${aggregated}, 0::numeric)` : aggregated;
  }
  return formulaSqlOk(
    sql`CASE WHEN ${source} IS NULL OR ${source} = 'null'::jsonb THEN NULL ELSE ${reduction} END`,
    "numeric",
    value.expression.errorSql,
  );
};

const compileExpression = (expression: Expr, context: CompileContext): FormulaSqlCompileResult => {
  switch (expression.kind) {
    case "literal": {
      if (expression.numericSource !== undefined) return formulaSqlOk(sql`${expression.numericSource}::numeric`, "numeric");
      const literal = formulaSqlLiteral(expression.value);
      return formulaSqlOk(literal.sql, literal.type);
    }
    case "field":
      return compileFieldExpression(expression, context);
    case "unop":
      return compileUnaryExpression(expression, context);
    case "binop":
      return compileBinaryExpression(expression, context);
    case "call":
      return compileFormulaFunction(
        expression.fn,
        expression.args,
        { ...context, compileList: (fn, args) => compileListReduction(fn, args, context) },
        (args) => args.map((argument) => compileExpression(argument, context)),
      );
  }
};

export const compileFormulaAstToSql = (ast: Expr, options: FormulaSqlCompileOptions): FormulaSqlCompileResult => {
  const recordAlias = options.recordAlias ?? "r";
  if (!SQL_ALIAS.test(recordAlias)) return formulaSqlFail(`Unsafe SQL record alias ${recordAlias}`);
  return compileExpression(ast, {
    fieldsByRef: buildFieldMap(options.fields),
    recordAlias,
    dateConfig: options.dateConfig,
    now: options.now ?? new Date(),
    resolveField: options.resolveField,
    computedFieldSql: options.computedFieldSql,
    useFinalizedFormulaValues: options.useFinalizedFormulaValues,
    inlineStack: new Set(),
    depth: 0,
  });
};

export const compileFormulaPredicateAstToSql = (ast: Expr, options: FormulaSqlCompileOptions): FormulaSqlCompileResult => {
  const compiled = compileFormulaAstToSql(ast, options);
  if (!compiled.ok) return compiled;
  if (compiled.expression.type !== "boolean") return formulaSqlFail("Formula predicate must return a boolean value");
  return compiled;
};

export const compileFormulaSourceToSql = (source: string, options: FormulaSqlCompileOptions): FormulaSqlCompileResult => {
  const parsed = parseFormula(source, { scopedRefs: options.scopedRefs });
  if (!parsed.ok) return formulaSqlFail(parsed.error);
  return compileFormulaAstToSql(parsed.ast, options);
};

export const compileFormulaFieldToSql = (field: Field, options: FormulaSqlCompileOptions): FormulaSqlCompileResult =>
  compileFormulaAstToSql({ kind: "field", fieldId: field.shortId }, { ...options, resolveField: undefined });
