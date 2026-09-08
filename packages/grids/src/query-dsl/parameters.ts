import type { Expr } from "../formula/types";
import type { DslQueryAst } from "./types";

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
} & Partial<Record<`params.${string}`, string>>;

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

const isContextValue = (value: unknown): value is string | null => value === null || typeof value === "string";
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

const bindExpression = (expression: Expr, values: DslQueryContextInput): Expr | string => {
  if (expression.kind === "call" && expression.fn === "PARAM") {
    return "param() is not supported; use @params.<name>";
  }
  if (expression.kind === "call" && expression.fn === "@") {
    const path = contextPath(expression);
    if (!path || !isDslQueryContextKey(path)) return `Unknown query context reference "@${path ?? ""}"`;
    if (!Object.hasOwn(values, path)) return `Missing query context value "@${path}"`;
    const value = values[path as keyof DslQueryContextValues];
    if (Array.isArray(value)) return `Query context reference "@${path}" is only valid inside oneof, noneof, or containsall`;
    if (!isContextValue(value)) return `Invalid query context value "@${path}"`;
    return { kind: "literal", value, ...(expression.span ? { span: expression.span } : {}) };
  }
  if (expression.kind === "call") {
    const args: Expr[] = [];
    for (const argument of expression.args) {
      if (argument.kind === "call" && argument.fn === "@" && contextPath(argument) === "auth.subjects") {
        if (!MEMBERSHIP_FUNCTIONS.has(expression.fn)) {
          return 'Query context reference "@auth.subjects" is only valid inside oneof, noneof, or containsall';
        }
        const subjects = values["auth.subjects"];
        if (!Array.isArray(subjects) || subjects.some((value) => typeof value !== "string")) {
          return 'Invalid query context value "@auth.subjects"';
        }
        args.push(...subjects.map((value) => ({ kind: "literal" as const, value, ...(argument.span ? { span: argument.span } : {}) })));
        continue;
      }
      const bound = bindExpression(argument, values);
      if (typeof bound === "string") return bound;
      args.push(bound);
    }
    return { ...expression, args };
  }
  if (expression.kind === "binop") {
    const left = bindExpression(expression.left, values);
    if (typeof left === "string") return left;
    const right = bindExpression(expression.right, values);
    if (typeof right === "string") return right;
    return { ...expression, left, right };
  }
  if (expression.kind === "unop") {
    const operand = bindExpression(expression.operand, values);
    return typeof operand === "string" ? operand : { ...expression, operand };
  }
  return expression;
};

export const bindDslQueryContext = (ast: DslQueryAst, values: DslQueryContextInput = {}): BindDslQueryContextResult => {
  const bind = (expression: Expr): Expr | string => bindExpression(expression, values);

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
