import { sql } from "@k2b/cloud";
import type { AggregationSpec, RecordQuery } from "../contracts";
import type { Expr } from "../formula/types";
import { formatIdentifierRef, normalizeRefKey } from "../ref-syntax";
import {
  aggregateOutputKey,
  aggregateSqlTypeForField,
  aggregateSqlTypeForFormula,
  isAggregateKind,
  isFieldAggregatable,
  isFormulaAggregatable,
} from "../service/aggregate-capabilities";
import { compileFormulaAstToSql, type FormulaSqlType } from "../service/formula-sql-compiler";
import type { GroupAggregationSpec, GroupHavingRef } from "../service/group-compiler";
import type { Field } from "../service/types";
import { type DslResolverDiagnostic, diagnostic, isResolverDiagnostic as isDiagnostic } from "./resolver-diagnostics";
import { scopedFormulaResolverForScope } from "./resolver-formula-scope";
import { hasAnyOutputAlias, hasFieldRef, relationOutputDiagnostic, resolveScopedField, type Scope } from "./resolver-scope";
import type { DslAggregateItem, DslQualifiedRef, DslQueryAst, DslSourceSpan } from "./types";

type DslFormulaPredicate = {
  kind: "formula";
  source: string;
  expression: Expr;
  sqlType: FormulaSqlType;
};

export type DslFormulaHavingPredicate = DslFormulaPredicate & {
  aggregateRefs: GroupHavingRef[];
};

export type DslFormulaAggregation = Extract<GroupAggregationSpec, { kind: "formula" }> & {
  ref: string;
  source: string;
  sqlType: FormulaSqlType;
};

export type DslResolvedSqlAggregation = {
  fieldId: string | "*";
  tableId?: string;
  joinAlias?: string;
  agg: DslAggregateItem["fn"];
  label?: string;
};

type HavingRef = { ref: GroupHavingRef; sqlType: FormulaSqlType };

export const FORMULA_AGGREGATE_ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]{0,49}$/;

export const hasLabelRef = (labels: string[], ref: string): boolean => {
  const key = normalizeRefKey(ref);
  return labels.some((label) => normalizeRefKey(label) === key);
};

const aggregateAliasConflictDiagnostic = (
  scope: Scope,
  alias: string,
  groupLabels: string[],
  span?: DslSourceSpan,
): DslResolverDiagnostic | null => {
  if (hasLabelRef(groupLabels, alias)) return diagnostic(`aggregate alias "${alias}" conflicts with a group field`, span);
  if (hasAnyOutputAlias(scope, alias)) return diagnostic(`aggregate alias "${alias}" conflicts with an existing output alias`, span);
  if (hasFieldRef(scope.fields, alias)) return diagnostic(`aggregate alias "${alias}" conflicts with a source field`, span);
  return null;
};

const formulaTypeForAggregate = (item: DslAggregateItem, field: Field | null): FormulaSqlType => {
  return aggregateSqlTypeForField(field, item.fn, item.argument === "*");
};

const viewAggForDsl = (fn: DslAggregateItem["fn"]): AggregationSpec["agg"] => fn;

export const groupAggForDsl = (fn: DslAggregateItem["fn"]): GroupHavingRef["agg"] | DslResolverDiagnostic => {
  if (!isAggregateKind(fn)) {
    return diagnostic(`aggregate "${fn}" is not supported by grouped SQL queries yet`);
  }
  return fn as GroupHavingRef["agg"];
};

export const duplicateAggregateOutputDiagnostic = (label: string, agg: string): DslResolverDiagnostic =>
  diagnostic(`duplicate aggregate output for "${label}" with "${agg}"`);

