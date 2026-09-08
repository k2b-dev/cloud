import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import type { RecordQuery } from "../contracts";
import { aggregateOutputKey } from "../service/aggregate-capabilities";
import { normalizedSqlParts } from "../sql-test-utils";
import { parseGridsQueryDsl } from "./parser";
import { recordQueryPlan } from "./record-query-plan";
import { resolveDslQueryToQueryPlan } from "./resolver";
import { field } from "./resolver-fixtures";
import { compileDslAggregateQueryPlanToSql, compileDslGroupedQueryPlanToSql, compileDslQueryPlanToSql } from "./sql-compiler";
import type { DslSqlCompileOptions } from "./sql-compiler-types";

const source = { kind: "table" as const, id: "11111111-1111-4111-8111-111111111111", shortId: "TABLE1", name: "Records" };
const fieldId = "22222222-2222-4222-8222-222222222222";
const numberId = "33333333-3333-4333-8333-333333333333";
const fields = [
  field({ id: fieldId, shortId: "FIELD1", tableId: source.id, name: "Name", type: "text" }),
  field({ id: numberId, shortId: "NUMBER", tableId: source.id, name: "Amount", type: "number" }),
];
const compileOptions: DslSqlCompileOptions = { fieldsByTableId: { [source.id]: fields } };

