import { z } from "zod";
import type { Expr, Literal } from "../formula/types";
import type { DslQueryAst } from "./types";

export const GQL_PARAMETER_LIMITS = { names: 100, characters: 20_000, listItems: 10_000 } as const;
export const GqlParameterNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const parameterScalarSchema = z.union([
  z
    .string()
    .max(GQL_PARAMETER_LIMITS.characters)
    .refine((value) => !value.includes("\0")),
  z
    .number()
    .finite()
    .refine((value) => !Number.isInteger(value) || Number.isSafeInteger(value)),
  z.boolean(),
  z.null(),
  z
    .object({
      decimal: z
        .string()
        .max(GQL_PARAMETER_LIMITS.characters)
        .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/)
        .refine((value) => Number.isFinite(Number(value))),
    })
    .strict(),
]);
/** Shared transport and binder budget: parameters cannot bypass GQL's source limit. */
export const GqlParametersSchema = z
  .record(GqlParameterNameSchema, z.union([parameterScalarSchema, z.array(parameterScalarSchema).max(GQL_PARAMETER_LIMITS.listItems)]))
  .refine((value) => Object.keys(value).length <= GQL_PARAMETER_LIMITS.names, "At most 100 query parameters are allowed")
  .refine(
    (value) => JSON.stringify(value).length <= GQL_PARAMETER_LIMITS.characters,
    "Query parameter JSON must fit within 20000 characters",
  );

export type DslQueryContextKey =
  | "auth.id"
  | "auth.name"
  | "auth.username"
  | "auth.email"
  | "auth.subjects"
  | `params.${string}`
  | "page.id"
  | "page.title"
  | "page.url"
  | "app.id"
  | "app.name"
  | "base.id"
  | "base.name"
  | "time.now"
  | "time.today"
  | "time.timeZone";

/** Explicit numeric binding without converting an exact decimal to a JS number.
 * Ordinary strings remain text; this is internal context data, not GQL syntax. */
export type DslDecimalParameter = { decimal: string };
/** Arrays are accepted only by membership predicates. */
export type DslQueryParameterValue = Literal | DslDecimalParameter | readonly (Literal | DslDecimalParameter)[];

export type DslQueryContextValues = {
  "auth.id": string | null;
  "auth.name": string | null;
  "auth.username": string | null;
  "auth.email": string | null;
  "auth.subjects": string[];
  "page.id": string;
  "page.title": string;
  "page.url": string;
  "app.id": string;
  "app.name": string;
  "base.id": string;
  "base.name": string;
  "time.now": string;
  "time.today": string;
  "time.timeZone": string;
} & Partial<Record<`params.${string}`, DslQueryParameterValue>>;

type BindDslQueryContextResult = { ok: true; ast: DslQueryAst } | { ok: false; error: string };

export type DslQueryContextInput = Readonly<Partial<DslQueryContextValues>>;

const FIXED_CONTEXT_KEYS = new Set<DslQueryContextKey>([
  "auth.id",
  "auth.name",
  "auth.username",
  "auth.email",
  "auth.subjects",
  "page.id",
  "page.title",
  "page.url",
  "app.id",
  "app.name",
  "base.id",
  "base.name",
  "time.now",
  "time.today",
  "time.timeZone",
]);
const PARAM_CONTEXT_KEY = /^params\.[a-z][a-z0-9_]*$/;

export const isDslQueryContextKey = (value: string): value is DslQueryContextKey =>
  FIXED_CONTEXT_KEYS.has(value as DslQueryContextKey) || PARAM_CONTEXT_KEY.test(value);

const isContextValue = (value: unknown): value is string | null => value === null || (typeof value === "string" && !value.includes("\0"));
const isParameterScalar = (value: unknown): value is Literal =>
  isContextValue(value) ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
const parameterLiteral = (value: unknown): Extract<Expr, { kind: "literal" }> | null => {
  if (isParameterScalar(value)) return { kind: "literal", value };
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "decimal" in value &&
    Object.keys(value).length === 1 &&
    typeof value.decimal === "string" &&
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.decimal) &&
    Number.isFinite(Number(value.decimal))
  ) {
    return { kind: "literal", value: Number(value.decimal), numericSource: value.decimal };
  }
  return null;
};
const MEMBERSHIP_FUNCTIONS = new Set(["ONEOF", "NONEOF", "CONTAINSALL"]);

const contextPath = (expression: Extract<Expr, { kind: "call" }>): string | null => {
  if (expression.fn !== "@" || expression.args.length !== 1) return null;
  const [path] = expression.args;
  return path?.kind === "literal" && typeof path.value === "string" ? path.value : null;
};

const collectExpressionContextKeys = (expression: Expr, keys: Set<DslQueryContextKey>): void => {
  if (expression.kind === "call") {
    if (expression.fn === "@") {
      const path = contextPath(expression);
      if (path && isDslQueryContextKey(path)) keys.add(path);
    }
    for (const argument of expression.args) collectExpressionContextKeys(argument, keys);
    return;
  }
  if (expression.kind === "binop") {
    collectExpressionContextKeys(expression.left, keys);
    collectExpressionContextKeys(expression.right, keys);
    return;
  }
  if (expression.kind === "unop") collectExpressionContextKeys(expression.operand, keys);
};