export const compileHavingPredicate = (
  having: NonNullable<DslQueryAst["having"]>,
  refs: Map<string, HavingRef>,
): DslFormulaHavingPredicate | DslResolverDiagnostic => {
  const compiled = compileFormulaAstToSql(having.expression, {
    fields: [],
    resolveField: (ref) => {
      const aggregate = refs.get(normalizeRefKey(ref));
      if (!aggregate) return null;
      const cast =
        aggregate.sqlType === "numeric"
          ? sql`NULL::numeric`
          : aggregate.sqlType === "boolean"
            ? sql`NULL::boolean`
            : aggregate.sqlType === "date"
              ? sql`NULL::date`
              : aggregate.sqlType === "datetime"
                ? sql`NULL::timestamptz`
                : sql`NULL::text`;
      return { sql: cast, type: aggregate.sqlType };
    },
  });
  if (!compiled.ok) return diagnostic(`having formula: ${compiled.error}`, having.span);
  if (compiled.expression.type !== "boolean") return diagnostic("having formula must return a boolean value", having.span);

  return {
    kind: "formula",
    source: having.source,
    expression: having.expression,
    sqlType: compiled.expression.type,
    aggregateRefs: [...refs.values()].map((item) => item.ref),
  };
};

export const isComputedValueAggregateField = (field: Field): boolean =>
  field.type === "formula" || field.type === "lookup" || field.type === "rollup";

const qualifiedRefSource = (ref: DslQualifiedRef): string =>
  ref.scope ? `${formatIdentifierRef(ref.scope)}.${formatIdentifierRef(ref.ref)}` : formatIdentifierRef(ref.ref);

const qualifiedRefExpression = (ref: DslQualifiedRef): Expr => ({
  kind: "field",
  fieldId: ref.scope ? qualifiedRefSource(ref) : ref.ref,
});

export const resolveComputedValueAggregation = (
  item: DslAggregateItem,
  argument: DslQualifiedRef,
  groupAgg: GroupHavingRef["agg"],
  scope: Scope,
): DslFormulaAggregation | DslResolverDiagnostic => {
  const expression = qualifiedRefExpression(argument);
  const compiled = compileFormulaAstToSql(expression, {
    fields: scope.fields,
    computedFieldSql: scope.computedStub,
    resolveField: scopedFormulaResolverForScope(scope),
  });
  if (!compiled.ok) return diagnostic(`aggregate "${item.alias}" formula: ${compiled.error}`, item.span);
  if (compiled.expression.type !== "unknown" && !isFormulaAggregatable(compiled.expression.type, groupAgg)) {
    return diagnostic(`agg "${item.fn}" not compatible with formula type "${compiled.expression.type}"`, item.span);
  }
  if (!FORMULA_AGGREGATE_ALIAS_RE.test(item.alias)) {
    return diagnostic(`formula aggregate alias "${item.alias}" must be 50 characters or less`, item.span);
  }
  return {
    kind: "formula",
    id: item.alias,
    ref: item.alias,
    source: qualifiedRefSource(argument),
    expression,
    agg: groupAgg,
    sqlType: compiled.expression.type,
  };
};

