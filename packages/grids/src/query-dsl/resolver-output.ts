import type { RecordQuery } from "../contracts";
import { normalizeRefKey } from "../ref-syntax";
import { compileFormulaAstToSql } from "../service/formula-sql-compiler";
import { derivedColumnByRef } from "./resolver-derived-columns";
import { type DslResolverDiagnostic, diagnostic, isResolverDiagnostic as isDiagnostic } from "./resolver-diagnostics";
import { scopedFormulaResolverForScope } from "./resolver-formula-scope";
import {
  fieldByRef,
  fieldByRefMap,
  hasAnyOutputAlias,
  hasFieldRef,
  isBaseScope,
  joinScopeByAlias,
  relationOutputDiagnostic,
  type Scope,
} from "./resolver-scope";
import { gqlQuotedRef } from "./source-format";
import type { DslSelectItem, DslSourceSpan } from "./types";

export type DslJoinedColumn = {
  joinAlias: string;
  tableId: string;
  fieldId: string;
  label?: string;
};

export type DslOutputColumn =
  | {
      kind: "field";
      fieldId: string;
      label?: string;
    }
  | {
      kind: "computed";
      id: string;
      label: string;
      expression: string;
    }
  | ({ kind: "joined" } & DslJoinedColumn);

const computedIdForAlias = (alias: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < alias.length; i++) {
    hash ^= alias.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `computed_${(hash >>> 0).toString(36).padStart(7, "0")}`;
};

const aliasConflictDiagnostic = (scope: Scope, alias: string, span?: DslSourceSpan): DslResolverDiagnostic | null => {
  if (hasAnyOutputAlias(scope, alias)) return diagnostic(`duplicate select alias "${alias}"`, span);
  if (hasFieldRef(scope.fields, alias)) return diagnostic(`select alias "${alias}" conflicts with a source field`, span);
  return null;
};

const resolveJoinedFieldItem = (item: Extract<DslSelectItem, { kind: "field" }>, scope: Scope): DslJoinedColumn | DslResolverDiagnostic => {
  if (!item.field.scope) return diagnostic("joined field resolver needs a scoped field", item.field.span);
  const join = joinScopeByAlias(scope, item.field.scope, item.field.span);
  if (isDiagnostic(join)) return join;
  const field = fieldByRefMap(join.byRef, item.field.ref, `${item.field.scope}."${item.field.ref}"`, item.field.span);
  if (isDiagnostic(field)) return field;
  const relationDiagnostic = relationOutputDiagnostic(field, scope, join.fields);
  if (relationDiagnostic) return relationDiagnostic;
  return {
    joinAlias: join.alias,
    tableId: join.tableId,
    fieldId: field.id,
    ...(item.alias ? { label: item.alias } : {}),
  };
};

export const resolveQueryPlanSelect = (
  select: DslSelectItem[],
  scope: Scope,
): { columns?: RecordQuery["columns"]; joinedColumns: DslJoinedColumn[]; outputColumns: DslOutputColumn[] } | DslResolverDiagnostic => {
  if (select.length === 0) return { joinedColumns: [], outputColumns: [] };
  const columns: NonNullable<RecordQuery["columns"]> = [];
  const joinedColumns: DslJoinedColumn[] = [];
  const outputColumns: DslOutputColumn[] = [];
  const computedIds = new Set<string>();

  for (const item of select) {
    const alias = item.kind === "field" ? item.alias : item.alias;
    if (alias) {
      const aliasConflict = aliasConflictDiagnostic(scope, alias, item.span);
      if (aliasConflict) return aliasConflict;
    }

    if (item.kind === "field" && item.field.scope) {
      const summary = scope.summaryJoins.get(normalizeRefKey(item.field.scope));
      if (summary) {
        const column = derivedColumnByRef(summary.columns, item.field.ref, item.field.span);
        if (isDiagnostic(column)) return column;
        const label = item.alias ?? `${summary.alias}.${column.label}`;
        const id = computedIdForAlias(label);
        if (computedIds.has(id)) return diagnostic(`duplicate select output "${label}"`, item.span);
        computedIds.add(id);
        scope.computedAliases.add(label);
        const computed = {
          kind: "computed" as const,
          id,
          label,
          expression: `${summary.alias}.${gqlQuotedRef(column.publicKey ?? column.key)}`,
        };
        columns.push(computed);
        outputColumns.push(computed);
        continue;
      }
    }

    if (item.kind === "field") {
      if (isBaseScope(scope, item.field.scope)) {
        const field = fieldByRef(scope, item.field.ref, item.field.span);
        if (isDiagnostic(field)) return field;
        const relationDiagnostic = relationOutputDiagnostic(field, scope);
        if (relationDiagnostic) return relationDiagnostic;
        if (item.alias) scope.fieldAliases.set(item.alias, field.id);
        columns.push({ fieldId: field.id, ...(item.alias ? { label: item.alias } : {}) });
        outputColumns.push({ kind: "field", fieldId: field.id, ...(item.alias ? { label: item.alias } : {}) });
        continue;
      }
      if (item.field.scope) {
        const joined = resolveJoinedFieldItem(item, scope);
        if (isDiagnostic(joined)) return joined;
        if (item.alias) scope.joinedAliases.add(item.alias);
        joinedColumns.push(joined);
        outputColumns.push({ kind: "joined", ...joined });
        continue;
      }
      const field = fieldByRef(scope, item.field.ref, item.field.span);
      if (isDiagnostic(field)) return field;
      const relationDiagnostic = relationOutputDiagnostic(field, scope);
      if (relationDiagnostic) return relationDiagnostic;
      if (item.alias) scope.fieldAliases.set(item.alias, field.id);
      columns.push({ fieldId: field.id, ...(item.alias ? { label: item.alias } : {}) });
      outputColumns.push({ kind: "field", fieldId: field.id, ...(item.alias ? { label: item.alias } : {}) });
      continue;
    }

    const compiled = compileFormulaAstToSql(item.expression, {
      documentMetadata: scope.documentMetadata,
      fields: scope.fields,
      computedFieldSql: scope.computedStub,
      resolveField: scopedFormulaResolverForScope(scope),
    });
    if (!compiled.ok) return diagnostic(`select "${item.alias}": ${compiled.error}`, item.span);
    scope.computedAliases.add(item.alias);
    const computedId = computedIdForAlias(item.alias);
    if (computedIds.has(computedId)) return diagnostic(`computed select id collision for alias "${item.alias}"`, item.span);
    computedIds.add(computedId);
    columns.push({
      kind: "computed",
      id: computedId,
      label: item.alias,
      expression: item.source,
    });
    outputColumns.push({
      kind: "computed",
      id: computedId,
      label: item.alias,
      expression: item.source,
    });
  }

  return { columns: columns.length > 0 ? columns : undefined, joinedColumns, outputColumns };
};
