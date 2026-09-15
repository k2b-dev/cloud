import { normalizeRefKey } from "../ref-syntax";
import { type CanonicalScope, formulaSource, recordMetaRef, resolveFieldRef } from "./canonical-expression-source";
import { type BindDslQueryContextOptions, bindDslQueryContext, type DslQueryContextInput } from "./parameters";
import {
  type DslResolvedRelationJoin,
  type DslResolvedSqlQueryPlan,
  type DslResolverContext,
  type DslResolverDiagnostic,
  resolveDslQueryToQueryPlan,
} from "./resolver";
import { gqlFieldRef, gqlQuotedRef, gqlSourceRef, gqlStringLiteral } from "./source-format";
import type { DslAggregateItem, DslQueryAst, DslSortItem } from "./types";

type CanonicalResult = { ok: true; source: string; plan: DslResolvedSqlQueryPlan } | { ok: false; diagnostics: DslResolverDiagnostic[] };

type DslAggregateFormulaArgument = Extract<DslAggregateItem["argument"], { kind: "formula" }>;

const sourceLine = (plan: DslResolvedSqlQueryPlan): string => {
  const source = gqlSourceRef(plan.source.kind, plan.source.shortId);
  return plan.sourceAlias ? `from ${source} as ${plan.sourceAlias}` : `from ${source}`;
};

const joinLine = (join: DslResolvedRelationJoin, scope: CanonicalScope): string => {
  const mode = join.mode === "left" ? "left join" : "join";
  const source = gqlSourceRef("table", join.source.shortId);
  const fromIdRef = join.fromScope ?? scope.sourceAlias ?? undefined;
  const fromId = fromIdRef ? `${fromIdRef}.id` : "id";
  const relationField = Object.values(scope.fieldsByTableId)
    .flat()
    .find((field) => field.id === join.relationFieldId);
  if (!relationField) throw new Error(`resolved join relation field ${join.relationFieldId} is not available`);
  const relationRef = gqlFieldRef(relationField.shortId);
  const fromRelation = join.fromScope ? `${join.fromScope}.${relationRef}` : relationRef;
  const on = join.direction === "forward" ? `${fromRelation} = ${join.alias}.id` : `${join.alias}.${relationRef} = ${fromId}`;
  return `${mode} ${source} as ${join.alias} on ${on}`;
};

const selectLine = (
  ast: DslQueryAst,
  scope: CanonicalScope,
): { ok: true; lines: string[] } | { ok: false; diagnostics: DslResolverDiagnostic[] } => {
  if (ast.select.length === 0) return { ok: true, lines: [] };
  const parts: string[] = [];
  for (const item of ast.select) {
    if (item.kind === "field") {
      const ref = resolveFieldRef(item.field, scope);
      if (!ref.ok) return { ok: false, diagnostics: [ref.diagnostic] };
      parts.push(item.alias ? `${ref.text} as ${item.alias}` : ref.text);
      continue;
    }
    const expression = formulaSource(item.expression, scope);
    if (!expression.ok) return { ok: false, diagnostics: [expression.diagnostic] };
    parts.push(`formula(${expression.text}) as ${item.alias}`);
  }
  return { ok: true, lines: [`select ${parts.join(", ")}`] };
};

const whereLine = (
  ast: DslQueryAst,
  scope: CanonicalScope,
): { ok: true; lines: string[] } | { ok: false; diagnostics: DslResolverDiagnostic[] } => {
  if (!ast.where) return { ok: true, lines: [] };
  const expression = formulaSource(ast.where.expression, scope);
  return expression.ok ? { ok: true, lines: [`where ${expression.text}`] } : { ok: false, diagnostics: [expression.diagnostic] };
};

const groupLine = (
  ast: DslQueryAst,
  scope: CanonicalScope,
): { ok: true; lines: string[] } | { ok: false; diagnostics: DslResolverDiagnostic[] } => {
  if (ast.groupBy.length === 0) return { ok: true, lines: [] };
  const parts: string[] = [];
  for (const group of ast.groupBy) {
    const ref = resolveFieldRef(group.field, scope);
    if (!ref.ok) return { ok: false, diagnostics: [ref.diagnostic] };
    parts.push(group.granularity ? `${ref.text} by ${group.granularity}` : ref.text);
  }
  return { ok: true, lines: [`group by ${parts.join(", ")}`] };
};

const aggregateLine = (
  ast: DslQueryAst,
  scope: CanonicalScope,
): { ok: true; lines: string[] } | { ok: false; diagnostics: DslResolverDiagnostic[] } => {
  if (ast.aggregations.length === 0) return { ok: true, lines: [] };
  const parts: string[] = [];
  for (const item of ast.aggregations) {
    const arg = aggregateArgumentSource(item, scope);
    if (!arg.ok) return { ok: false, diagnostics: [arg.diagnostic] };
    parts.push(`${item.fn}(${arg.text}) as ${item.alias}`);
  }
  return { ok: true, lines: [`aggregate ${parts.join(", ")}`] };
};

const aggregateArgumentSource = (
  item: DslAggregateItem,
  scope: CanonicalScope,
): { ok: true; text: string } | { ok: false; diagnostic: DslResolverDiagnostic } => {
  const argument = item.argument;
  if (argument === "*") return { ok: true, text: "*" };
  if (isAggregateFormulaArgument(argument)) {
    const expression = formulaSource(argument.expression, scope);
    return expression.ok ? { ok: true, text: `formula(${expression.text})` } : expression;
  }
  return resolveFieldRef(argument, scope);
};

const isAggregateFormulaArgument = (argument: DslAggregateItem["argument"]): argument is DslAggregateFormulaArgument =>
  typeof argument === "object" && argument !== null && "kind" in argument && argument.kind === "formula";

