import { normalizeTimeZone } from "@k2b/cloud/shared";
import { sql } from "bun";
import { ObjectListConfigSchema } from "../field-types/object-list";
import type { ListFormulaFunctionName } from "../formula/function-catalog";
import { parseFormula } from "../formula/parser";
import { bindFormulaSelects, type FormulaSelect } from "../formula/select-binding";
import { formulaSelectText } from "../formula/select-messages";
import type { BinOp, Expr } from "../formula/types";
import { normalizeRefKey } from "../ref-syntax";
import { compileDocumentQueryExpression, DOCUMENT_QUERY_FUNCTIONS } from "./document-query-expression";
import { scalarSqlTypeForField, storageOf } from "./field-storage";
import { finalizedFieldSql } from "./finalized-field-sql";
import { formulaNumericAggregate, formulaNumericOperation, withFormulaErrors } from "./formula-numeric-sql";
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
  joinFormulaSql,
} from "./formula-sql-values";
import { compileObjectListValue } from "./object-list-sql";
import type { Field } from "./types";

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/i;
export const MAX_FORMULA_INLINE_DEPTH = 8;

export type FormulaSqlFieldResolver = (
  ref: string,
) => (FormulaSqlExpression & { objectListConfig?: Field["config"]; select?: FormulaSelect }) | string | null;

type FormulaSqlCompileOptions = {
  /** Only authorized GQL row queries may inspect current document metadata. */
  documentMetadata?: boolean;
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
  requireCapturedValues?: boolean;
  authorizedTableIds?: ReadonlySet<string>;
  /** GQL-only support for explicit scoped refs such as customer.name. */
  scopedRefs?: boolean;
};

type CompileContext = Required<Pick<FormulaSqlCompileOptions, "recordAlias" | "now">> &
  Pick<
    FormulaSqlCompileOptions,
    | "dateConfig"
    | "resolveField"
    | "computedFieldSql"
    | "useFinalizedFormulaValues"
    | "authorizedTableIds"
    | "requireCapturedValues"
    | "documentMetadata"
  > & {
    fieldsByRef: Map<string, Field[]>;
    inlineStack: Set<string>;
    depth: number;
    steps: unknown[];
    named: unknown[];
    budget: { stages: number };
    fieldValues: Map<string, FormulaSqlCompileResult>;
    resolvedRefs: Map<string, ReturnType<FormulaSqlFieldResolver>>;
    condition?: unknown;
  };

// Bound planning work across the dependency graph, independently of parse depth.
// This is an internal planning limit, not a claim about PostgreSQL bind counts.
const MAX_SQL_STAGES = 800;

const resolveField = (ref: string, context: CompileContext): ReturnType<FormulaSqlFieldResolver> => {
  if (!context.resolvedRefs.has(ref)) context.resolvedRefs.set(ref, context.resolveField?.(ref) ?? null);
  return context.resolvedRefs.get(ref) ?? null;
};

const stageExpression = (result: FormulaSqlCompileResult, context: CompileContext, liveOnly = false): FormulaSqlCompileResult => {
  if (!result.ok) return result;
  if (++context.budget.stages > MAX_SQL_STAGES) return formulaSqlFail("Formula SQL plan exceeds 800 calculation stages");
  const alias = sql.unsafe(`${context.recordAlias}_formula_${context.steps.length}`);
  const { rowSql, ...value } = result.expression;
  const live = sql`${sql.unsafe(context.recordAlias)}.finalized_at IS NULL`;
  const condition =
    liveOnly && context.useFinalizedFormulaValues !== false
      ? context.condition === undefined
        ? live
        : sql`(${context.condition} AND ${live})`
      : context.condition;
  context.steps.push(
    rowSql !== undefined && condition === undefined
      ? sql`CROSS JOIN LATERAL (${rowSql}) ${alias}`
      : sql`CROSS JOIN LATERAL (SELECT
    ${condition === undefined ? value.sql : sql`CASE WHEN ${condition} THEN ${value.sql} END`} AS value,
    ${condition === undefined ? (value.errorSql ?? sql`false`) : sql`CASE WHEN ${condition} THEN ${value.errorSql ?? sql`false`} ELSE false END`} AS error
    OFFSET 0) ${alias}`,
  );
  return {
    ok: true,
    expression: { ...value, sql: sql`${alias}.value`, ...(value.errorSql === undefined ? {} : { errorSql: sql`${alias}.error` }) },
  };
};

