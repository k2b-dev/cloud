import { normalizeRefKey } from "../ref-syntax";
import type { Field } from "../service/types";
import type { DslResolverContext, DslTableSource } from "./resolver-context";
import { type DslDerivedViewColumn, derivedColumnByRef } from "./resolver-derived-columns";
import { type DslResolverDiagnostic, diagnostic, isResolverDiagnostic as isDiagnostic } from "./resolver-diagnostics";
import {
  aliveFields,
  buildComputedStub,
  buildFieldMap,
  fieldByRefMap,
  hasJoinAlias,
  isBaseScope,
  joinScopeByAlias,
  refUsesAlias,
  type Scope,
  setJoinAlias,
} from "./resolver-scope";
import { type ResolvedSource, resolveSource } from "./resolver-source";
import { type DslSummaryJoin, resolveSummaryJoin } from "./resolver-summary-joins";
import type { DslJoin } from "./types";

const MAX_JOIN_COUNT = 5;
const MAX_JOIN_DEPTH = 3;

export type DslResolvedRelationJoin = {
  mode: DslJoin["mode"];
  alias: string;
  direction: "forward" | "reverse";
  source: DslTableSource;
  tableId: string;
  fromScope: string | null;
  fromTableId: string;
  relationFieldId: string;
  depth: number;
};

export type DslResolvedDerivedRelationJoin = {
  mode: DslJoin["mode"];
  alias: string;
  source: DslTableSource;
  tableId: string;
  column: DslDerivedViewColumn;
  depth: number;
};

const scopedSource = (
  scope: Scope,
  source: ResolvedSource,
  alias: string | undefined,
): { tableId: string; fields: Field[]; byRef: Map<string, Field[]>; depth: number; alias?: string } | DslResolverDiagnostic => {
  if (!alias) return { tableId: source.tableId, fields: scope.fields, byRef: scope.byRef, depth: 0 };
  if (isBaseScope(scope, alias)) return { tableId: source.tableId, fields: scope.fields, byRef: scope.byRef, depth: 0 };
  const join = joinScopeByAlias(scope, alias);
  if (isDiagnostic(join)) return join;
  return join;
};

const resolveJoinSource = (join: DslJoin, ctx: DslResolverContext): DslTableSource | DslResolverDiagnostic => {
  const source = resolveSource(join.source, ctx);
  if (isDiagnostic(source)) return source;
  if (source.source.kind !== "table") return diagnostic(`join "${join.alias}" must target a table source`, join.span);
  return source.source;
};

