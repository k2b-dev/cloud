import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import type { Context } from "hono";
import type { DslQueryPreviewResponse } from "../contracts";
import type { DslResolvedSqlQueryPlan } from "../query-dsl/resolver";
import { type GqlRuntimeTraceEnd, type GqlRuntimeTraceStart, gqlRuntimeTraceAttributes, gqlRuntimeTraceSummary } from "./gql-observability";
import { executeGqlSource } from "./gql-runtime";

import * as querySettings from "../service/query-settings";

// Exercise real admission and runtime logic with process configuration supplied locally.
let restoreQuerySettings: () => void;
beforeEach(() => {
  const settings = spyOn(querySettings, "getQuerySettings").mockResolvedValue({
    poolSize: 2,
    concurrency: 2,
    queueLimit: 4,
    queueTimeoutMs: 1000,
  });
  restoreQuerySettings = () => settings.mockRestore();
});
afterEach(() => restoreQuerySettings());

const uuid = () => crypto.randomUUID();

const successResponse = (): DslQueryPreviewResponse => ({
  ok: true,
  mode: "rows",
  columns: [
    {
      key: "Name",
      label: "Name",
      tableId: uuid(),
      fieldId: uuid(),
      type: "text",
      sqlType: "text",
    },
  ],
  rows: [{ recordId: uuid(), tableId: uuid(), values: { Name: "Ada" } }],
  limit: 100,
});

const queryPlan = (): DslResolvedSqlQueryPlan =>
  ({
    source: { kind: "table", id: uuid(), shortId: "tbl01", name: "People" },
    tableId: uuid(),
    readableTableIds: [],
    query: {},
  }) as DslResolvedSqlQueryPlan;

describe("gql runtime observability", () => {
  test("summarizes successful runs without recording query text", () => {
    const start: GqlRuntimeTraceStart = {
      baseId: uuid(),
      operation: "execute",
      surface: "workflow",
      maxRows: 10_000,
    };
    const end: GqlRuntimeTraceEnd = {
      stage: "execute",
      outcome: "success",
      plan: queryPlan(),
      response: successResponse(),
    };

    const attributes = gqlRuntimeTraceAttributes(start, end);
    const summary = gqlRuntimeTraceSummary(start, end);
    const serialized = JSON.stringify({ attributes, summary });

    expect(attributes).toMatchObject({
      "gql.operation": "execute",
      "gql.outcome": "success",
      "gql.result.rows": 1,
      "gql.surface": "workflow",
    });
    expect(summary).toMatchObject({ columns: 1, outcome: "success", rows: 1 });
    expect(serialized).not.toContain("select");
    expect(serialized).not.toContain("Ada");
  });

  test("records parser diagnostics through the runtime tracer without a database", async () => {
    const starts: GqlRuntimeTraceStart[] = [];
    const ends: GqlRuntimeTraceEnd[] = [];

    const context = {
      get: () => undefined,
      req: { raw: new Request("http://localhost/api/grids/query") },
    } as unknown as Context<AuthContext>;
    const result = await executeGqlSource(
      context,
      uuid(),
      { query: "from table {", surface: "query-explorer" },
      {
        operation: "preview",
        tracer: async (start) => {
          starts.push(start);
          return {
            end: async (end) => {
              ends.push(end);
            },
          };
        },
      },
    );

    expect(result.response.ok).toBe(false);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ operation: "preview", surface: "query-explorer" });
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ outcome: "diagnostic", stage: "parse" });
    expect(ends[0]?.response?.ok).toBe(false);
  });
});
