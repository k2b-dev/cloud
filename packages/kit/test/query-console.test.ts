import { test, expect } from "bun:test";
import { safeQuery } from "../src/database-sql";
import { QueryInput, QueryUpdate } from "../src/saved-queries";
import { queryResult, cellText } from "../src/frontend/query-results";
import { highlight } from "@k2b/stdlib";
test("one terminal semicolon is accepted without permitting statement chaining or hiding literal semicolons", () => {
  expect(safeQuery(" SELECT ';' AS value;  ")).toBe("SELECT * FROM (SELECT ';' AS value) LIMIT 1001");
  expect(safeQuery("SELECT 1")).toBe("SELECT * FROM (SELECT 1) LIMIT 1001");
  for (const text of ["SELECT 1;;", "SELECT 1; SELECT 2;", ";", "SELECT 1; -- hi", "DELETE FROM todos;"])
    expect(() => safeQuery(text)).toThrow();
});
test("query contracts bound names, SQL and revisions; result preserves null and JSON", () => {
  expect(QueryInput.safeParse({ name: " ", sql: "SELECT 1" }).success).toBe(false);
  expect(QueryInput.safeParse({ name: "A", sql: "x".repeat(16001) }).success).toBe(false);
  expect(QueryUpdate.safeParse({ name: "A", sql: "SELECT 1" }).success).toBe(false);
  expect(QueryInput.parse({ name: " A ", sql: " SELECT 1; " }).name).toBe("A");
  expect(queryResult.parse({ data: [{ value: null, json: { x: 1 } }] }).data).toHaveLength(1);
  expect(cellText(null)).toBe("NULL");
  expect(cellText({ x: 1 })).toBe('{"x":1}');
  expect(highlight.presets.sql("SELECT 1;")).toContain("hl-keyword");
});