const resolveRelationJoin = (
  join: DslJoin,
  source: ResolvedSource,
  scope: Scope,
  ctx: DslResolverContext,
): DslResolvedRelationJoin | DslResolverDiagnostic => {
  const targetSource = resolveJoinSource(join, ctx);
  if (isDiagnostic(targetSource)) return targetSource;
  if (hasJoinAlias(scope, join.alias)) return diagnostic(`duplicate join alias "${join.alias}"`, join.span);
  const targetFields = aliveFields(ctx.fieldsByTableId[targetSource.id] ?? []);
  const targetByRef = buildFieldMap(targetFields);

  const leftUsesAlias = refUsesAlias(join.on.left, join.alias);
  const rightUsesAlias = refUsesAlias(join.on.right, join.alias);
  if (leftUsesAlias === rightUsesAlias)
    return diagnostic(`join "${join.alias}" must compare one relation field to ${join.alias}.id`, join.span);

  const aliasSide = leftUsesAlias ? join.on.left : join.on.right;
  const fromSide = aliasSide === join.on.left ? join.on.right : join.on.left;

  const from = scopedSource(scope, source, fromSide.scope);
  if (isDiagnostic(from)) return from;

  const depth = from.depth + 1;
  if (depth > MAX_JOIN_DEPTH) return diagnostic(`join depth exceeds ${MAX_JOIN_DEPTH}`, join.span);

  const setJoinScope = () => {
    setJoinAlias(scope, join.alias, {
      alias: join.alias,
      tableId: targetSource.id,
      source: targetSource,
      fields: targetFields,
      byRef: targetByRef,
      computedStub: buildComputedStub(targetFields),
      depth,
    });
  };

  if (normalizeRefKey(aliasSide.ref) === "id") {
    const relationField = fieldByRefMap(
      from.byRef,
      fromSide.ref,
      `${fromSide.scope ? `${fromSide.scope}.` : ""}"${fromSide.ref}"`,
      fromSide.span,
    );
    if (isDiagnostic(relationField)) return relationField;
    if (relationField.type !== "relation")
      return diagnostic(`join "${join.alias}" must start from a relation field`, fromSide.span ?? join.span);
    const targetTableId = (relationField.config as { targetTableId?: string }).targetTableId;
    if (!targetTableId) return diagnostic(`join "${join.alias}" relation field has no target table`, fromSide.span ?? join.span);
    if (targetTableId !== targetSource.id)
      return diagnostic(`join "${join.alias}" target table does not match the relation field`, join.span);

    setJoinScope();
    return {
      mode: join.mode,
      alias: join.alias,
      direction: "forward",
      source: targetSource,
      tableId: targetSource.id,
      fromScope: from.alias ?? null,
      fromTableId: from.tableId,
      relationFieldId: relationField.id,
      depth,
    };
  }

  if (normalizeRefKey(fromSide.ref) !== "id")
    return diagnostic(`join "${join.alias}" must target ${join.alias}.id`, fromSide.span ?? join.span);
  const relationField = fieldByRefMap(targetByRef, aliasSide.ref, `${join.alias}."${aliasSide.ref}"`, aliasSide.span);
  if (isDiagnostic(relationField)) return relationField;
  if (relationField.type !== "relation")
    return diagnostic(`join "${join.alias}" must use a relation field on ${join.alias}`, aliasSide.span ?? join.span);
  const targetTableId = (relationField.config as { targetTableId?: string }).targetTableId;
  if (!targetTableId) return diagnostic(`join "${join.alias}" relation field has no target table`, aliasSide.span ?? join.span);
  if (targetTableId !== from.tableId)
    return diagnostic(`join "${join.alias}" reverse target table does not match the source id`, join.span);

  setJoinScope();
  return {
    mode: join.mode,
    alias: join.alias,
    direction: "reverse",
    source: targetSource,
    tableId: targetSource.id,
    fromScope: from.alias ?? null,
    fromTableId: from.tableId,
    relationFieldId: relationField.id,
    depth,
  };
};

export const resolveJoins = (
  joins: DslJoin[],
  source: ResolvedSource,
  scope: Scope,
  ctx: DslResolverContext,
): { joins: DslResolvedRelationJoin[]; summaryJoins: DslSummaryJoin[]; diagnostics: DslResolverDiagnostic[] } => {
  const diagnostics: DslResolverDiagnostic[] = [];
  const resolved: DslResolvedRelationJoin[] = [];
  const summaryJoins: DslSummaryJoin[] = [];
  if (joins.length > MAX_JOIN_COUNT)
    diagnostics.push(diagnostic(`query can join at most ${MAX_JOIN_COUNT} tables`, joins[MAX_JOIN_COUNT]?.span));
  for (const join of joins.slice(0, MAX_JOIN_COUNT)) {
    if (join.source.kind === "view") {
      const summary = resolveSummaryJoin(join, source, scope, ctx);
      if (isDiagnostic(summary)) diagnostics.push(summary);
      else {
        summaryJoins.push(summary);
        scope.summaryJoins.set(normalizeRefKey(summary.alias), summary);
      }
      continue;
    }
    const result = resolveRelationJoin(join, source, scope, ctx);
    if (isDiagnostic(result)) {
      diagnostics.push(result);
      continue;
    }
    resolved.push(result);
  }
  return { joins: resolved, summaryJoins, diagnostics };
};

