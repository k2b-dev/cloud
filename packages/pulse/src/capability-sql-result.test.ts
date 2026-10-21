import { expect, test } from "bun:test";
import { CAPABILITY_MAX_RESULT_BYTES } from "@k2b/cloud/contracts";
import { boundSqlCapabilityResult } from "./capability-sql-result";
import type { SqlResult } from "./service/sql-service";

// Bounds exercise the real capability adapter without requiring ClickHouse.
const fixture = (rows: unknown[][]): SqlResult => ({
  runId: "00000000-0000-4000-8000-000000000001",
  columns: rows[0]?.map((_, index) => ({ name: `column${index}`, type: "String" })) ?? [],
  rows,
  rowCount: rows.length,
  truncated: false,
  stats: { elapsedMs: 1, readRows: rows.length, readBytes: 0 },
  limits: {
    profile: "normal",
    memoryBytes: 2_000_000_000,
    timeSeconds: 10,
    maxRows: 10_000,
    maxResultBytes: 4 * 1024 * 1024,
    queriesUsed: 1,
    queriesPerHour: 600,
    resetAt: "2026-10-20T11:00:00Z",
    baseSlots: 1,
    cloudSlots: 3,
    maxWaiting: 20,
    waitMs: 5000,
  },
});

test("capability returns at most 100 whole rows", () => {
  const result = boundSqlCapabilityResult(fixture(Array.from({ length: 101 }, (_, n) => [n])), "en");
  expect(result.rows).toHaveLength(100);
  expect(result.rowCount).toBe(100);
  expect(result.truncated).toBe(true);
});
test("capability returns at most 500 numeric points", () => {
  const result = boundSqlCapabilityResult(fixture(Array.from({ length: 100 }, () => Array(6).fill(1))), "de");
  expect(result.rows).toHaveLength(83);
  expect(result.note).toContain("gekürzt");
  expect(result.truncated).toBe(true);
});
test("capability leaves space in the 256 KiB envelope", () => {
  const result = boundSqlCapabilityResult(fixture(Array.from({ length: 100 }, () => ["é".repeat(20_000)])), "en");
  expect(new TextEncoder().encode(JSON.stringify({ ok: true, data: { data: result } })).length).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
  expect(result.truncated).toBe(true);
});
test("a row too large to fit leaves a visible truncation note", () => {
  const result = boundSqlCapabilityResult(fixture([["x".repeat(CAPABILITY_MAX_RESULT_BYTES)]]), "en");
  expect(result.rows).toEqual([]);
  expect(result.truncated).toBe(true);
  expect(result.note).toBe("Result truncated.");
});
test("a complete response has no truncation note", () => {
  const result = boundSqlCapabilityResult(fixture([[1, "ok"]]), "en");
  expect(result.rows).toEqual([[1, "ok"]]);
  expect(result.truncated).toBe(false);
  expect(result.note).toBeUndefined();
});

test("numeric Int64 string values count toward the point budget", () => {
  const input = fixture(Array.from({ length: 100 }, () => Array(6).fill("1")));
  input.columns = input.columns.map((column) => ({ ...column, type: "Nullable(UInt64)" }));
  expect(boundSqlCapabilityResult(input, "en").rows).toHaveLength(83);
});
