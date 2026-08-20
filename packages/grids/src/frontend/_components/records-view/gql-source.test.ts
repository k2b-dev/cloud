import { describe, expect, test } from "bun:test";
import type { RecordQuery } from "../../../contracts";
import { filterToGqlWhere, simpleQueryToGqlSource } from "../../../query-dsl/record-query-source";

const tableId = "11111111-1111-4111-8111-111111111111";
const statusId = "22222222-2222-4222-8222-222222222222";
const amountId = "33333333-3333-4333-8333-333333333333";
const customerId = "44444444-4444-4444-8444-444444444444";
const userId = "55555555-5555-4555-8555-555555555555";

describe("GQL source builder", () => {
  test("converts simple filters and sort into readable GQL", () => {
    const query: RecordQuery = {
      filter: {
        op: "AND",
        filters: [
          { fieldId: statusId, op: "isAnyOf", value: ["open", "blocked"] },
          { fieldId: amountId, op: ">=", value: 100 },
        ],
      },
      sort: [{ fieldId: amountId, direction: "desc", nullsFirst: false }],
      search: { q: "urgent", fieldIds: [customerId] },
      limit: 50,
    };

    expect(simpleQueryToGqlSource({ tableId, query })).toEqual({
      ok: true,
      source: [
        `from table {${tableId}}`,
        `where (oneof({${statusId}}, 'open', 'blocked') and {${amountId}} >= 100)`,
        `sort {${amountId}} desc nulls last`,
        `search 'urgent' in {${customerId}}`,
        "limit 50",
      ].join("\n"),
    });
  });

  test("converts grouped views with aggregate sorting", () => {
    const query: RecordQuery = {
      groupBy: [{ fieldId: statusId }],
      aggregations: [
        { fieldId: amountId, agg: "sum", label: "total" },
        { fieldId: "*", agg: "count", label: "rows" },
      ],
      groupSort: [{ fieldId: amountId, agg: "sum", direction: "desc" }],
    };

    expect(simpleQueryToGqlSource({ tableId, query })).toEqual({
      ok: true,
      source: [
        `from table {${tableId}}`,
        `group by {${statusId}}`,
        `aggregate sum({${amountId}}) as total, count(*) as rows`,
        "sort total desc",
      ].join("\n"),
    });
  });

  test("generates deterministic aliases for unlabeled toolbar aggregations", () => {
    const query: RecordQuery = {
      groupBy: [{ fieldId: statusId }],
      aggregations: [
        { fieldId: "*", agg: "count" },
        { fieldId: amountId, agg: "sum" },
      ],
      groupSort: [{ fieldId: "*", agg: "count", direction: "desc" }],
    };

    expect(simpleQueryToGqlSource({ tableId, query })).toEqual({
      ok: true,
      source: [
        `from table {${tableId}}`,
        `group by {${statusId}}`,
        `aggregate count(*) as rows, sum({${amountId}}) as sum_33333333_3333_4333_8333_`,
        "sort rows desc",
      ].join("\n"),
    });
  });

  test("does not convert table footer aggregations into aggregate-only GQL source", () => {
    const query: RecordQuery = {
      aggregations: [{ fieldId: "*", agg: "count" }],
    };

    expect(simpleQueryToGqlSource({ tableId, query })).toEqual({
      ok: false,
      reason: "table footer aggregations are not part of row GQL source; use a direct GQL aggregate query",
    });
  });

  test("converts computed columns to explicit formula select aliases", () => {
    const query: RecordQuery = {
      columns: [
        { fieldId: amountId },
        {
          kind: "computed",
          id: "computed_margin",
          label: "margin",
          expression: `{${amountId}} * 0.2`,
        },
      ],
    };

    expect(simpleQueryToGqlSource({ tableId, query })).toEqual({
      ok: true,
      source: [`from table {${tableId}}`, `select {${amountId}}, formula({${amountId}} * 0.2) as __computed_margin`].join("\n"),
    });
  });

  test("uses safe internal aliases for computed labels that are not GQL aliases", () => {
    const query: RecordQuery = {
      columns: [
        { fieldId: amountId },
        {
          kind: "computed",
          id: "computed_j3rz0Y3fwW",
          label: "name+l#nge",
          expression: "LEN(Name)",
        },
      ],
    };

    expect(simpleQueryToGqlSource({ tableId, query })).toEqual({
      ok: true,
      source: [`from table {${tableId}}`, `select {${amountId}}, formula(LEN(Name)) as __computed_j3rz0Y3fwW`].join("\n"),
    });
  });

  test("converts record metadata filters and sorts to explicit record refs", () => {
    const query: RecordQuery = {
      recordMeta: { users: { createdBy: [userId] } },
      sort: [{ source: "record", key: "createdAt", direction: "desc" }],
    };

    expect(simpleQueryToGqlSource({ tableId, query })).toEqual({
      ok: true,
      source: [`from table {${tableId}}`, `where record.createdBy = '${userId}'`, "sort record.createdAt desc"].join("\n"),
    });
  });

  test("converts Finalization state metadata to reserved Record refs", () => {
    expect(
      simpleQueryToGqlSource({
        tableId,
        query: { recordMeta: { finalizationStates: ["draft", "awaitingReview"] } },
      }),
    ).toEqual({
      ok: true,
      source: [`from table {${tableId}}`, "where oneof(record.finalizationState, 'draft', 'awaitingReview')"].join("\n"),
    });
  });

  test("refuses unsupported legacy-only filter operators", () => {
    expect(filterToGqlWhere({ fieldId: customerId, op: "regex", value: "^A" })).toEqual({
      ok: false,
      reason: "operator regex is only available in direct GQL",
    });
  });

  test("uses formula-backed GQL for relative date filters that are expressible", () => {
    expect(filterToGqlWhere({ fieldId: amountId, op: "lastNDays", value: 7 })).toEqual({
      ok: true,
      source: `{${amountId}} >= DATEADD(TODAY(), -7, 'days')`,
    });
  });
});
