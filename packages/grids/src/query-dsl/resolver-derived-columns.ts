import { sql } from "bun";
import type { RecordQuery } from "../contracts";
import { normalizeRefKey } from "../ref-syntax";
import {
  aggregateOutputKey,
  aggregateOutputKeyFor,
  aggregateSqlTypeForField,
  aggregateSqlTypeForFormula,
} from "../service/aggregate-capabilities";
import { groupSqlTypeForField, storageOf } from "../service/field-storage";
import type { FormulaSqlExpression, FormulaSqlType } from "../service/formula-sql-compiler";
import { formulaSqlTypeForField } from "../service/formula-sql-compiler";
import type { Field } from "../service/types";
import type { DslFormulaAggregation } from "./resolver-aggregates";
import { type DslResolverDiagnostic, diagnostic } from "./resolver-diagnostics";
import { relationTargetTableId } from "./resolver-scope";
import type { DslSourceSpan } from "./types";

export type DslDerivedViewColumn = {
  kind: "group" | "aggregate";
  key: string;
  publicKey?: string;
  label: string;
  refs: string[];
  sqlType: FormulaSqlType | "json";
  type: string;
  fieldId?: string;
  targetTableId?: string;
  agg?: string;
};

const sqlTypeForGroupField = (field: Field): DslDerivedViewColumn["sqlType"] => {
  return groupSqlTypeForField(field);
};

export const uniqueRefs = (refs: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const ref of refs) {
    const trimmed = ref?.trim();
    if (!trimmed) continue;
    const key = normalizeRefKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
};

export const derivedViewColumns = (
  query: RecordQuery,
  fields: Field[],
  formulaAggregations: readonly DslFormulaAggregation[] = [],
): DslDerivedViewColumn[] | DslResolverDiagnostic => {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const columns: DslDerivedViewColumn[] = [];

  for (const [index, group] of (query.groupBy ?? []).entries()) {
    const field = fieldsById.get(group.fieldId);
    if (!field) return diagnostic(`view source group field ${group.fieldId} is not available`);
    const key = `gk_${index}`;
    const fallback = group.granularity ? `${field.name} (${group.granularity})` : field.name;
    const label = group.label?.trim() || fallback;
    const targetTableId = relationTargetTableId(field);
    columns.push({
      kind: "group",
      key,
      publicKey: key,
      label,
      refs: uniqueRefs([key, label, field.shortId, field.name]),
      fieldId: field.id,
      ...(targetTableId ? { targetTableId } : {}),
      type: field.type,
      sqlType: sqlTypeForGroupField(field),
    });
  }

  for (const aggregation of query.aggregations ?? []) {
    const field = aggregation.fieldId === "*" ? null : fieldsById.get(aggregation.fieldId);
    if (aggregation.fieldId !== "*" && !field) return diagnostic(`view source aggregate field ${aggregation.fieldId} is not available`);
    const key = aggregateOutputKey(aggregation.fieldId, aggregation.agg);
    const publicKey = aggregateOutputKey(aggregation.fieldId === "*" ? "*" : field!.shortId, aggregation.agg);
    const fallback = aggregation.fieldId === "*" ? "# records" : `${aggregation.agg} ${field?.name ?? "value"}`;
    const label = aggregation.label?.trim() || fallback;
    columns.push({
      kind: "aggregate",
      key,
      publicKey,
      label,
      refs: uniqueRefs([
        publicKey,
        label,
        aggregation.label,
        aggregation.fieldId === "*" ? "count" : `${aggregation.agg} ${field?.name ?? ""}`,
        aggregation.fieldId === "*" ? "rows" : undefined,
      ]),
      fieldId: aggregation.fieldId,
      agg: aggregation.agg,
      type: "aggregate",
      sqlType: aggregateSqlTypeForField(field ?? null, aggregation.agg, aggregation.fieldId === "*"),
    });
  }

  for (const aggregation of formulaAggregations) {
    const key = aggregateOutputKeyFor(aggregation);
    columns.push({
      kind: "aggregate",
      key,
      publicKey: key,
      label: aggregation.id,
      refs: [key, aggregation.id],
      sqlType: aggregateSqlTypeForFormula(aggregation.sqlType, aggregation.agg),
      type: "aggregate",
      agg: aggregation.agg,
    });
  }
  return columns;
};

export const derivedColumnByRef = (
  columns: DslDerivedViewColumn[],
  ref: string,
  span?: DslSourceSpan,
): DslDerivedViewColumn | DslResolverDiagnostic => {
  const key = normalizeRefKey(ref);
  const matches = columns.filter((column) => column.refs.some((candidate) => normalizeRefKey(candidate) === key));
  if (matches.length === 0) return diagnostic(`unknown derived column "${ref}"`, span);
  if (matches.length > 1) return diagnostic(`ambiguous derived column "${ref}"`, span);
  return matches[0]!;
};

export const derivedColumnSqlType = (column: DslDerivedViewColumn): FormulaSqlType =>
  column.sqlType === "json" ? "unknown" : column.sqlType;

export const formulaSqlTypeForDerivedField = (field: Field): FormulaSqlType | "json" => {
  const kind = storageOf(field).kind;
  if (kind === "relationLink" || kind === "jsonbArray") return "text";
  return formulaSqlTypeForField(field);
};

export const createDerivedFormulaFieldResolver =
  (columns: DslDerivedViewColumn[], recordAlias: string): ((ref: string) => FormulaSqlExpression | string | null) =>
  (ref) => {
    const column = derivedColumnByRef(columns, ref);
    if ("message" in column) return column.message;
    return { sql: sql`${sql.unsafe(`${recordAlias}."${column.key}"`)}`, type: derivedColumnSqlType(column) };
  };
