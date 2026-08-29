import { err, fail, i18n, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { AggregationSpec, ComputedColumnSpec, FilterTree, GroupBySpec, GroupSortSpec, RecordQuery, SearchSpec } from "../contracts";
import { collectFieldRefs, parseFormula } from "../formula/parser";
import { normalizeRefKey } from "../ref-syntax";
import { compileAggregates } from "./aggregate-compiler";
import { listByTable } from "./fields";
import { compileFilter } from "./filter-compiler";
import { compileGroupQuery, type GroupAggregationSpec } from "./group-compiler";
import { filterSearchableFields } from "./search";
import { compileSort } from "./sort-compiler";
import type { Field } from "./types";

type QueryParts = {
  filter?: FilterTree;
  search?: SearchSpec;
  sort?: RecordQuery["sort"];
  groupBy?: GroupBySpec[];
  groupSort?: GroupSortSpec[];
  aggregations?: AggregationSpec[];
  columns?: RecordQuery["columns"];
};

const queryValidationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      unknownField: "The query references a field that no longer exists.",
      computedColumnInvalid: ({ label }: { label: string }) => `Computed column “${label}” contains an invalid formula.`,
      fieldNotSearchable: ({ field }: { field: string }) => `Field “${field}” is not searchable.`,
      invalidFilter: "The filter is invalid.",
      invalidSort: "The sort is invalid.",
      groupSortRequiresGroupBy: "Group sorting requires a grouping.",
      invalidAggregation: "The aggregation is invalid.",
      invalidGrouping: "The grouping is invalid.",
    },
    de: {
      unknownField: "Die Abfrage referenziert ein Feld, das nicht mehr vorhanden ist.",
      computedColumnInvalid: ({ label }) => `Die berechnete Spalte „${label}“ enthält eine ungültige Formel.`,
      fieldNotSearchable: ({ field }) => `Das Feld „${field}“ kann nicht durchsucht werden.`,
      invalidFilter: "Der Filter ist ungültig.",
      invalidSort: "Die Sortierung ist ungültig.",
      groupSortRequiresGroupBy: "Für die Gruppensortierung ist eine Gruppierung erforderlich.",
      invalidAggregation: "Die Aggregation ist ungültig.",
      invalidGrouping: "Die Gruppierung ist ungültig.",
    },
  },
});

const messagesFor = (locale?: string) => queryValidationMessages.resolve(locale ? [locale] : []).t;

const unknownField = (locale?: string): Result<void> => fail(err.badInput(messagesFor(locale).unknownField));

const fieldById = (fields: Field[]): Map<string, Field> => new Map(fields.filter((f) => !f.deletedAt).map((f) => [f.id, f]));

const fieldRefs = (fields: Field[]): Set<string> => {
  const refs = new Set<string>();
  for (const field of fields.filter((f) => !f.deletedAt)) {
    refs.add(field.id);
    refs.add(normalizeRefKey(field.shortId));
    refs.add(normalizeRefKey(field.name));
  }
  return refs;
};

const validateFieldRefs = (ids: string[], fields: Field[], locale?: string): Result<void> => {
  const byId = fieldById(fields);
  for (const id of ids) {
    if (!byId.has(id)) return unknownField(locale);
  }
  return ok();
};

const validateComputedColumns = (columns: ComputedColumnSpec[], fields: Field[], locale?: string): Result<void> => {
  if (columns.length === 0) return ok();
  const refs = fieldRefs(fields);
  for (const column of columns) {
    const parsed = parseFormula(column.expression);
    if (!parsed.ok) return fail(err.badInput(messagesFor(locale).computedColumnInvalid({ label: column.label })));
    for (const ref of collectFieldRefs(parsed.ast)) {
      if (!refs.has(ref) && !refs.has(normalizeRefKey(ref))) return unknownField(locale);
    }
  }
  return ok();
};