export const resolveSqlAggregations = (
  items: DslAggregateItem[],
  scope: Scope,
  options: { grouped: boolean; joinedQuery: boolean; groupLabels?: string[] },
): {
  aggregations: NonNullable<RecordQuery["aggregations"]>;
  sqlAggregations: DslResolvedSqlAggregation[];
  formulaAggregations: DslFormulaAggregation[];
  diagnostics: DslResolverDiagnostic[];
} => {
  const aggregations: NonNullable<RecordQuery["aggregations"]> = [];
  const sqlAggregations: DslResolvedSqlAggregation[] = [];
  const formulaAggregations: DslFormulaAggregation[] = [];
  const diagnostics: DslResolverDiagnostic[] = [];
  const aliases = new Set<string>();
  const outputKeys = new Set<string>();

  for (const item of items) {
    const aliasKey = normalizeRefKey(item.alias);
    if (aliases.has(aliasKey)) {
      diagnostics.push(diagnostic(`duplicate aggregate alias "${item.alias}"`, item.span));
      continue;
    }
    const aliasConflict = aggregateAliasConflictDiagnostic(scope, item.alias, options.groupLabels ?? [], item.span);
    if (aliasConflict) {
      diagnostics.push(aliasConflict);
      continue;
    }
    aliases.add(aliasKey);

    const groupAgg = groupAggForDsl(item.fn);

    if (typeof item.argument === "object" && "kind" in item.argument) {
      if (isDiagnostic(groupAgg)) {
        diagnostics.push(groupAgg);
        continue;
      }
      const compiled = compileFormulaAstToSql(item.argument.expression, {
        fields: scope.fields,
        computedFieldSql: scope.computedStub,
        resolveField: scopedFormulaResolverForScope(scope),
      });
      if (!compiled.ok) {
        diagnostics.push(diagnostic(`aggregate "${item.alias}" formula: ${compiled.error}`, item.span));
        continue;
      }
      if (!isFormulaAggregatable(compiled.expression.type, groupAgg)) {
        diagnostics.push(diagnostic(`agg "${item.fn}" not compatible with formula type "${compiled.expression.type}"`, item.span));
        continue;
      }
      if (!FORMULA_AGGREGATE_ALIAS_RE.test(item.alias)) {
        diagnostics.push(diagnostic(`formula aggregate alias "${item.alias}" must be 50 characters or less`, item.span));
        continue;
      }
      formulaAggregations.push({
        kind: "formula",
        id: item.alias,
        ref: item.alias,
        source: item.argument.source,
        expression: item.argument.expression,
        agg: groupAgg,
        sqlType: compiled.expression.type,
      });
      continue;
    }

    if (item.argument === "*") {
      if (item.fn !== "count") {
        diagnostics.push(diagnostic(`aggregate "${item.fn}" cannot use *`, item.span));
        continue;
      }
      const outputKey = aggregateOutputKey("*", "count");
      if (outputKeys.has(outputKey)) {
        diagnostics.push(duplicateAggregateOutputDiagnostic("*", "count"));
        continue;
      }
      outputKeys.add(outputKey);
      aggregations.push({ fieldId: "*", agg: "count", label: item.alias });
      sqlAggregations.push({ fieldId: "*", agg: "count", label: item.alias });
      continue;
    }

    const resolved = resolveScopedField(scope, item.argument);
    if (isDiagnostic(resolved)) {
      diagnostics.push(resolved);
      continue;
    }
    const { field } = resolved;
    const relationDiagnostic = !resolved.joinAlias ? relationOutputDiagnostic(field, scope) : null;
    if (relationDiagnostic) {
      diagnostics.push(relationDiagnostic);
      continue;
    }
    if (isComputedValueAggregateField(field)) {
      if (isDiagnostic(groupAgg)) {
        diagnostics.push(groupAgg);
        continue;
      }
      const formulaAggregation = resolveComputedValueAggregation(item, item.argument, groupAgg, scope);
      if (isDiagnostic(formulaAggregation)) {
        diagnostics.push(formulaAggregation);
        continue;
      }
      formulaAggregations.push(formulaAggregation);
      continue;
    }
    if (options.grouped) {
      if (isDiagnostic(groupAgg)) {
        diagnostics.push(groupAgg);
        continue;
      }
      if (!isFieldAggregatable(field, groupAgg)) {
        diagnostics.push(diagnostic(`agg "${item.fn}" not compatible with field type "${field.type}"`, item.span));
        continue;
      }
      const outputKey = aggregateOutputKey(field.id, groupAgg);
      if (outputKeys.has(outputKey)) {
        diagnostics.push(duplicateAggregateOutputDiagnostic(field.name, item.fn));
        continue;
      }
      outputKeys.add(outputKey);
      if (!resolved.joinAlias) aggregations.push({ fieldId: field.id, agg: groupAgg, label: item.alias });
      sqlAggregations.push({
        fieldId: field.id,
        tableId: resolved.tableId,
        ...(resolved.joinAlias ? { joinAlias: resolved.joinAlias } : {}),
        agg: groupAgg,
        label: item.alias,
      });
    } else {
      const viewAgg = viewAggForDsl(item.fn);
      if (!isFieldAggregatable(field, viewAgg)) {
        diagnostics.push(diagnostic(`agg "${item.fn}" not compatible with field type "${field.type}"`, item.span));
        continue;
      }
      const outputKey = aggregateOutputKey(field.id, viewAgg);
      if (outputKeys.has(outputKey)) {
        diagnostics.push(duplicateAggregateOutputDiagnostic(field.name, item.fn));
        continue;
      }
      outputKeys.add(outputKey);
      if (!resolved.joinAlias) aggregations.push({ fieldId: field.id, agg: viewAgg, label: item.alias });
      sqlAggregations.push({
        fieldId: field.id,
        tableId: resolved.tableId,
        ...(resolved.joinAlias ? { joinAlias: resolved.joinAlias } : {}),
        agg: viewAgg,
        label: item.alias,
      });
    }
  }

  return { aggregations, sqlAggregations, formulaAggregations, diagnostics };
};

