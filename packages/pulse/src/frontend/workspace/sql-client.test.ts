import { afterEach, expect, spyOn, test } from "bun:test";
import { createSqlRunId, SqlClientError, sqlClient } from "./sql-client";
import { SQL_TEST_RUN_ID, sqlTestLimits, sqlTestQuery, sqlTestResult } from "./sql-test-fixtures";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const respond = (response: () => Response) => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: String(url), init });
      return response();
    },
    { preconnect: originalFetch.preconnect },
  );
  return calls;
};
test("run generates a UUID before transport, accepts a known cancel ID and forwards abort", async () => {
  const uuid = spyOn(crypto, "randomUUID").mockReturnValue(SQL_TEST_RUN_ID);
  try {
    const calls = respond(() => Response.json(sqlTestResult));
    const abort = new AbortController();
    expect(createSqlRunId()).toBe(SQL_TEST_RUN_ID);
    await sqlClient.run("Base01", { sql: "SELECT 1" }, abort.signal);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ sql: "SELECT 1", runId: SQL_TEST_RUN_ID });
    expect(calls[0]?.init?.signal).toBe(abort.signal);
    expect(new Headers(calls[0]?.init?.headers).get("Content-Type")).toBe("application/json");
    await sqlClient.cancel("Base01", SQL_TEST_RUN_ID);
    expect(calls[1]?.path).toBe("/api/pulse/bases/Base01/sql/cancel");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ runId: SQL_TEST_RUN_ID });
  } finally {
    uuid.mockRestore();
  }
});
test("limits and paginated saved-query CRUD use the exact API shapes", async () => {
  let result: unknown = sqlTestLimits;
  const calls = respond(() => Response.json(result));
  expect(await sqlClient.limits("Base01")).toEqual(sqlTestLimits);
  result = { items: [sqlTestQuery], total: 3, nextOffset: 2 };
  expect((await sqlClient.list("Base01", { limit: 1, offset: 1 })).nextOffset).toBe(2);
  result = sqlTestQuery;
  await sqlClient.get("Base01", "query/id");
  const input = { name: "CPU", sql: "SELECT :host", params: { host: "web-01" } };
  await sqlClient.create("Base01", input);
  await sqlClient.update("Base01", "Qry001", { ...input, expectedRevision: 2 });
  result = { deleted: true };
  await sqlClient.delete("Base01", "Qry001", 2);
  expect(calls.map((call) => [call.path, call.init?.method ?? "GET"])).toEqual([
    ["/api/pulse/bases/Base01/sql/limits", "GET"],
    ["/api/pulse/bases/Base01/queries?limit=1&offset=1", "GET"],
    ["/api/pulse/bases/Base01/queries/query%2Fid", "GET"],
    ["/api/pulse/bases/Base01/queries", "POST"],
    ["/api/pulse/bases/Base01/queries/Qry001", "PATCH"],
    ["/api/pulse/bases/Base01/queries/Qry001", "DELETE"],
  ]);
  expect(JSON.parse(String(calls[4]?.init?.body))).toEqual({ ...input, expectedRevision: 2 });
  expect(JSON.parse(String(calls[5]?.init?.body))).toEqual({ expectedRevision: 2 });
});
for (const code of [
  "SQL_ERROR",
  "TIME_LIMIT",
  "MEMORY_LIMIT",
  "RESULT_TOO_LARGE",
  "INPUT_TOO_LARGE",
  "PARAMETER_MISSING",
  "BUSY",
  "QUEUE_FULL",
  "QUOTA",
  "STORE_UNAVAILABLE",
  "NO_READ_ACCESS",
  "CANCELLED",
  "CONFLICT",
]) {
  test(`preserves ${code} and structured error metadata`, async () => {
    respond(() =>
      Response.json(
        { code, message: "Failure", line: 3, column: 8, resetAt: sqlTestLimits.resetAt },
        { status: 429, headers: { "Retry-After": "90" } },
      ),
    );
    try {
      await sqlClient.limits("Base01");
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SqlClientError);
      expect(error).toMatchObject({ code, status: 429, details: { line: 3, column: 8, retryAfter: 90, resetAt: sqlTestLimits.resetAt } });
    }
  });
}
test("non-JSON proxy failures still have a stable code and HTTP-date retry is preserved", async () => {
  respond(() => new Response("offline", { status: 503 }));
  await expect(sqlClient.limits("Base01")).rejects.toMatchObject({ code: "REQUEST_FAILED", status: 503 });
  respond(() => Response.json({ code: "QUOTA" }, { status: 429, headers: { "Retry-After": "Tue, 20 Oct 2026 15:00:00 GMT" } }));
  await expect(sqlClient.limits("Base01")).rejects.toMatchObject({ details: { resetAt: "2026-10-20T15:00:00.000Z" } });
});

test("write receipts travel only in the idempotency header", async () => {
  const calls = respond(() => Response.json(sqlTestQuery));
  const input = { name: "CPU", sql: "SELECT 1" };
  await sqlClient.create("Base01", input, undefined, SQL_TEST_RUN_ID);
  await sqlClient.update("Base01", "Qry001", { ...input, expectedRevision: 2 }, undefined, SQL_TEST_RUN_ID);
  await sqlClient.delete("Base01", "Qry001", 2, undefined, SQL_TEST_RUN_ID);
  for (const call of calls) expect(new Headers(call.init?.headers).get("Idempotency-Key")).toBe(SQL_TEST_RUN_ID);
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(input);
});
