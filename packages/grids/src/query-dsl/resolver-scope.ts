import { sql } from "bun";
import { normalizeRefKey } from "../ref-syntax";
import { storageOf } from "../service/field-storage";
import type { FormulaSqlExpression } from "../service/formula-sql-compiler";
import type { Field } from "../service/types";
import type { DslResolverContext, DslTableSource } from "./resolver-context";
import { type DslResolverDiagnostic, diagnostic, isResolverDiagnostic as isDiagnostic } from "./resolver-diagnostics";
import type { DslSummaryJoin } from "./resolver-summary-joins";
import type { DslQualifiedRef, DslSourceSpan } from "./types";

export type Scope = {
  documentMetadata: boolean;
  tableId: string;
  sourceAlias?: string;
  fields: Field[];
  byRef: Map<string, Field[]>;
  readableTableIds: Set<string>;
  joins: Map<string, JoinScope>;
  summaryJoins: Map<string, DslSummaryJoin>;
  fieldAliases: Map<string, string>;
  joinedAliases: Set<string>;
  computedAliases: Set<string>;
  /** Type-only stand-in for lookup/rollup fields so resolve-time formula
   *  validation accepts them; real SQL is injected at compile time. */
  computedStub: Map<string, FormulaSqlExpression>;
};

export type JoinScope = {
  alias: string;
  tableId: string;
  source: DslTableSource;
  fields: Field[];
  byRef: Map<string, Field[]>;
  computedStub: Map<string, FormulaSqlExpression>;
  depth: number;
};

export const aliveFields = (fields: Field[]): Field[] => fields.filter((field) => !field.deletedAt).sort((a, b) => a.position - b.position);

const addFieldRef = (map: Map<string, Field[]>, ref: string | null | undefined, field: Field): void => {
  if (!ref) return;
  const key = normalizeRefKey(ref);
  const existing = map.get(key) ?? [];
  if (!existing.some((item) => item.id === field.id)) existing.push(field);
  map.set(key, existing);
};

export const buildFieldMap = (fields: Field[]): Map<string, Field[]> => {
  const map = new Map<string, Field[]>();
  for (const field of fields) {
    addFieldRef(map, field.shortId, field);
    addFieldRef(map, field.name, field);
  }
  return map;
};

export const buildComputedStub = (fields: Field[]): Map<string, FormulaSqlExpression> =>
  new Map(
    fields
      .filter((field) => !field.deletedAt && (field.type === "lookup" || field.type === "rollup"))
      .map((field) => [field.id, { sql: sql`NULL`, type: "unknown" as const }]),
  );

export const createScope = (fields: Field[], ctx: DslResolverContext, tableId: string, sourceAlias?: string): Scope => ({
  documentMetadata: ctx.documentMetadata === true,
  tableId,
  ...(sourceAlias ? { sourceAlias } : {}),
  fields,
  byRef: buildFieldMap(fields),
  readableTableIds: new Set(ctx.tables.map((table) => table.id)),
  joins: new Map(),
  summaryJoins: new Map(),
  fieldAliases: new Map(),
  joinedAliases: new Set(),
  computedAliases: new Set(),
  computedStub: buildComputedStub(fields),
});

export const relationTargetTableId = (field: Field): string | null => {
  if (field.type !== "relation") return null;
  return (field.config as { targetTableId?: string }).targetTableId ?? null;
};

const outputTargetTableId = (field: Field, fields: Field[]): string | null => {
  if (field.type === "relation") return relationTargetTableId(field);
  if (field.type !== "lookup" && field.type !== "rollup") return null;
  const relationFieldId = (field.config as { relationFieldId?: string }).relationFieldId;
  const relationField = relationFieldId ? fields.find((candidate) => candidate.id === relationFieldId && !candidate.deletedAt) : null;
  return relationField ? relationTargetTableId(relationField) : null;
};

export const relationOutputDiagnostic = (field: Field, scope: Scope, fields: Field[] = scope.fields): DslResolverDiagnostic | null => {
  const targetTableId = outputTargetTableId(field, fields);
  if (!targetTableId || scope.readableTableIds.has(targetTableId)) return null;
  return diagnostic(`${field.type} field "${field.name}" target table is not available`);
};