export const resolveHavingPredicate = (
  having: NonNullable<DslQueryAst["having"]>,
  aggregations: DslAggregateItem[],
  scope: Scope,
): DslFormulaHavingPredicate | DslResolverDiagnostic => {
  const refs = new Map<string, HavingRef>();
  for (const item of aggregations) {
    const groupAgg = groupAggForDsl(item.fn);
    if (isDiagnostic(groupAgg)) return groupAgg;

    if (typeof item.argument === "object" && "kind" in item.argument) {
      const compiled = compileFormulaAstToSql(item.argument.expression, {
        fields: scope.fields,
        computedFieldSql: scope.computedStub,
        resolveField: scopedFormulaResolverForScope(scope),
      });
      if (!compiled.ok) return diagnostic(`aggregate "${item.alias}" formula: ${compiled.error}`, item.span);
      if (!isFormulaAggregatable(compiled.expression.type, groupAgg)) {
        return diagnostic(`agg "${item.fn}" not compatible with formula type "${compiled.expression.type}"`, item.span);
      }
      refs.set(normalizeRefKey(item.alias), {
        ref: {
          kind: "formula",
          id: item.alias,
          ref: item.alias,
          expression: item.argument.expression,
          agg: groupAgg,
        },
        sqlType: aggregateSqlTypeForFormula(compiled.expression.type, groupAgg),
      });
      continue;
    }

    if (item.argument === "*") {
      if (item.fn !== "count") return diagnostic(`aggregate "${item.fn}" cannot use *`, item.span);
      refs.set(normalizeRefKey(item.alias), { ref: { ref: item.alias, fieldId: "*", agg: groupAgg }, sqlType: "numeric" });
      continue;
    }
    const resolved = resolveScopedField(scope, item.argument);
    if (isDiagnostic(resolved)) return resolved;
    const { field } = resolved;
    const relationDiagnostic = !resolved.joinAlias ? relationOutputDiagnostic(field, scope) : null;
    if (relationDiagnostic) return relationDiagnostic;
    if (isComputedValueAggregateField(field)) {
      const computedAggregation = resolveComputedValueAggregation(item, item.argument, groupAgg, scope);
      if (isDiagnostic(computedAggregation)) return computedAggregation;
      refs.set(normalizeRefKey(item.alias), {
        ref: computedAggregation,
        sqlType: aggregateSqlTypeForFormula(computedAggregation.sqlType, groupAgg),
      });
      continue;
    }
    refs.set(normalizeRefKey(item.alias), {
      ref: { ref: item.alias, fieldId: field.id, agg: groupAgg },
      sqlType: formulaTypeForAggregate(item, field),
    });
    continue;
  }

  return compileHavingPredicate(having, refs);
};