const resolveDerivedRelationJoin = (
  join: DslJoin,
  columns: DslDerivedViewColumn[],
  source: ResolvedSource,
  scope: Scope,
  ctx: DslResolverContext,
):
  | { kind: "derived"; join: DslResolvedDerivedRelationJoin }
  | { kind: "record"; join: DslResolvedRelationJoin }
  | DslResolverDiagnostic => {
  const leftUsesAlias = refUsesAlias(join.on.left, join.alias);
  const rightUsesAlias = refUsesAlias(join.on.right, join.alias);
  if (leftUsesAlias === rightUsesAlias) {
    return diagnostic(`join "${join.alias}" must compare one derived relation column to ${join.alias}.id`, join.span);
  }

  const aliasSide = leftUsesAlias ? join.on.left : join.on.right;
  const fromSide = aliasSide === join.on.left ? join.on.right : join.on.left;

  if (normalizeRefKey(aliasSide.ref) === "id" && !fromSide.scope) {
    const targetSource = resolveJoinSource(join, ctx);
    if (isDiagnostic(targetSource)) return targetSource;
    if (hasJoinAlias(scope, join.alias)) return diagnostic(`duplicate join alias "${join.alias}"`, join.span);
    const column = derivedColumnByRef(columns, fromSide.ref, fromSide.span ?? join.span);
    if (isDiagnostic(column)) return column;
    if (column.kind !== "group" || column.type !== "relation" || !column.targetTableId) {
      return diagnostic(`derived column "${column.label}" is not a relation record id and cannot be joined`, fromSide.span ?? join.span);
    }
    if (column.targetTableId !== targetSource.id) {
      return diagnostic(`join "${join.alias}" target table does not match derived relation column "${column.label}"`, join.span);
    }
    const targetFields = aliveFields(ctx.fieldsByTableId[targetSource.id] ?? []);
    const depth = 1;
    setJoinAlias(scope, join.alias, {
      alias: join.alias,
      tableId: targetSource.id,
      source: targetSource,
      fields: targetFields,
      byRef: buildFieldMap(targetFields),
      computedStub: buildComputedStub(targetFields),
      depth,
    });
    return {
      kind: "derived",
      join: {
        mode: join.mode,
        alias: join.alias,
        source: targetSource,
        tableId: targetSource.id,
        column,
        depth,
      },
    };
  }

  if (fromSide.scope && hasJoinAlias(scope, fromSide.scope)) {
    const relationJoin = resolveRelationJoin(join, source, scope, ctx);
    if (isDiagnostic(relationJoin)) return relationJoin;
    if (relationJoin.fromScope === null) {
      return diagnostic(`join "${join.alias}" cannot use the derived view source as a record`, join.span);
    }
    return { kind: "record", join: relationJoin };
  }

  return diagnostic(
    `join "${join.alias}" must start from a derived relation column or an existing joined record`,
    fromSide.span ?? join.span,
  );
};

export const resolveDerivedJoins = (
  joins: DslJoin[],
  columns: DslDerivedViewColumn[],
  source: ResolvedSource,
  scope: Scope,
  ctx: DslResolverContext,
): {
  joins: DslResolvedDerivedRelationJoin[];
  relationJoins: DslResolvedRelationJoin[];
  diagnostics: DslResolverDiagnostic[];
} => {
  const diagnostics: DslResolverDiagnostic[] = [];
  const derivedJoins: DslResolvedDerivedRelationJoin[] = [];
  const relationJoins: DslResolvedRelationJoin[] = [];
  if (joins.length > MAX_JOIN_COUNT)
    diagnostics.push(diagnostic(`query can join at most ${MAX_JOIN_COUNT} tables`, joins[MAX_JOIN_COUNT]?.span));
  for (const join of joins.slice(0, MAX_JOIN_COUNT)) {
    const result = resolveDerivedRelationJoin(join, columns, source, scope, ctx);
    if (isDiagnostic(result)) {
      diagnostics.push(result);
      continue;
    }
    if (result.kind === "derived") derivedJoins.push(result.join);
    else relationJoins.push(result.join);
  }
  return { joins: derivedJoins, relationJoins, diagnostics };
};
