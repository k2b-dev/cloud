import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { normalizedSql } from "../sql-test-utils";
import { compileDslKeyset } from "./keyset-compiler";

describe("compileDslKeyset", () => {
  test("compiles a typed lexicographic cursor with deterministic null ordering", () => {
    const compiled = compileDslKeyset(
      [
        { expression: sql`score`, type: "numeric", direction: "desc", nullsFirst: false },
        { expression: sql`id`, type: "uuid", direction: "asc" },
      ],
      ["12.5", "11111111-1111-4111-8111-111111111111"],
    );

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(normalizedSql(compiled.orderBy)).toContain("score DESC NULLS LAST, id ASC NULLS LAST");
    const predicate = normalizedSql(compiled.where);
    expect(predicate).toContain("score <");
    expect(predicate).toContain("score IS NULL");
    expect(predicate).toContain("score IS NOT DISTINCT FROM");
    expect(compiled.valuesFromRow({ __gql_cursor_0: "9", __gql_cursor_1: "22222222-2222-4222-8222-222222222222" })).toEqual([
      "9",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  test("continues after a null only when nulls are first", () => {
    const first = compileDslKeyset([{ expression: sql`name`, type: "text", direction: "asc", nullsFirst: true }], [null]);
    expect(first.ok).toBe(true);
    if (first.ok) expect(normalizedSql(first.where)).toContain("name IS NOT NULL");

    const last = compileDslKeyset([{ expression: sql`name`, type: "text", direction: "asc", nullsFirst: false }], [null]);
    expect(last.ok).toBe(true);
    if (last.ok) expect(normalizedSql(last.where)).toContain("FALSE");
  });

  test("projects datetime cursor values without losing sub-millisecond precision", () => {
    const compiled = compileDslKeyset([{ expression: sql`created_at`, type: "datetime", direction: "asc" }], null);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(normalizedSql(compiled.select)).toContain(
      "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS __gql_cursor_0",
    );
  });

  test("rejects malformed, incomplete, and non-orderable cursor values", () => {
    expect(compileDslKeyset([{ expression: sql`id`, type: "uuid", direction: "asc" }], ["not-a-uuid"])).toEqual({
      ok: false,
      error: "cursor values do not match this query ordering",
    });
    expect(compileDslKeyset([{ expression: sql`id`, type: "uuid", direction: "asc" }], [])).toEqual({
      ok: false,
      error: "cursor values do not match this query ordering",
    });
    expect(compileDslKeyset([{ expression: sql`payload`, type: "unknown", direction: "asc" }], null)).toEqual({
      ok: false,
      error: "query sort contains a value that cannot be cursor-paginated",
    });
  });

  test("rejects invalid calendar dates and timezone-aware timestamps before SQL casting", () => {
    for (const value of ["2026-02-29", "2026-04-31", "2026-13-01", "0000-01-01"]) {
      expect(compileDslKeyset([{ expression: sql`day`, type: "date", direction: "asc" }], [value]).ok).toBe(false);
      expect(compileDslKeyset([{ expression: sql`instant`, type: "datetime", direction: "asc" }], [`${value}T00:00:00Z`]).ok).toBe(false);
    }
    for (const value of ["2026-01-01", "2026-01-01T12:00:00", "2026-01-01T25:00:00Z", "infinity"]) {
      expect(compileDslKeyset([{ expression: sql`instant`, type: "datetime", direction: "asc" }], [value]).ok).toBe(false);
    }
    expect(compileDslKeyset([{ expression: sql`day`, type: "date", direction: "asc" }], ["2024-02-29"]).ok).toBe(true);
    expect(compileDslKeyset([{ expression: sql`instant`, type: "datetime", direction: "asc" }], ["2024-02-29T12:34:56.123456Z"]).ok).toBe(
      true,
    );
  });

  test("bounds numeric cursors by PostgreSQL storage rather than JavaScript number precision", () => {
    const column = { expression: sql`amount`, type: "numeric", direction: "asc" } as const;
    for (const value of ["1e131072", "1e-16384", "0e999999999999999999", "NaN", "Infinity", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(compileDslKeyset([column], [value]).ok).toBe(false);
    }
    for (const value of ["1e131071", "1e-16383", "9007199254740993.123456789", "0.0001e131073", 42]) {
      expect(compileDslKeyset([column], [value]).ok).toBe(true);
    }
  });

  test("rejects NUL in text cursors instead of triggering a PostgreSQL text error", () => {
    expect(compileDslKeyset([{ expression: sql`title`, type: "text", direction: "asc" }], ["bad\0text"]).ok).toBe(false);
  });
});
