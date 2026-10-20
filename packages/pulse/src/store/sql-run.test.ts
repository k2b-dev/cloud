import { expect, test } from "bun:test";
import { createSqlRunner, mapSqlStoreError, scrubSqlMessage } from "./sql-run";
import { StoreQueryError } from "./client";
import { createBaseStore } from "./base-store";
const baseId = "00000000-0000-4000-8000-000000000001",
  runId = "00000000-0000-4000-8000-000000000002";
const connection = async () => ({ url: "http://fixture.invalid", user: "fixture_service", password: "fake-service-password" });
const store = createBaseStore();
store.readUserCredentials = async () => ({ user: "fixture_reader", password: "fake-reader-password" });
const requests: Request[] = [];
const runner = createSqlRunner({
  store,
  connection,
  transport: async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json(
      { meta: [{ name: "value", type: "String" }], data: [["value"]], statistics: { elapsed: 0.1, rows_read: 10, bytes_read: 80 } },
      {
        headers: {
          "X-ClickHouse-Query-Id": runId,
          "X-ClickHouse-Summary": JSON.stringify({
            read_rows: "20",
            read_bytes: "160",
            elapsed_ns: "200000000",
            peak_memory_usage: "4096",
          }),
        },
      },
    );
  },
});
test("SQL runs as read user, bindings and query id are request metadata, never SETTINGS", async () => {
  const result = await runner.run({
    baseId,
    runId,
    database: "fixture_db",
    profile: "normal",
    timezone: "UTC",
    sql: "SELECT :x;",
    params: { x: "'); DROP TABLE x; --" },
  });
  const request = requests.at(-1)!,
    url = new URL(request.url);
  expect(await request.text()).toBe("SELECT * FROM (\nSELECT {x:String}\n) LIMIT 10000");
  expect(url.searchParams.get("param_x")).toBe("'); DROP TABLE x; --");
  expect(url.searchParams.get("database")).toBe("fixture_db");
  expect(url.searchParams.get("query_id")).toBe(`pulse_sql_${baseId.replaceAll("-", "")}_${runId}`);
  expect([...url.searchParams.keys()].sort()).toEqual(["database", "default_format", "param_x", "query_id"]);
  expect(atob(request.headers.get("authorization")!.slice(6))).toBe("fixture_reader:fake-reader-password");
  expect(result.stats).toEqual({ elapsedMs: 200, readRows: 20, readBytes: 160, memoryBytes: 4096 });
});
test("error classes and wrapper positions are mapped; tenant names and credential removed", () => {
  const own = { database: `pulse_${"a".repeat(32)}`, user: `pulse_r_${"a".repeat(32)}`, password: "fake-private" };
  const foreign = `another_prefix_r_${"b".repeat(32)}`;
  const message = `Code: 62. DB::Exception: error at line 4, col 8 in ${own.database}, ${own.user}, ${foreign}, fake-private (query: SELECT 'private')`;
  const mapped = mapSqlStoreError(new StoreQueryError("clickhouse", 62, message), own);
  expect(mapped).toMatchObject({ code: "SQL_ERROR", details: { line: 3, column: 8 } });
  for (const secret of [own.database, own.user, own.password, foreign, "SELECT 'private'"]) expect(mapped.message).not.toContain(secret);
  for (const [code, wanted] of [
    [159, "TIME_LIMIT"],
    [241, "MEMORY_LIMIT"],
    [396, "RESULT_TOO_LARGE"],
    [47, "SQL_ERROR"],
    [60, "SQL_ERROR"],
    [497, "SQL_ERROR"],
    [46, "SQL_ERROR"],
  ] as const)
    expect(mapSqlStoreError(new StoreQueryError("clickhouse", code), own).code).toBe(wanted);
  expect(mapSqlStoreError(new Error("private"), own).code).toBe("STORE_UNAVAILABLE");
  expect(mapSqlStoreError(new Error(), own, AbortSignal.abort()).code).toBe("CANCELLED");
  expect(scrubSqlMessage("plain", own)).toBe("plain");
});
