import type { DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import { normalizeRefKey, parseQualifiedIdentifierRef } from "../ref-syntax";
import { storageOf } from "../service/field-storage";
import {
  compileFormulaFieldToSql,
  type FormulaSqlExpression,
  type FormulaSqlFieldResolver,
  formulaSqlTypeForField,
} from "../service/formula-sql-compiler";
import { compileObjectListProjection } from "../service/object-list-projection";
import type { Field } from "../service/types";
import { createDerivedFormulaFieldResolver, type DslDerivedViewColumn } from "./resolver-derived-columns";

type DslFormulaRecordScope = {
  alias?: string;
  fields: Field[];
  recordAlias: string;
  computedFieldSql?: Map<string, FormulaSqlExpression>;
};

type DslScopedFormulaOptions = {
  base: DslFormulaRecordScope;
  joins?: DslFormulaRecordScope[];
  summaries?: Array<{ alias: string; recordAlias: string; columns: DslDerivedViewColumn[] }>;
  dateConfig?: DateContext;
};

const fieldByRef = (fields: Field[], ref: string, label: string): Field | string => {
  const key = normalizeRefKey(ref);
  const matches = fields.filter(
    (field) => !field.deletedAt && (normalizeRefKey(field.shortId) === key || normalizeRefKey(field.name) === key),
  );
  if (matches.length === 0) return `Unknown formula field reference "${label}"`;
  if (matches.length > 1) return `Ambiguous formula field reference "${label}"`;
  return matches[0]!;
};

const scopeMatches = (candidate: string | undefined, ref: string): boolean =>
  Boolean(candidate && normalizeRefKey(candidate) === normalizeRefKey(ref));

const resolveScope = (options: DslScopedFormulaOptions, alias: string): DslFormulaRecordScope | string => {
  if (scopeMatches(options.base.alias, alias)) return options.base;
  const join = (options.joins ?? []).find((item) => scopeMatches(item.alias, alias));
  if (join) return join;
  return `Unknown formula scope "${alias}"`;
};

const compileScopedField = (
  field: Field,
  scope: DslFormulaRecordScope,
  options: DslScopedFormulaOptions,
  label: string,
): Exclude<ReturnType<FormulaSqlFieldResolver>, null> => {
  if (field.type === "select") return { sql: sql`${sql.unsafe(scope.recordAlias)}.data->${field.id}`, type: "unknown", select: field };
  if (field.type === "object_list") {
    const prepared = scope.computedFieldSql?.get(field.id);
    if (prepared) return { ...prepared, objectListConfig: field.config };
    const compiled = compileObjectListProjection(field, scope.recordAlias, { dateConfig: options.dateConfig });
    return compiled.ok ? { ...compiled.expression, objectListConfig: field.config } : compiled.error;
  }
  if (field.type === "formula") {
    const expression = (field.config as { expression?: unknown }).expression;
    if (typeof expression !== "string" || expression.trim().length === 0) return `Formula field "${field.name}" has no expression`;
    const prepared = scope.computedFieldSql?.get(field.id);
    if (prepared) return prepared;
    const compiled = compileFormulaFieldToSql(field, {
      fields: scope.fields,
      recordAlias: scope.recordAlias,
      dateConfig: options.dateConfig,
      computedFieldSql: scope.computedFieldSql,
    });
    return compiled.ok ? compiled.expression : `Formula field "${field.name}": ${compiled.error}`;
  }
  if (field.type === "lookup" || field.type === "rollup") {
    const computed = scope.computedFieldSql?.get(field.id);
    if (computed) return computed;
    return `Field "${label}" (${field.type}) is not available as a scoped formula value`;
  }
  const projection = storageOf(field).project(field, scope.recordAlias);
  if (projection === null) return `Field "${label}" (${field.type}) cannot be used as a scalar formula value`;
  return { sql: projection, type: formulaSqlTypeForField(field) };
};

export const isScopedFormulaFieldRef = (ref: string): boolean => Boolean(parseQualifiedIdentifierRef(ref)?.scope);

export const createDslScopedFormulaFieldResolver = (options: DslScopedFormulaOptions): FormulaSqlFieldResolver => {
  return (ref) => {
    const qualified = parseQualifiedIdentifierRef(ref);
    if (!qualified?.scope) return null;
    const summary = options.summaries?.find((item) => scopeMatches(item.alias, qualified.scope!));
    if (summary) return createDerivedFormulaFieldResolver(summary.columns, summary.recordAlias)(qualified.ref);
    const scope = resolveScope(options, qualified.scope);
    if (typeof scope === "string") return scope;
    const label = `${qualified.scope}.${qualified.ref}`;
    const field = fieldByRef(scope.fields, qualified.ref, label);
    if (typeof field === "string") return field;
    return compileScopedField(field, scope, options, label);
  };
};