const finishPlan = (result: FormulaSqlCompileResult, context: CompileContext): FormulaSqlCompileResult => {
  if (!result.ok || (context.steps.length === 0 && context.named.length === 0)) return result;
  const from = sql`FROM (SELECT 1) AS formula_seed ${joinFormulaSql(context.steps, sql` `)}`;
  const withNamed = context.named.length ? sql`WITH ${joinFormulaSql(context.named, sql`, `)}` : sql``;
  return {
    ok: true,
    expression: {
      ...result.expression,
      rowSql: sql`${withNamed} SELECT ${result.expression.sql} AS value, ${result.expression.errorSql ?? sql`false`} AS error ${from} OFFSET 0`,
      sql: sql`(${withNamed} SELECT ${result.expression.sql} ${from})`,
      ...(result.expression.errorSql === undefined ? {} : { errorSql: sql`(${withNamed} SELECT ${result.expression.errorSql} ${from})` }),
    },
  };
};

/** MATERIALIZED CTEs are shared but demand-driven: an unused branch never reads them. */
const namedExpression = (
  key: string,
  context: CompileContext,
  build: (context: CompileContext) => FormulaSqlCompileResult,
): FormulaSqlCompileResult => {
  const cached = context.fieldValues.get(key);
  if (cached) return cached;
  const local = { ...context, steps: [], condition: undefined };
  const result = build(local);
  if (!result.ok) return result;
  if (++context.budget.stages > MAX_SQL_STAGES) return formulaSqlFail("Formula SQL plan exceeds 800 calculation stages");
  const name = sql.unsafe(`${context.recordAlias}_named_${context.named.length}`);
  context.named.push(
    result.expression.rowSql !== undefined
      ? sql`${name} AS MATERIALIZED (
    SELECT calculation.value, calculation.error
    FROM (SELECT 1) AS named_seed ${joinFormulaSql(local.steps, sql` `)}
    CROSS JOIN LATERAL (${result.expression.rowSql}) calculation
  )`
      : sql`${name} AS MATERIALIZED (
    SELECT ${result.expression.sql} AS value, ${result.expression.errorSql ?? sql`false`} AS error
    FROM (SELECT 1) AS named_seed ${joinFormulaSql(local.steps, sql` `)}
  )`,
  );
  const reference = formulaSqlOk(
    sql`(SELECT value FROM ${name})`,
    result.expression.type,
    result.expression.errorSql === undefined ? undefined : sql`(SELECT error FROM ${name})`,
  );
  context.fieldValues.set(key, reference);
  return reference;
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
      const added = formulaNumericOperation("+", leftNumeric, rightNumeric);
      return formulaSqlOk(
        sql`CASE
          WHEN ${leftText} IS NULL OR ${rightText} IS NULL THEN NULL::text
          WHEN ${leftNumeric} IS NOT NULL AND ${rightNumeric} IS NOT NULL
            THEN trim_scale(${added.sql})::text
          ELSE ${leftText} || ${rightText}
        END`,
        "text",
        formulaSqlOrErrors([inheritedError, added.errorSql]),
      );
    }
  }
  return {
    ok: true,
    expression: withFormulaErrors(formulaNumericOperation(op, formulaSqlAsNumeric(left), formulaSqlAsNumeric(right)), inheritedError),
  };
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
  const bound = bindSelects(parsed.ast, context);
  if (!bound.ok) return formulaSqlFail(bound.error);
  const compiled = compileExpression(bound.ast, { ...context, inlineStack, depth: context.depth + 1 });
  return compiled.ok && context.useFinalizedFormulaValues !== false
    ? {
        ok: true,
        expression: finalizedFieldSql(
          field.id,
          compiled.expression,
          context.recordAlias,
          context.authorizedTableIds,
          context.requireCapturedValues,
        ),
      }
    : compiled;
};

