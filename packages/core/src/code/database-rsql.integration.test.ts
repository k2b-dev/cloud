import { afterAll, beforeAll, expect, test } from "bun:test";
import { requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type CodeDatabaseClient, createCodeDatabaseClient } from "./database-client";

suiteFor("rsql")("Code database adapter against released RSQL", () => {
  let client: CodeDatabaseClient;
  const first = `code_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const second = `${first}_other`;
  const deleted = `${first}_deleted`;
  const quota = 104857600;
  beforeAll(async () => {
    const url = new URL(requireInfraUrl("rsql"));
    client = createCodeDatabaseClient({
      url: url.toString(),
      token: process.env.RSQL_API_TOKEN ?? "cloud-code-test-token",
      allowedTargets: [url.hostname],
    });
    await client.create(first, quota, 15000);
    await client.create(second, quota, 15000);
  });
  afterAll(async () => {
    if (!client) return;
    await client.remove(first);
    await client.remove(second);
    await client.remove(deleted);
  });

  test("bound writes, injection input and an atomic batch retain only the intended rows", async () => {
    await client.execute(first, {
      operation: "db.exec",
      sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
      params: [],
    });
    const injection = "x'); DROP TABLE notes; --";
    expect(await client.execute(first, { operation: "db.exec", sql: "INSERT INTO notes(body) VALUES (?)", params: [injection] })).toEqual({
      changes: 1,
    });
    expect(
      await client.execute(first, { operation: "db.query", sql: "SELECT body FROM notes WHERE body = ?", params: [injection] }),
    ).toEqual([{ body: injection }]);
    expect(
      await client.execute(first, {
        operation: "db.batch",
        statements: [
          { sql: "INSERT INTO notes(body) VALUES (?)", params: ["second"] },
          { sql: "INSERT INTO notes(body) VALUES (?)", params: ["third"] },
        ],
      }),
    ).toEqual([{ changes: 1 }, { changes: 1 }]);
    await expect(
      client.execute(first, {
        operation: "db.batch",
        statements: [
          { sql: "INSERT INTO notes(body) VALUES (?)", params: ["must roll back"] },
          { sql: "INSERT INTO missing_table(body) VALUES (?)", params: ["failure"] },
        ],
      }),
    ).rejects.toMatchObject({ code: "code_db_sql" });
    expect(await client.execute(first, { operation: "db.query", sql: "SELECT count(*) AS total FROM notes", params: [] })).toEqual([
      { total: 3 },
    ]);
  });

  test("namespace isolation also holds for SQL attempting to attach another database", async () => {
    await client.execute(first, { operation: "db.exec", sql: "CREATE TABLE isolation_marker (body TEXT)", params: [] });
    await expect(
      client.execute(second, { operation: "db.query", sql: "SELECT body FROM isolation_marker", params: [] }),
    ).rejects.toMatchObject({
      code: "code_db_sql",
    });
    await expect(
      client.execute(second, { operation: "db.exec", sql: "ATTACH DATABASE ? AS other", params: [first] }),
    ).rejects.toMatchObject({ code: "code_db_sql" });
  });

  test("RSQL enforces storage quota and the adapter bounds result bytes and statement time", async () => {
    await client.execute(first, { operation: "db.exec", sql: "CREATE TABLE quota_payload (body BLOB)", params: [] });
    const used = await client.size(first);
    await client.configure(first, used + 32768, 15000);
    await expect(
      client.execute(first, { operation: "db.exec", sql: "INSERT INTO quota_payload(body) VALUES (zeroblob(?))", params: [1048576] }),
    ).rejects.toMatchObject({ code: "code_db_full" });
    await client.configure(first, quota, 15000);
    await expect(
      client.execute(first, { operation: "db.query", sql: "SELECT hex(zeroblob(?)) AS body", params: [262144] }),
    ).rejects.toMatchObject({ code: "code_db_limit" });
    await client.configure(first, quota, 20);
    await expect(
      client.execute(first, {
        operation: "db.query",
        sql: "WITH RECURSIVE counter(x) AS (VALUES(0) UNION ALL SELECT x + 1 FROM counter WHERE x < ?) SELECT sum(x) AS total FROM counter",
        params: [1000000000],
      }),
    ).rejects.toMatchObject({ code: "code_db_timeout" });
  });

  test("configuring or querying a deleted namespace cannot recreate it", async () => {
    await client.create(deleted, quota, 15000);
    await client.remove(deleted);
    await expect(client.configure(deleted, quota, 15000)).rejects.toMatchObject({ code: "code_db_unavailable" });
    await expect(client.execute(deleted, { operation: "db.query", sql: "SELECT 1", params: [] })).rejects.toMatchObject({
      code: "code_db_unavailable",
    });
    await expect(
      client.execute(deleted, { operation: "db.exec", sql: "CREATE TABLE resurrected (id INTEGER)", params: [] }),
    ).rejects.toMatchObject({
      code: "code_db_unavailable",
    });
    await expect(client.size(deleted)).rejects.toMatchObject({ code: "code_db_unavailable" });
  });
});