describe("structured record query plan", () => {
  test("keeps bound values, metadata, search, sorting and computed identities without source serialization", () => {
    const query: RecordQuery = {
      filter: { fieldId, op: "equals", value: 'Unknown record\n"quoted"' },
      search: { q: " exact search ", fieldIds: [fieldId] },
      sort: [{ source: "record", key: "updatedAt", direction: "desc", nullsFirst: true }],
      columns: [{ kind: "computed", id: "computed-original-id", label: "Human label with spaces", expression: "1 + 2" }],
      recordMeta: { ids: ["33333333-3333-4333-8333-333333333333"], finalizationStates: ["draft"] },
      limit: 25,
    };
    const plan = recordQueryPlan({ source, query, readableTableIds: [source.id] });
    expect(plan).toEqual({ source, tableId: source.id, query, readableTableIds: [source.id] });
    expect(plan.query).toBe(query);
  });

  test("deleted-by metadata selects deleted rows without mutating the input", () => {
    const query: RecordQuery = { recordMeta: { users: { deletedBy: ["33333333-3333-4333-8333-333333333333"] } }, includeDeleted: true };
    const plan = recordQueryPlan({ source, query, readableTableIds: [] });
    expect(plan.query.deletedOnly).toBe(true);
    expect(query.deletedOnly).toBeUndefined();
    expect(plan.readableTableIds).toEqual([]);
  });

  test("retains group and aggregate identities and arbitrary presentation labels", () => {
    const query: RecordQuery = {
      groupBy: [{ fieldId, direction: "desc", nullsFirst: true }],
      aggregations: [{ fieldId: "*", agg: "count", label: "Anzahl der Einträge" }],
      groupSort: [{ fieldId: "*", agg: "count", direction: "desc" }],
    };
    expect(recordQueryPlan({ source, query, readableTableIds: [source.id] }).query).toEqual(query);
  });

  test("native groupBy and groupSort control both stored and physical-source compilers, independent of a retained row sort", () => {
    const grouped: RecordQuery = {
      groupBy: [{ fieldId, direction: "desc", nullsFirst: true }],
      aggregations: [{ fieldId: "*", agg: "count", label: "Rows" }],
      groupSort: [{ fieldId: "*", agg: "count", direction: "asc", nullsFirst: false }],
    };
    const retainedRowSort: RecordQuery = { ...grouped, sort: [{ fieldId, direction: "asc", nullsFirst: false }] };
    for (const options of [
      compileOptions,
      {
        ...compileOptions,
        recordSource: { kind: "stored" as const, tableId: source.id, relation: sql`grids.records`, relationMappings: [] as [] },
      },
    ]) {
      const withRowSort = compileDslGroupedQueryPlanToSql(
        recordQueryPlan({ source, query: retainedRowSort, readableTableIds: [source.id] }),
        options,
      );
      const withoutRowSort = compileDslGroupedQueryPlanToSql(
        recordQueryPlan({ source, query: grouped, readableTableIds: [source.id] }),
        options,
      );
      expect(withRowSort.ok).toBe(true);
      expect(withoutRowSort.ok).toBe(true);
      if (!withRowSort.ok || !withoutRowSort.ok) return;
      expect(normalizedSqlParts(withRowSort.query.sql)).toEqual(normalizedSqlParts(withoutRowSort.query.sql));
      const changedDirection = compileDslGroupedQueryPlanToSql(
        recordQueryPlan({
          source,
          query: { ...grouped, groupBy: [{ fieldId, direction: "asc", nullsFirst: false }] },
          readableTableIds: [source.id],
        }),
        options,
      );
      expect(changedDirection.ok).toBe(true);
      if (changedDirection.ok)
        expect(normalizedSqlParts(withRowSort.query.sql).text).not.toBe(normalizedSqlParts(changedDirection.query.sql).text);
      expect(withRowSort.query.columns.map((column) => column.key)).toEqual(["gk_0", aggregateOutputKey("*", "count")]);
    }
  });

  test("aggregate output keys match parsed source and never depend on presentation labels", () => {
    const query: RecordQuery = {
      aggregations: [
        { fieldId: "*", agg: "count", label: "rows" },
        { fieldId: numberId, agg: "sum", label: "total" },
      ],
    };
    const parsed = parseGridsQueryDsl(`from table {${source.shortId}}\naggregate count(*) as rows, sum({NUMBER}) as total`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveDslQueryToQueryPlan(parsed.ast, { tables: [source], fieldsByTableId: compileOptions.fieldsByTableId });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const textual = compileDslAggregateQueryPlanToSql(resolved.plan, compileOptions);
    const direct = compileDslAggregateQueryPlanToSql(recordQueryPlan({ source, query, readableTableIds: [source.id] }), compileOptions);
    expect(textual.ok).toBe(true);
    expect(direct.ok).toBe(true);
    if (!textual.ok || !direct.ok) return;
    expect(direct.query.columns).toEqual(textual.query.columns);
    expect(normalizedSqlParts(direct.query.sql)).toEqual(normalizedSqlParts(textual.query.sql));
    expect(direct.query.columns.map((column) => column.key)).toEqual([
      aggregateOutputKey("*", "count"),
      aggregateOutputKey(numberId, "sum"),
    ]);

    const labeled = compileDslAggregateQueryPlanToSql(
      recordQueryPlan({
        source,
        readableTableIds: [source.id],
        query: {
          aggregations: query.aggregations?.map((aggregate) => ({ ...aggregate, label: "Nicht als GQL-Alias gültig" })),
        },
      }),
      compileOptions,
    );
    expect(labeled.ok).toBe(true);
    if (labeled.ok) expect(labeled.query.columns.map((column) => column.key)).toEqual(direct.query.columns.map((column) => column.key));
  });

  test("explicit mixed projections retain computed-column positions and stored field identities", () => {
    const query: RecordQuery = {
      columns: [
        { kind: "computed", id: "computed-original", label: "A computed value", expression: "1 + 2" },
        { fieldId },
        { kind: "computed", id: "computed-second", label: "A second value", expression: "3 + 4" },
      ],
    };
    const compiled = compileDslQueryPlanToSql(recordQueryPlan({ source, query, readableTableIds: [source.id] }), compileOptions);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.query.columns.map((column) => ({ fieldId: column.fieldId, label: column.label }))).toEqual([
      { fieldId: undefined, label: "A computed value" },
      { fieldId, label: "Name" },
      { fieldId: undefined, label: "A second value" },
    ]);
  });
});
