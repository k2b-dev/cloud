import type { RecordQuery } from "../contracts";
import { filterSearchableFields } from "../searchable-fields";
import type { Field } from "../service/types";
import { type DslDerivedViewColumn, derivedColumnByRef } from "./resolver-derived-columns";
import { type DslResolverDiagnostic, diagnostic, isResolverDiagnostic as isDiagnostic } from "./resolver-diagnostics";
import { fieldByRef, fieldByRefMap, isBaseScope, joinScopeByAlias, type Scope } from "./resolver-scope";
import type { DslQueryAst } from "./types";

export type DslResolvedSqlSearch = {
  q: string;
  tableId: string;
  joinAlias: string;
  fieldIds: string[];
};

const isDerivedSearchableColumn = (column: DslDerivedViewColumn): boolean => column.sqlType !== "json";

const isSearchableField = (field: Field, fields: Field[]): boolean =>
  filterSearchableFields(fields).some((candidate) => candidate.id === field.id);

export const resolveSearch = (
  search: DslQueryAst["search"],
  scope: Scope,
): { searchSpec?: NonNullable<RecordQuery["search"]>; sqlSearch: DslResolvedSqlSearch[]; diagnostics: DslResolverDiagnostic[] } => {
  if (!search) return { sqlSearch: [], diagnostics: [] };

  const ids: string[] = [];
  const sqlSearchByJoin = new Map<string, DslResolvedSqlSearch>();
  const diagnostics: DslResolverDiagnostic[] = [];

  for (const ref of search.fields) {
    if (ref.scope && !isBaseScope(scope, ref.scope)) {
      const join = joinScopeByAlias(scope, ref.scope, ref.span);
      if (isDiagnostic(join)) {
        diagnostics.push(join);
        break;
      }
      const field = fieldByRefMap(join.byRef, ref.ref, `${ref.scope}."${ref.ref}"`, ref.span);
      if (isDiagnostic(field)) {
        diagnostics.push(field);
        break;
      }
      if (!isSearchableField(field, join.fields)) {
        diagnostics.push(diagnostic(`field "${field.name}" is not searchable`, ref.span ?? search.span));
        break;
      }
      const existing =
        sqlSearchByJoin.get(join.alias) ??
        ({
          q: search.q,
          tableId: join.tableId,
          joinAlias: join.alias,
          fieldIds: [],
        } satisfies DslResolvedSqlSearch);
      existing.fieldIds.push(field.id);
      sqlSearchByJoin.set(join.alias, existing);
      continue;
    }
    const field = fieldByRef(scope, ref.ref, ref.span);
    if (isDiagnostic(field)) {
      diagnostics.push(field);
      break;
    }
    if (!isSearchableField(field, scope.fields)) {
      diagnostics.push(diagnostic(`field "${field.name}" is not searchable`, ref.span ?? search.span));
      break;
    }
    ids.push(field.id);
  }

  const searchSpec =
    search.fields.length === 0 || ids.length > 0 ? (ids.length > 0 ? { q: search.q, fieldIds: ids } : { q: search.q }) : undefined;
  return { ...(searchSpec ? { searchSpec } : {}), sqlSearch: [...sqlSearchByJoin.values()], diagnostics };
};

export const resolveDerivedSearch = (
  search: DslQueryAst["search"],
  columns: DslDerivedViewColumn[],
  scope: Scope,
):
  | { search?: { q: string; columns: DslDerivedViewColumn[] }; joinedSearch: DslResolvedSqlSearch[] }
  | DslResolverDiagnostic
  | undefined => {
  if (!search) return undefined;
  if (search.fields.length === 0) return { search: { q: search.q, columns: columns.filter(isDerivedSearchableColumn) }, joinedSearch: [] };

  const resolved: DslDerivedViewColumn[] = [];
  const joined = new Map<string, DslResolvedSqlSearch>();
  const seen = new Set<string>();
  for (const ref of search.fields) {
    if (ref.scope) {
      const join = joinScopeByAlias(scope, ref.scope, ref.span ?? search.span);
      if (isDiagnostic(join)) return join;
      const field = fieldByRefMap(join.byRef, ref.ref, `${ref.scope}."${ref.ref}"`, ref.span ?? search.span);
      if (isDiagnostic(field)) return field;
      if (!filterSearchableFields([field]).some((candidate) => candidate.id === field.id)) {
        return diagnostic(`field "${field.name}" (type "${field.type}") is not searchable`, ref.span ?? search.span);
      }
      const existing = joined.get(join.alias) ?? { q: search.q, tableId: join.tableId, joinAlias: join.alias, fieldIds: [] };
      if (!existing.fieldIds.includes(field.id)) existing.fieldIds.push(field.id);
      joined.set(join.alias, existing);
      continue;
    }
    const column = derivedColumnByRef(columns, ref.ref, ref.span ?? search.span);
    if (isDiagnostic(column)) return column;
    if (!isDerivedSearchableColumn(column))
      return diagnostic(`derived column "${column.label}" is not searchable`, ref.span ?? search.span);
    if (seen.has(column.key)) continue;
    seen.add(column.key);
    resolved.push(column);
  }
  return { ...(resolved.length > 0 ? { search: { q: search.q, columns: resolved } } : {}), joinedSearch: [...joined.values()] };
};