const havingLine = (
  ast: DslQueryAst,
  scope: CanonicalScope,
): { ok: true; lines: string[] } | { ok: false; diagnostics: DslResolverDiagnostic[] } => {
  if (!ast.having) return { ok: true, lines: [] };
  const aliases = new Set(ast.aggregations.map((item) => normalizeRefKey(item.alias)));
  const expression = formulaSource(ast.having.expression, scope, { aggregateAliases: aliases });
  return expression.ok ? { ok: true, lines: [`having ${expression.text}`] } : { ok: false, diagnostics: [expression.diagnostic] };
};

const sortLine = (
  ast: DslQueryAst,
  scope: CanonicalScope,
): { ok: true; lines: string[] } | { ok: false; diagnostics: DslResolverDiagnostic[] } => {
  if (ast.sort.length === 0) return { ok: true, lines: [] };
  const aliases = sortAliasMap(ast);
  const parts: string[] = [];
  for (const item of ast.sort) {
    const target = sortTargetSource(item.target, scope, aliases);
    if (!target.ok) return { ok: false, diagnostics: [target.diagnostic] };
    const nulls = item.nullsFirst === undefined ? "" : item.nullsFirst ? " nulls first" : " nulls last";
    parts.push(`${target.text} ${item.direction}${nulls}`);
  }
  return { ok: true, lines: [`sort ${parts.join(", ")}`] };
};

const sortAliasMap = (ast: DslQueryAst): Map<string, string> => {
  const aliases = new Map<string, string>();
  for (const item of ast.select) {
    if (item.alias) aliases.set(normalizeRefKey(item.alias), item.alias);
  }
  for (const item of ast.aggregations) aliases.set(normalizeRefKey(item.alias), item.alias);
  return aliases;
};

const sortTargetSource = (
  target: DslSortItem["target"],
  scope: CanonicalScope,
  aliases: ReadonlyMap<string, string>,
): { ok: true; text: string } | { ok: false; diagnostic: DslResolverDiagnostic } => {
  if ("kind" in target) return { ok: true, text: target.alias };
  const alias = !target.scope ? aliases.get(normalizeRefKey(target.ref)) : undefined;
  if (alias) return { ok: true, text: alias };
  const recordMeta = recordMetaRef(target);
  if (recordMeta) return { ok: true, text: recordMeta };
  return resolveFieldRef(target, scope);
};

const searchLine = (
  ast: DslQueryAst,
  scope: CanonicalScope,
): { ok: true; lines: string[] } | { ok: false; diagnostics: DslResolverDiagnostic[] } => {
  if (!ast.search) return { ok: true, lines: [] };
  const fields: string[] = [];
  for (const field of ast.search.fields) {
    const ref = resolveFieldRef(field, scope);
    if (!ref.ok) return { ok: false, diagnostics: [ref.diagnostic] };
    fields.push(ref.text);
  }
  return {
    ok: true,
    lines: [`search ${gqlStringLiteral(ast.search.q)}${fields.length > 0 ? ` in ${fields.join(", ")}` : ""}`],
  };
};

const staticLines = (ast: DslQueryAst): string[] => [
  ...(ast.limit !== undefined ? [`limit ${ast.limit}`] : []),
  ...(ast.offset !== undefined ? [`offset ${ast.offset}`] : []),
  ...(ast.deletedOnly ? ["deleted only"] : ast.includeDeleted ? ["include deleted"] : []),
];

/** Validate using bound values, while retaining parameter references in stored source. */
export const canonicalizeDslQuery = (
  ast: DslQueryAst,
  ctx: DslResolverContext,
  values?: DslQueryContextInput,
  options: BindDslQueryContextOptions = {},
): CanonicalResult => {
  const bound = values === undefined ? { ok: true as const, ast } : bindDslQueryContext(ast, values, options);
  if (!bound.ok) return { ok: false, diagnostics: [{ message: bound.error }] };
  const resolved = resolveDslQueryToQueryPlan(bound.ast, ctx);
  if (!resolved.ok) return resolved;
  const plan = resolved.plan;
  const scope: CanonicalScope = {
    tableId: plan.tableId,
    ...(plan.sourceAlias ? { sourceAlias: plan.sourceAlias } : {}),
    ...(plan.derivedViewSource ? { derivedColumns: plan.derivedViewSource.columns } : {}),
    fieldsByTableId: ctx.fieldsByTableId,
    joinsByAlias: new Map((plan.joins ?? []).map((join) => [normalizeRefKey(join.alias), join])),
    summariesByAlias: new Map((plan.summaryJoins ?? []).map((join) => [normalizeRefKey(join.alias), join])),
  };

  const lines: string[] = [sourceLine(plan), ...(plan.joins ?? []).map((join) => joinLine(join, scope))];
  for (const join of plan.summaryJoins ?? []) {
    lines.push(
      `left join ${gqlSourceRef("view", join.source.shortId)} as ${join.alias} on ${join.alias}.${gqlQuotedRef(join.group.publicKey ?? join.group.key)} = ${plan.sourceAlias ? `${plan.sourceAlias}.id` : "id"}`,
    );
  }
  for (const section of [
    selectLine(ast, scope),
    whereLine(ast, scope),
    groupLine(ast, scope),
    aggregateLine(ast, scope),
    havingLine(ast, scope),
    sortLine(ast, scope),
    searchLine(ast, scope),
  ]) {
    if (!section.ok) return { ok: false, diagnostics: section.diagnostics };
    lines.push(...section.lines);
  }
  lines.push(...staticLines(ast));

  return { ok: true, source: lines.join("\n"), plan };
};