export const isDefaultSelectableField = (field: Field, scope: Scope): boolean => {
  const kind = storageOf(field).kind;
  if (kind === "unknown") return false;
  // Computed kinds: formula / lookup / rollup project to SQL; file does not.
  if (kind === "computed" && field.type !== "formula" && field.type !== "lookup" && field.type !== "rollup") return false;
  return relationOutputDiagnostic(field, scope) === null;
};

export const fieldByRef = (scope: Scope, ref: string, span?: DslSourceSpan): Field | DslResolverDiagnostic => {
  const fields = (scope.byRef.get(normalizeRefKey(ref)) ?? []).filter((field) => !field.deletedAt);
  if (fields.length === 0) return diagnostic(`unknown field "${ref}"`, span);
  if (fields.length > 1) return diagnostic(`ambiguous field "${ref}"`, span);
  return fields[0]!;
};

export const fieldByRefMap = (
  byRef: Map<string, Field[]>,
  ref: string,
  label: string,
  span?: DslSourceSpan,
): Field | DslResolverDiagnostic => {
  const fields = (byRef.get(normalizeRefKey(ref)) ?? []).filter((field) => !field.deletedAt);
  if (fields.length === 0) return diagnostic(`unknown field ${label}`, span);
  if (fields.length > 1) return diagnostic(`ambiguous field ${label}`, span);
  return fields[0]!;
};

const aliasKey = (alias: string): string => normalizeRefKey(alias);

export const hasJoinAlias = (scope: Scope, alias: string): boolean =>
  scope.joins.has(aliasKey(alias)) || scope.summaryJoins.has(aliasKey(alias));

export const setJoinAlias = (scope: Scope, alias: string, join: JoinScope): void => {
  scope.joins.set(aliasKey(alias), join);
};

export const fieldAliasId = (scope: Scope, alias: string): string | null => {
  const key = normalizeRefKey(alias);
  for (const [candidate, fieldId] of scope.fieldAliases) {
    if (normalizeRefKey(candidate) === key) return fieldId;
  }
  return null;
};

export const setHasAlias = (aliases: Set<string>, alias: string): boolean => {
  const key = normalizeRefKey(alias);
  for (const candidate of aliases) {
    if (normalizeRefKey(candidate) === key) return true;
  }
  return false;
};

export const isBaseScope = (scope: Scope, alias: string | undefined): boolean =>
  Boolean(alias && scope.sourceAlias && normalizeRefKey(alias) === normalizeRefKey(scope.sourceAlias));

export const hasAnyOutputAlias = (scope: Scope, alias: string): boolean =>
  hasJoinAlias(scope, alias) ||
  fieldAliasId(scope, alias) !== null ||
  setHasAlias(scope.joinedAliases, alias) ||
  setHasAlias(scope.computedAliases, alias) ||
  isBaseScope(scope, alias);

export const hasFieldRef = (fields: Field[], alias: string): boolean => {
  const key = normalizeRefKey(alias);
  return fields.some((field) => !field.deletedAt && (normalizeRefKey(field.shortId) === key || normalizeRefKey(field.name) === key));
};

export const refUsesAlias = (ref: DslQualifiedRef, alias: string): boolean => normalizeRefKey(ref.scope ?? "") === normalizeRefKey(alias);

export const joinScopeByAlias = (scope: Scope, alias: string, span?: DslSourceSpan): JoinScope | DslResolverDiagnostic => {
  const join = scope.joins.get(aliasKey(alias));
  if (!join) return diagnostic(`unknown join alias "${alias}"`, span);
  return join;
};

export const resolveScopedField = (
  scope: Scope,
  ref: DslQualifiedRef,
): { field: Field; tableId: string; joinAlias?: string } | DslResolverDiagnostic => {
  if (isBaseScope(scope, ref.scope)) {
    const field = fieldByRef(scope, ref.ref, ref.span);
    if (isDiagnostic(field)) return field;
    return { field, tableId: scope.tableId };
  }
  if (ref.scope) {
    const join = joinScopeByAlias(scope, ref.scope, ref.span);
    if (isDiagnostic(join)) return join;
    const field = fieldByRefMap(join.byRef, ref.ref, `${ref.scope}."${ref.ref}"`, ref.span);
    if (isDiagnostic(field)) return field;
    return { field, tableId: join.tableId, joinAlias: join.alias };
  }
  const field = fieldByRef(scope, ref.ref, ref.span);
  if (isDiagnostic(field)) return field;
  return { field, tableId: scope.tableId };
};