/** Return every valid implicit context reference used by one parsed GQL query. */
export const dslQueryContextKeys = (ast: DslQueryAst): DslQueryContextKey[] => {
  const keys = new Set<DslQueryContextKey>();
  for (const item of ast.select) if (item.kind === "formula") collectExpressionContextKeys(item.expression, keys);
  for (const item of ast.aggregations) {
    if (item.argument !== "*" && "kind" in item.argument && item.argument.kind === "formula") {
      collectExpressionContextKeys(item.argument.expression, keys);
    }
  }
  if (ast.where) collectExpressionContextKeys(ast.where.expression, keys);
  if (ast.having) collectExpressionContextKeys(ast.having.expression, keys);
  return [...keys].sort();
};

export type BindDslQueryContextOptions = {
  /** Publication only: check parameter types without treating samples as actual option values. */
  parameterTypesOnly?: boolean;
};

const bindExpression = (expression: Expr, values: DslQueryContextInput, options: BindDslQueryContextOptions): Expr | string => {
  if (expression.kind === "call" && expression.fn === "PARAM") {
    return "param() is not supported; use @params.<name>";
  }
  if (expression.kind === "call" && expression.fn === "@") {
    const path = contextPath(expression);
    if (!path || !isDslQueryContextKey(path)) return `Unknown query context reference "@${path ?? ""}"`;
    if (!Object.hasOwn(values, path)) return `Missing query context value "@${path}"`;
    const value = values[path as keyof DslQueryContextValues];
    if (Array.isArray(value)) return `Query context reference "@${path}" is only valid inside oneof, noneof, or containsall`;
    const literal = parameterLiteral(value);
    if (!literal || (!path.startsWith("params.") && !isContextValue(value))) {
      return `Invalid query context value "@${path}"`;
    }
    return {
      ...literal,
      ...(options.parameterTypesOnly && path.startsWith("params.") ? { parameterTypeOnly: true as const } : {}),
      ...(expression.span ? { span: expression.span } : {}),
    };
  }
  if (expression.kind === "call") {
    const args: Expr[] = [];
    for (const argument of expression.args) {
      const path = argument.kind === "call" && argument.fn === "@" ? contextPath(argument) : null;
      const contextValue = path && isDslQueryContextKey(path) ? values[path] : undefined;
      if (path && (path === "auth.subjects" || (path.startsWith("params.") && Array.isArray(contextValue)))) {
        if (!MEMBERSHIP_FUNCTIONS.has(expression.fn)) {
          return `Query context reference "@${path}" is only valid inside oneof, noneof, or containsall`;
        }
        if (!Array.isArray(contextValue)) return `Invalid query context value "@${path}"`;
        // Array.from also exposes sparse entries, which must not become missing operands.
        const entries = Array.from(contextValue);
        for (const value of entries) {
          const literal = parameterLiteral(value);
          if (!literal || (path === "auth.subjects" && typeof value !== "string")) {
            return `Invalid query context value "@${path}"`;
          }
          args.push({
            ...literal,
            ...(options.parameterTypesOnly && path.startsWith("params.") ? { parameterTypeOnly: true as const } : {}),
            ...(argument.span ? { span: argument.span } : {}),
          });
        }
        continue;
      }
      const bound = bindExpression(argument, values, options);
      if (typeof bound === "string") return bound;
      args.push(bound);
    }
    return { ...expression, args };
  }
  if (expression.kind === "binop") {
    const left = bindExpression(expression.left, values, options);
    if (typeof left === "string") return left;
    const right = bindExpression(expression.right, values, options);
    if (typeof right === "string") return right;
    return { ...expression, left, right };
  }
  if (expression.kind === "unop") {
    const operand = bindExpression(expression.operand, values, options);
    return typeof operand === "string" ? operand : { ...expression, operand };
  }
  return expression;
};

export const bindDslQueryContext = (
  ast: DslQueryAst,
  values: DslQueryContextInput = {},
  options: BindDslQueryContextOptions = {},
): BindDslQueryContextResult => {
  const parameters = Object.fromEntries(
    Object.entries(values)
      .filter(([key]) => key.startsWith("params."))
      .map(([key, value]) => [key.slice(7), value]),
  );
  const checked = GqlParametersSchema.safeParse(parameters);
  if (!checked.success) {
    const name = checked.error.issues[0]?.path[0];
    return {
      ok: false,
      error: typeof name === "string" ? `Invalid query context value "@params.${name}"` : "Query parameters exceed the shared input budget",
    };
  }
  const bind = (expression: Expr): Expr | string => bindExpression(expression, values, options);

  const select: DslQueryAst["select"] = [];
  for (const item of ast.select) {
    if (item.kind !== "formula") {
      select.push(item);
      continue;
    }
    const expression = bind(item.expression);
    if (typeof expression === "string") return { ok: false, error: expression };
    select.push({ ...item, expression });
  }

  const aggregations: DslQueryAst["aggregations"] = [];
  for (const item of ast.aggregations) {
    if (item.argument === "*" || !("kind" in item.argument) || item.argument.kind !== "formula") {
      aggregations.push(item);
      continue;
    }
    const expression = bind(item.argument.expression);
    if (typeof expression === "string") return { ok: false, error: expression };
    aggregations.push({ ...item, argument: { ...item.argument, expression } });
  }

  const where = ast.where ? bind(ast.where.expression) : undefined;
  if (typeof where === "string") return { ok: false, error: where };
  const having = ast.having ? bind(ast.having.expression) : undefined;
  if (typeof having === "string") return { ok: false, error: having };

  return {
    ok: true,
    ast: {
      ...ast,
      select,
      aggregations,
      ...(ast.where ? { where: { ...ast.where, expression: where! } } : {}),
      ...(ast.having ? { having: { ...ast.having, expression: having! } } : {}),
    },
  };
};