const compileFieldExpression = (expression: Extract<Expr, { kind: "field" }>, context: CompileContext): FormulaSqlCompileResult => {
  const custom = resolveField(expression.fieldId, context);
  if (typeof custom === "string") return formulaSqlFail(custom);
  if (custom) {
    if (custom.type === "json") return formulaSqlFail(formulaSelectText(context.dateConfig?.locale).nonScalar);
    return namedExpression(`scope:${expression.fieldId}`, context, () => ({ ok: true, expression: custom }));
  }
  const field = fieldByRef(context.fieldsByRef, expression.fieldId);
  if (typeof field === "string") return formulaSqlFail(field);
  const computed = context.computedFieldSql?.get(field.id);
  if (computed) {
    if (computed.type === "json") return formulaSqlFail(formulaSelectText(context.dateConfig?.locale).nonScalar);
    return namedExpression(field.id, context, () => ({ ok: true, expression: computed }));
  }
  if (field.type === "formula") {
    return namedExpression(field.id, context, (local) => inlineFormulaField(field, local));
  }
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
  const rightContext =
    expression.op === "&&" || expression.op === "||"
      ? conditionalContext(
          context,
          sql`NOT ${formulaSqlError(left.expression)} AND ${expression.op === "&&" ? formulaSqlAsBoolean(left.expression) : sql`NOT ${formulaSqlAsBoolean(left.expression)}`}`,
        )
      : context;
  const right = compileExpression(expression.right, rightContext);
  if (!right.ok) return right;
  return compileBinaryOperator(expression.op, left.expression, right.expression, context);
};

const conditionalContext = (context: CompileContext, condition: unknown): CompileContext => ({
  ...context,
  condition: context.condition === undefined ? condition : sql`(${context.condition} AND ${condition})`,
  // Named values belong to the row; only inline operations inherit this gate.
});

const compileCallArguments = (fn: string, args: Expr[], context: CompileContext): FormulaSqlCompileResult[] => {
  const results: FormulaSqlCompileResult[] = [];
  let branch = context;
  for (const [index, arg] of args.entries()) {
    if (index > 0) {
      const first = results[0];
      if (!first?.ok) return results;
      const value = first.expression;
      if (fn === "IF")
        branch = conditionalContext(
          context,
          sql`NOT ${formulaSqlError(value)} AND ${index === 1 ? formulaSqlAsBoolean(value) : sql`NOT ${formulaSqlAsBoolean(value)}`}`,
        );
      else if (fn === "IFERROR") branch = conditionalContext(context, formulaSqlError(value));
      else if (fn === "IFEMPTY")
        branch = conditionalContext(context, sql`NOT ${formulaSqlError(value)} AND (${value.sql} IS NULL OR (${value.sql})::text = '')`);
      else if (fn === "AND" || fn === "OR") {
        const previous = results[index - 1];
        if (!previous?.ok) return results;
        branch = conditionalContext(
          branch,
          sql`NOT ${formulaSqlError(previous.expression)} AND ${fn === "AND" ? formulaSqlAsBoolean(previous.expression) : sql`NOT ${formulaSqlAsBoolean(previous.expression)}`}`,
        );
      }
    }
    results.push(compileExpression(arg, branch));
  }
  return results;
};

