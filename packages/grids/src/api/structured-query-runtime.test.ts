import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { AuthContext } from "@valentinkolb/cloud/server";
import type { Context } from "hono";
import type { Table } from "../contracts";
import * as parser from "../query-dsl/parser";
import * as preview from "../query-dsl/preview";
import { field } from "../query-dsl/resolver-fixtures";
import { encodeDslResultCursor } from "../query-dsl/result-cursor";
import { gridsService } from "../service";
import type { GqlRuntimeTraceEnd } from "./gql-observability";
import { executeRecordQuery } from "./gql-runtime";

const baseId = "11111111-1111-4111-8111-111111111111";
const tableId = "22222222-2222-4222-8222-222222222222";
const fieldId = "33333333-3333-4333-8333-333333333333";
const table: Table = {
  id: tableId,
  shortId: "TABLE1",
  baseId,
  name: "Combined",
  kind: "federated",
  description: null,
  icon: "table",
  columns: [],
  displayConfig: { mode: "table" },
  auditPolicy: {},
  mutationPolicy: { mode: "all" },
  position: 0,
  disableDirectInsert: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const context = {
  get: () => undefined,
  req: { raw: new Request("http://localhost/api/grids/query") },
} as unknown as Context<AuthContext>;
const restores: Array<() => void> = [];
const originalSecret = process.env.APP_SECRET;
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  if (originalSecret === undefined) delete process.env.APP_SECRET;
  else process.env.APP_SECRET = originalSecret;
});

const setup = (allowed = true) => {
  process.env.APP_SECRET = "structured-query-runtime-test";
  const tables = spyOn(gridsService.table, "listByBase").mockResolvedValue([table]);
  const grants = spyOn(gridsService.permission, "loadBaseGrantsForSubject").mockResolvedValue(
    allowed ? [{ resourceType: "base", resourceId: baseId, principalTier: "public", level: "read" }] : [],
  );
  const fields = spyOn(gridsService.field, "listByTables").mockResolvedValue(
    new Map([[tableId, [field({ id: fieldId, shortId: "FIELD1", tableId, name: "Name", type: "text" })]]]),
  );
  const revisions = spyOn(gridsService.table.federation, "captureRevisionScope").mockResolvedValue([]);
  const parse = spyOn(parser, "parseGridsQueryDsl");
  const run = spyOn(preview, "previewDslQuery").mockResolvedValue(ok({ ok: true, mode: "rows", columns: [], rows: [], limit: 100 }));
  restores.push(...[tables, grants, fields, revisions, parse, run].map((mock) => () => mock.mockRestore()));
  const ends: GqlRuntimeTraceEnd[] = [];
  const options = {
    tracer: async () => ({
      end: async (end: GqlRuntimeTraceEnd) => {
        ends.push(end);
      },
    }),
  };
  return { parse, run, ends, options };
};

describe("structured query shared runtime", () => {
  test("does not parse generated source and forwards bound identity, authorization and execution limits", async () => {
    const { parse, run, ends, options } = setup();
    const query = { filter: { fieldId, op: "equals" as const, value: "Unknown record" } };
    const result = await executeRecordQuery(
      context,
      baseId,
      { currentTableId: tableId, query, pageSize: 12 },
      {
        ...options,
        maxRows: 1000,
        labelRelationValues: false,
        expectedFederatedRevisionScope: [],
      },
    );
    expect(result.response.ok).toBe(true);
    expect(parse).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ tableId, query, readableTableIds: [tableId] });
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      primaryTableAuthorized: true,
      authorizedTableIds: new Set([tableId]),
      pageSize: 12,
      maxRows: 1000,
      labelRelationValues: false,
      expectedFederatedRevisionScope: [],
    });
    expect(ends[0]).toMatchObject({ stage: "execute", outcome: "success" });
  });

  test("does not execute an unreadable structured source", async () => {
    const { run, options } = setup(false);
    const result = await executeRecordQuery(context, baseId, { currentTableId: tableId, query: {} }, options);
    expect(result.response.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  test("rejects a correctly signed cursor belonging to a different query before execution", async () => {
    const { run, options } = setup();
    const cursor = encodeDslResultCursor({ fingerprint: "another-query", pageSize: 10, start: 10, values: [] }, process.env.APP_SECRET!);
    const result = await executeRecordQuery(context, baseId, { currentTableId: tableId, query: {}, cursor }, options);
    expect(result.response).toMatchObject({ ok: false, diagnostics: [{ code: "gql.cursor" }] });
    expect(run).not.toHaveBeenCalled();
  });

  test("validates bound field references before execution", async () => {
    const { run, options } = setup();
    const result = await executeRecordQuery(
      context,
      baseId,
      {
        currentTableId: tableId,
        query: { sort: [{ fieldId: "44444444-4444-4444-8444-444444444444", direction: "asc" }] },
      },
      options,
    );
    expect(result.response.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
