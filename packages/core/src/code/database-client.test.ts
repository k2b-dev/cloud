import { afterAll, beforeAll, expect, test } from "bun:test";
import { CodeBridgeRefusal } from "@k2b/cloud/api";
import { CODE_DATABASE_LIMITS } from "@k2b/cloud/code";
import { codeRsqlResult, createCodeDatabaseClient } from "./database-client";

let server: ReturnType<typeof Bun.serve>;
let reply = () => Response.json({ data: [{ value: "bound" }] });
const requests: Array<{ path: string; body: unknown; authorization: string | null }> = [];
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        body: request.method === "GET" ? null : await request.json(),
        authorization: request.headers.get("authorization"),
      });
      return reply();
    },
  });
});
afterAll(async () => {
  await server?.stop(true);
});
const client = (signal?: AbortSignal) =>
  createCodeDatabaseClient({ url: server.url.toString(), token: "fixture-rsql-token", allowedTargets: ["127.0.0.1"] }, signal);

test("real RSQL client sends SQL parameters unchanged over the allowlisted host transport", async () => {
  reply = () => Response.json({ data: [{ value: "bound" }] });
  const injection = "x'); DROP TABLE notes; --";
  expect(await client().execute("code_c_first", { operation: "db.query", sql: "SELECT ? AS value", params: [injection] })).toEqual([
    { value: "bound" },
  ]);
  expect(requests.at(-1)).toEqual({
    path: "/v1/code_c_first/query",
    body: { sql: "SELECT ? AS value", params: [injection] },
    authorization: "Bearer fixture-rsql-token",
  });
});

test("upstream quota, timeout and missing RSQL are stable payload-free Code errors", async () => {
  for (const [upstream, status, code] of [
    ["quota_exceeded", 413, "code_db_full"],
    ["sql_timeout", 408, "code_db_timeout"],
    ["sql_limit_exceeded", 413, "code_db_limit"],
    ["unauthorized", 401, "code_db_unavailable"],
  ] as const) {
    reply = () => Response.json({ error: upstream, message: "private upstream detail" }, { status });
    await expect(client().execute("code_c_first", { operation: "db.query", sql: "SELECT 1", params: [] })).rejects.toMatchObject({ code });
  }
  expect(() =>
    codeRsqlResult({ ok: false, status: 500, headers: new Headers(), error: { error: "internal", message: "private upstream detail" } }),
  ).toThrow(CodeBridgeRefusal);
  expect(() => createCodeDatabaseClient({ url: "", token: "", allowedTargets: [] })).toThrow("code_db_unavailable");
});

test("the response stream is bounded before the client parses JSON", async () => {
  reply = () => new Response("x".repeat(CODE_DATABASE_LIMITS.resultBytes + 1));
  await expect(client().execute("code_c_first", { operation: "db.query", sql: "SELECT 1", params: [] })).rejects.toMatchObject({
    code: "code_db_limit",
  });
});

test("a cancelled run cannot contact RSQL", async () => {
  const before = requests.length;
  await expect(
    client(AbortSignal.abort()).execute("code_c_first", { operation: "db.query", sql: "SELECT 1", params: [] }),
  ).rejects.toMatchObject({ code: "code_db_unavailable" });
  expect(requests).toHaveLength(before);
});

test("an invalid upstream response exposes no payload in the stable error", async () => {
  reply = () => Response.json({ data: "private upstream detail" });
  await expect(client().execute("code_c_first", { operation: "db.query", sql: "SELECT 1", params: [] })).rejects.toMatchObject({
    code: "code_db_unavailable",
    message: "code_db_unavailable",
  });
});

test("a run deadline is a timeout rather than missing RSQL configuration", async () => {
  const signal = AbortSignal.abort(new DOMException("Run deadline", "TimeoutError"));
  await expect(client(signal).execute("code_c_first", { operation: "db.query", sql: "SELECT 1", params: [] })).rejects.toMatchObject({
    code: "code_db_timeout",
    message: "code_db_timeout",
  });
});