const compileListReduction = (fn: ListFormulaFunctionName, args: Expr[], context: CompileContext): FormulaSqlCompileResult => {
  const list = args[0];
  if (list?.kind !== "field") return formulaSqlFail(`${fn} needs an object-list field reference`);
  const custom = resolveField(list.fieldId, context);
  if (typeof custom === "string") return formulaSqlFail(custom);
  let configValue: Field["config"];
  let value: FormulaSqlCompileResult;
  const listKey = `list:${normalizeRefKey(list.fieldId)}`;
  if (custom) {
    if (!custom.objectListConfig) return formulaSqlFail(`${list.fieldId} is not an object-list field`);
    configValue = custom.objectListConfig;
    value = namedExpression(listKey, context, () => ({ ok: true, expression: custom }));
  } else {
    const field = fieldByRef(context.fieldsByRef, list.fieldId);
    if (typeof field === "string") return formulaSqlFail(field);
    if (field.type !== "object_list") return formulaSqlFail(`${field.name} is not an object-list field`);
    configValue = field.config;
    // Finalization supplies already validated, calculated cells from its input snapshot.
    const prepared = context.computedFieldSql?.get(field.id);
    if (prepared && !ObjectListConfigSchema.safeParse(configValue).success) return formulaSqlFail("Invalid object-list configuration");
    value = namedExpression(listKey, context, (local) =>
      prepared
        ? { ok: true, expression: prepared }
        : stageExpression(
            compileObjectListValue(field, context.recordAlias, (ast, resolveField, recordAlias) => {
              const rowContext = {
                ...context,
                fieldsByRef: new Map<string, Field[]>(),
                resolveField,
                recordAlias,
                steps: [],
                named: [],
                fieldValues: new Map<string, FormulaSqlCompileResult>(),
                resolvedRefs: new Map(),
                condition: undefined,
                useFinalizedFormulaValues: false,
              };
              const bound = bindSelects(ast, rowContext);
              return bound.ok ? finishPlan(compileExpression(bound.ast, rowContext), rowContext) : formulaSqlFail(bound.error);
            }),
            local,
            context.depth > 0,
          ),
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
    if (fn === "LIST_SUM" || fn === "LIST_AVG") {
      const safeSource = sql`CASE WHEN ${source} IS NULL OR ${source} = 'null'::jsonb THEN '[]'::jsonb ELSE ${source} END`;
      const reduced = stageExpression(
        {
          ok: true,
          expression: formulaNumericAggregate(
            fn.slice("LIST_".length),
            sql`ARRAY(SELECT ${numericValue} FROM jsonb_array_elements(${safeSource}) AS list_value(data))`,
            fn === "LIST_SUM",
          ),
        },
        context,
      );
      if (!reduced.ok) return reduced;
      return formulaSqlOk(
        sql`CASE WHEN ${source} IS NULL OR ${source} = 'null'::jsonb THEN NULL ELSE ${reduced.expression.sql} END`,
        "numeric",
        formulaSqlAnyError([value.expression, reduced.expression]),
      );
    }
    const aggregateValue = sql`${aggregate}(${numericValue})`;
    const aggregated = sql`(SELECT ${aggregateValue} FROM ${rows})`;
    reduction = aggregated;
  }
  return formulaSqlOk(
    sql`CASE WHEN ${source} IS NULL OR ${source} = 'null'::jsonb THEN NULL ELSE ${reduction} END`,
    "numeric",
    value.expression.errorSql,
  );
};

const compileNode = (expression: Expr, context: CompileContext): FormulaSqlCompileResult => {
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
      if ((expression.fn === "HAS_OPTION" || expression.fn === "ISBLANK") && expression.args[0]?.kind === "field") {
        const ref = expression.args[0].fieldId;
        const custom = resolveField(ref, context);
        const field = fieldByRef(context.fieldsByRef, ref);
        if ((custom && typeof custom !== "string" && custom.select) || (typeof field !== "string" && field.type === "select")) {
          const prepared =
            custom && typeof custom !== "string" ? custom : typeof field !== "string" ? context.computedFieldSql?.get(field.id) : undefined;
          const source = prepared?.sql ?? sql`${sql.unsafe(context.recordAlias)}.data->${typeof field === "string" ? ref : field.id}`;
          return formulaSqlOk(
            expression.fn === "ISBLANK"
              ? sql`(${source} IS NULL OR ${source} = 'null'::jsonb OR ${source} = '[]'::jsonb)`
              : sql`COALESCE(${source} @> ${[expression.args[1]?.kind === "literal" ? expression.args[1].value : null]}::jsonb, false)`,
            "boolean",
            prepared?.errorSql,
          );
        }
      }
      if (DOCUMENT_QUERY_FUNCTIONS.has(expression.fn)) {
        if (!context.documentMetadata || context.depth > 0)
          return formulaSqlFail("Document metadata requires an authorized Grids row query");
        return compileDocumentQueryExpression(expression.fn, expression.args, context.recordAlias);
      }
      return compileFormulaFunction(
        expression.fn,
        expression.args,
        { ...context, compileList: (fn, args) => compileListReduction(fn, args, context) },
        (args) => compileCallArguments(expression.fn, args, context),
      );
  }
};