const validateSearch = (search: SearchSpec | undefined, fields: Field[], locale?: string): Result<void> => {
  if (!search?.fieldIds || search.fieldIds.length === 0) return ok();
  const searchable = new Set(filterSearchableFields(fields).map((f) => f.id));
  for (const id of search.fieldIds) {
    if (!fieldById(fields).has(id)) return unknownField(locale);
    if (!searchable.has(id)) {
      const field = fields.find((f) => f.id === id);
      return fail(err.badInput(messagesFor(locale).fieldNotSearchable({ field: field?.name ?? id })));
    }
  }
  return ok();
};

const validateScalarAggregations = (aggregations: AggregationSpec[] | undefined, fields: Field[], locale?: string): Result<void> => {
  if (!aggregations || aggregations.length === 0) return ok();
  const compiled = compileAggregates(
    aggregations.map((a) => ({ fieldId: a.fieldId, agg: a.agg })),
    fields,
  );
  return compiled.ok ? ok() : fail(err.badInput(messagesFor(locale).invalidAggregation));
};

const validateGroupedQuery = (params: {
  tableId: string;
  fields: Field[];
  filter?: FilterTree;
  groupBy: GroupBySpec[];
  groupSort?: GroupSortSpec[];
  aggregations?: AggregationSpec[];
  locale?: string;
}): Result<void> => {
  const compiled = compileGroupQuery({
    tableId: params.tableId,
    fields: params.fields,
    filter: params.filter ?? null,
    groupBy: params.groupBy,
    groupSort: params.groupSort,
    aggregations: (params.aggregations ?? []) as GroupAggregationSpec[],
  });
  return compiled.ok ? ok() : fail(err.badInput(messagesFor(params.locale).invalidGrouping));
};

export const validateRecordQueryForFields = (tableId: string, parts: QueryParts, fields: Field[], locale?: string): Result<void> => {
  const messages = messagesFor(locale);
  const filter = compileFilter(parts.filter ?? null, fields);
  if (!filter.ok) return fail(err.badInput(messages.invalidFilter));

  const search = validateSearch(parts.search, fields, locale);
  if (!search.ok) return search;

  const sort = compileSort(parts.sort ?? [], fields, null);
  if (!sort.ok) return fail(err.badInput(messages.invalidSort));

  if (parts.columns) {
    const fieldColumns = parts.columns.filter((c): c is Extract<typeof c, { fieldId: string }> => "fieldId" in c);
    const cols = validateFieldRefs(
      fieldColumns.map((c) => c.fieldId),
      fields,
      locale,
    );
    if (!cols.ok) return cols;
    const computed = validateComputedColumns(
      parts.columns.filter((c): c is ComputedColumnSpec => "kind" in c && c.kind === "computed"),
      fields,
      locale,
    );
    if (!computed.ok) return computed;
  }

  const groupBy = parts.groupBy ?? [];
  const groupSort = parts.groupSort ?? [];
  if (groupBy.length === 0) {
    if (groupSort.length > 0) {
      return fail(err.badInput(messages.groupSortRequiresGroupBy));
    }
    return validateScalarAggregations(parts.aggregations, fields, locale);
  }

  return validateGroupedQuery({
    tableId,
    fields,
    filter: parts.filter,
    groupBy,
    groupSort,
    aggregations: parts.aggregations,
    locale,
  });
};

export const validateRecordQueryForTable = async (tableId: string, query: RecordQuery, locale?: string): Promise<Result<void>> => {
  const fields = await listByTable(tableId);
  return validateRecordQueryForFields(tableId, query, fields, locale);
};

export const tableBelongsToBase = async (tableId: string, baseId: string): Promise<boolean> => {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1
      FROM grids.tables t
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      WHERE t.id = ${tableId}::uuid
        AND t.base_id = ${baseId}::uuid
        AND t.deleted_at IS NULL
    ) AS exists
  `;
  return Boolean(row?.exists);
};
