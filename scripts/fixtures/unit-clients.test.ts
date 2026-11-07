import { expect, spyOn, test } from "bun:test";
import { redis, sql } from "../../packages/cloud/src/runtime/clients";
import { useUnitClients } from "./unit-clients";

useUnitClients();
let previousSql: typeof sql | undefined;
test("unit client fixtures expose native options and intercept queries without connecting", async () => {
  previousSql = sql;
  expect(sql.options.hostname).toBe("127.0.0.1");
  expect(sql.options.port).toBe(1);
  const database = spyOn(sql, "unsafe").mockResolvedValue([{ answer: 42 }]);
  const cache = spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
  try {
    expect(await sql.unsafe("SELECT 42 AS answer")).toEqual([{ answer: 42 }]);
    expect(await redis.send("EVAL", ["fixture"])).toEqual([1, 0, "1"]);
  } finally {
    database.mockRestore();
    cache.mockRestore();
  }
});

test("each test gets a fresh fixture", () => {
  expect(redis.connected).toBe(false);
  expect(sql).not.toBe(previousSql);
});