const compileExpression = (expression: Expr, context: CompileContext): FormulaSqlCompileResult => {
  const result = compileNode(expression, context);
  // Ordinary numeric arithmetic needs no evaluation barrier. Keep barriers inside
  // named formulas and conditional branches, where PostgreSQL must not eagerly
  // evaluate an unused operand during planning.
  if (
    result.ok &&
    result.expression.type === "numeric" &&
    result.expression.errorSql === undefined &&
    context.depth === 0 &&
    context.condition === undefined &&
    ((expression.kind === "binop" && ["+", "-", "*"].includes(expression.op)) || (expression.kind === "unop" && expression.op === "-"))
  )
    return result;
  // A named CTE can be planned even when never read. Keep its leaf operands
  // behind the same OFFSET 0 barrier so custom plans cannot fold failing calls.
  if ((expression.kind === "literal" || expression.kind === "field") && context.depth > 0) return stageExpression(result, context, true);
  // Leaves are cheap. Materialize each operation before its consumers repeat
  // value/error checks, keeping expansion linear in the dependency graph.
  return expression.kind === "literal" || expression.kind === "field" ? result : stageExpression(result, context, context.depth > 0);
};

const bindSelects = (ast: Expr, context: CompileContext) =>
  bindFormulaSelects(
    ast,
    (ref) => {
      const custom = resolveField(ref, context);
      if (custom && typeof custom !== "string") return custom.select;
      const field = fieldByRef(context.fieldsByRef, ref);
      return typeof field !== "string" && field.type === "select" ? field : undefined;
    },
    context.dateConfig?.locale,
  );

export const compileFormulaAstToSql = (ast: Expr, options: FormulaSqlCompileOptions): FormulaSqlCompileResult => {
  const recordAlias = options.recordAlias ?? "r";
  if (!SQL_ALIAS.test(recordAlias)) return formulaSqlFail(`Unsafe SQL record alias ${recordAlias}`);
  const context: CompileContext = {
    documentMetadata: options.documentMetadata,
    fieldsByRef: buildFieldMap(options.fields),
    recordAlias,
    dateConfig: options.dateConfig,
    now: options.now ?? new Date(),
    resolveField: options.resolveField,
    computedFieldSql: options.computedFieldSql,
    useFinalizedFormulaValues: options.useFinalizedFormulaValues,
    requireCapturedValues: options.requireCapturedValues,
    authorizedTableIds: options.authorizedTableIds,
    inlineStack: new Set(),
    depth: 0,
    steps: [],
    named: [],
    budget: { stages: 0 },
    fieldValues: new Map(),
    resolvedRefs: new Map(),
  };
  const bound = bindSelects(ast, context);
  return bound.ok ? finishPlan(compileExpression(bound.ast, context), context) : formulaSqlFail(bound.error);
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
