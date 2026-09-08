import { describe, expect, test } from "bun:test";
import { TableQueryBodySchema } from "../../../contracts";
import { buildTableQueryBody, TableQueryError } from "./fetcher";

// fetchTableQuery itself is thin glue over apiClient + fetch — it's
// exercised end-to-end by RecordsView in browser tests. Unit-testing
// it would require mocking the Hono RPC client, which buys little
// for ~15 LOC of code. We at least lock the exported error class
// so the contract with consumers stays stable.

describe("TableQueryError", () => {
  test("captures status + message", () => {
    const e = new TableQueryError(403, "forbidden");
    expect(e.status).toBe(403);
    expect(e.message).toBe("forbidden");
    expect(e.name).toBe("TableQueryError");
  });

  test("is an Error instance — try/catch and instanceof both work", () => {
    const e = new TableQueryError(500, "boom");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(TableQueryError);
  });
});

describe("TableQueryBodySchema", () => {
  test("accepts canonical GQL source without a RecordQuery body", () => {
    expect(
      TableQueryBodySchema.safeParse({
        source: "from table {TABL01}",
      }).success,
    ).toBe(true);
  });

  test("requires source or query even when a view identifies the context", () => {
    expect(TableQueryBodySchema.safeParse({ viewId: "11111111-1111-4111-8111-111111111111" }).success).toBe(false);
    expect(TableQueryBodySchema.safeParse({ cursor: "next" }).success).toBe(false);
  });
});

describe("buildTableQueryBody", () => {
  test("sends the complete effective structured query for ordinary and saved-view records reads", () => {
    const body = buildTableQueryBody({
      tableId: "TABL01",
      viewId: "VIEW01",
      query: { sort: [{ fieldId: "FIELD1", direction: "asc" }] },
      cursor: "next",
      filePreviewFieldIds: ["FILE01"],
    });

    expect(body).toMatchObject({
      viewId: "VIEW01",
      query: { sort: [{ fieldId: "FIELD1", direction: "asc" }] },
      cursor: "next",
      filePreviewFieldIds: ["FILE01"],
    });
    expect(body.source).toBeUndefined();
  });

  test("sends footer aggregations in the same structured query", () => {
    const body = buildTableQueryBody({
      tableId: "TABL01",
      query: { aggregations: [{ fieldId: "*", agg: "count" }] },
      cursor: null,
    });

    expect(body).toEqual({
      query: { aggregations: [{ fieldId: "*", agg: "count" }] },
      cursor: undefined,
      filePreviewFieldIds: undefined,
      viewId: undefined,
    });
  });

  test("does not throw for computed column labels that are not valid GQL aliases", () => {
    const body = buildTableQueryBody({
      tableId: "TABL01",
      query: {
        columns: [
          { fieldId: "FIELD1" },
          {
            kind: "computed",
            id: "computed_j3rz0Y3fwW",
            label: "name+l#nge",
            expression: "LEN(Name)",
          },
        ],
      },
      cursor: null,
    });

    expect(body.source).toBeUndefined();
    expect(body.query?.columns?.[1]).toMatchObject({ label: "name+l#nge" });
  });
});
