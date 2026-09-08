import { describe, expect, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import { BoundedQueryTimeoutError } from "../service/bounded-query";
import { createTableQueryRoutes } from "./table-query-routes";

const baseId = "11111111-1111-4111-8111-111111111111";
const tableId = "22222222-2222-4222-8222-222222222222";
const viewId = "33333333-3333-4333-8333-333333333333";
const tablePublicId = "T4BL01";
const viewPublicId = "V1EW01";
const userId = "44444444-4444-4444-8444-444444444444";

const table = { id: tableId, baseId, kind: "stored" as const };
const view = {
  id: viewId,
  tableId,
  ownerUserId: "55555555-5555-4555-8555-555555555555",
  source: `from table {${tableId}} limit 10`,
  ui: {},
};

type RouteDeps = NonNullable<Parameters<typeof createTableQueryRoutes>[0]>;

const makeDeps = (
  overrides: {
    table?: (Omit<typeof table, "kind"> & { kind: "stored" | "federated" }) | null;
    view?: typeof view | null;
    tableReadable?: boolean;
    onCompile?: (options: Record<string, unknown>) => void;
    onList?: (options: Record<string, unknown>) => void;
    onExecute?: (body: Parameters<RouteDeps["executeQuery"]>[2]) => void;
    listError?: Error;
    fields?: Array<{ id: string; shortId: string; type: string; config: Record<string, unknown> }>;
  } = {},
): RouteDeps => {
  const rank = { none: 0, read: 1, write: 2, admin: 3 };
  const service = {
    table: { getByShortId: async () => (overrides.table === undefined ? table : overrides.table) },
    view: { getByShortIdForTable: async () => (overrides.view === undefined ? view : overrides.view) },
    permission: {
      hasAtLeast: (actual: keyof typeof rank, expected: keyof typeof rank) => rank[actual] >= rank[expected],
    },
    field: { listByTable: async () => overrides.fields ?? [] },
    record: {
      list: async (options: Record<string, unknown>) => {
        overrides.onList?.(options);
        if (overrides.listError) throw overrides.listError;
        return { ok: true, data: { items: [], nextCursor: null, filePreviews: {} } };
      },
      aggregate: async () => ({ ok: true, data: {} }),
      group: async () => ({ ok: true, data: { buckets: [], nextCursor: null, explode: false } }),
    },
    relations: { buildLabelCacheForGroupedKeys: async () => ({}) },
  };
  const compileGql: RouteDeps["compileGql"] = async (_context, options) => {
    overrides.onCompile?.(options as unknown as Record<string, unknown>);
    return { ok: true, query: { limit: 10 } } as Awaited<ReturnType<RouteDeps["compileGql"]>>;
  };
  const executeQuery: RouteDeps["executeQuery"] = async (_context, _baseId, body) => {
    overrides.onExecute?.(body);
    return {
      ok: true,
      response: { ok: true, mode: "groups", columns: [], rows: [], limit: 100 },
      revisionScope: [],
    };
  };

  return {
    service,
    compileGql,
    executeQuery,
    validateQuery: () => ok(undefined),
    dateConfig: async () => ({}) as never,
    gate: async () =>
      overrides.tableReadable ? ok("read" as const) : fail(err.forbidden("You do not have permission to access this resource.")),
    viewer: () => ({ userId, userGroups: [], serviceAccountId: null }),
    verifyFederatedRevision: async () => ok(),
  } as unknown as RouteDeps;
};

const requestQuery = (deps: RouteDeps, body: Record<string, unknown>) =>
  createTableQueryRoutes(deps).request(`/${tablePublicId}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("table query routes", () => {
  test("passes bound structured queries directly to the shared executor for combined tables", async () => {
    const fieldId = "77777777-7777-4777-8777-777777777777";
    let executed: Parameters<RouteDeps["executeQuery"]>[2] | undefined;
    const response = await requestQuery(
      makeDeps({
        table: { ...table, kind: "federated" },
        tableReadable: true,
        fields: [{ id: fieldId, shortId: "F1ELD1", type: "text", config: {} }],
        onExecute: (body) => {
          executed = body;
        },
      }),
      { query: { filter: { fieldId: "F1ELD1", op: "equals", value: "Unknown record" }, limit: 12 }, cursor: "cursor-token" },
    );
    expect(response.status).toBe(200);
    expect(executed).toMatchObject({
      currentTableId: tableId,
      query: { filter: { fieldId, op: "equals", value: "Unknown record" } },
      pageSize: 12,
      cursor: "cursor-token",
      surface: "records-view",
    });
    expect(executed?.query.limit).toBeUndefined();
  });

  test("returns 404 for an unknown table", async () => {
    const response = await requestQuery(makeDeps({ table: null }), { query: {} });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Table not found" });
  });

  test("denies direct queries without table read access", async () => {
    const response = await requestQuery(makeDeps(), { query: {} });

    expect(response.status).toBe(403);
  });

  test("denies saved views when their owning Base is unreadable", async () => {
    const response = await requestQuery(makeDeps(), { query: {}, viewId: viewPublicId });

    expect(response.status).toBe(403);
  });

  test("runs every saved GQL view after the owning Base read gate", async () => {
    let compileOptions: Record<string, unknown> | undefined;
    let listCalls = 0;
    const response = await requestQuery(
      makeDeps({
        tableReadable: true,
        onCompile: (options) => {
          compileOptions = options;
        },
        onList: () => {
          listCalls += 1;
        },
      }),
      { viewId: viewPublicId, source: view.source },
    );

    expect(response.status).toBe(200);
    expect(compileOptions).toMatchObject({ baseId, tableId, source: view.source });
    expect(listCalls).toBe(1);
    expect(await response.json()).toEqual({ items: [], nextCursor: null, filePreviews: {} });
  });

  test("uses a complete structured query instead of recompiling its validated saved-view context", async () => {
    let compiled = false;
    let listed: Record<string, unknown> | undefined;
    const fieldId = "77777777-7777-4777-8777-777777777777";
    const response = await requestQuery(
      makeDeps({
        tableReadable: true,
        fields: [{ id: fieldId, shortId: "F1ELD1", type: "text", config: {} }],
        onCompile: () => {
          compiled = true;
        },
        onList: (options) => {
          listed = options;
        },
      }),
      { viewId: viewPublicId, query: { filter: { fieldId: "F1ELD1", op: "equals", value: "customized" }, limit: 17 } },
    );
    expect(response.status).toBe(200);
    expect(compiled).toBe(false);
    expect(listed).toMatchObject({ filter: { fieldId, op: "equals", value: "customized" }, limit: 17 });
  });

  test("explicit GQL source remains authoritative over structured presentation and a saved view", async () => {
    let compiled: Record<string, unknown> | undefined;
    const source = "from table {T4BL01} limit 7";
    const response = await requestQuery(
      makeDeps({
        tableReadable: true,
        onCompile: (options) => {
          compiled = options;
        },
      }),
      {
        viewId: viewPublicId,
        source,
        query: { limit: 17 },
      },
    );
    expect(response.status).toBe(200);
    expect(compiled).toMatchObject({ source, presentation: { limit: 17 } });
  });

  test("still validates the view ID when a complete structured query is supplied", async () => {
    const response = await requestQuery(makeDeps({ tableReadable: true, view: null }), { viewId: viewPublicId, query: {} });
    expect(response.status).toBe(404);
  });

  test("returns a retryable response when the database query exceeds its budget", async () => {
    const response = await requestQuery(makeDeps({ tableReadable: true, listError: new BoundedQueryTimeoutError(5_000) }), { query: {} });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.json()).toEqual({ message: "Query took too long. Narrow the query and retry." });
  });

  test("resolves structured public field ids before calling the record service", async () => {
    let options: Record<string, unknown> | undefined;
    const fieldId = "77777777-7777-4777-8777-777777777777";
    const response = await requestQuery(
      makeDeps({
        tableReadable: true,
        fields: [{ id: fieldId, shortId: "F1ELD1", type: "text", config: {} }],
        onList: (value) => {
          options = value;
        },
      }),
      { query: { filter: { fieldId: "F1ELD1", op: "equals", value: "ready" } } },
    );

    expect(response.status).toBe(200);
    expect(options?.filter).toEqual({ fieldId, op: "equals", value: "ready" });
  });

  test("rejects UUID and five-character structured public ids", async () => {
    for (const fieldId of ["77777777-7777-4777-8777-777777777777", "F1ELD"]) {
      const response = await requestQuery(makeDeps({ tableReadable: true }), {
        query: { filter: { fieldId, op: "equals", value: "ready" } },
      });
      expect(response.status).toBe(400);
    }
  });
});
