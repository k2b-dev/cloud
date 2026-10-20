import { describe, expect, test } from "bun:test";
import {
  bindSqlValue,
  prepareSql,
  SQL_MAX_BYTES,
  SQL_PARAMETER_MAX_BYTES,
  SqlInputError,
  scanSql,
  sqlParameterNames,
  validateSqlInput,
} from "./sql-params";

const refused = (sql: string, code: SqlInputError["code"], params: Record<string, string> = {}) => {
  try {
    validateSqlInput(sql, params);
    throw new Error("Expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(SqlInputError);
    expect((error as SqlInputError).code).toBe(code);
  }
};
describe("SQL lexical contract", () => {
  test("strings, comments, quoted identifiers, casts and adjacency", () => {
    const source = "SELECT '-- :no', 'it\\'s :no', 'it''s :no', \"--:no\", `:no`, x::String, :a:b, a:b, ::x, :A, :a /* :u */ -- :v\n, :z";
    expect(sqlParameterNames(source)).toEqual(["a", "A", "z"]);
    for (const token of scanSql(source)) expect(source.slice(token.start, token.end)).toBe(token.text);
  });
  test("line comments end only at LF and FORMAT functions remain usable", () => {
    expect(sqlParameterNames("SELECT 1 -- :hidden\r :also_hidden\n, :visible")).toEqual(["visible"]);
    expect(validateSqlInput("SELECT format('{}', 1)").sql).toBe("SELECT format('{}', 1)");
    refused("SELECT 1 FORMAT JSON", "SQL_ERROR");
  });
  test("local date-times bind in the base timezone", () => {
    expect(bindSqlValue("2026-10-20T12:34:56.123", "Europe/Berlin")).toEqual({
      type: "DateTime64(3, 'Europe/Berlin')",
      value: "2026-10-20 12:34:56.123",
    });
    expect(bindSqlValue("2026-10-20 12:34:56", "Europe/Berlin")).toEqual({
      type: "DateTime64(3, 'Europe/Berlin')",
      value: "2026-10-20 12:34:56",
    });
  });
  test("one trailing semicolon is stripped, balanced UNION is allowed", () => {
    expect(validateSqlInput("SELECT 1; -- end").sql).toBe("SELECT 1 -- end");
    expect(validateSqlInput("(SELECT 1 UNION ALL SELECT 2)").sql).toBe("(SELECT 1 UNION ALL SELECT 2)");
  });
  test.each([
    "SELECT 'x",
    'SELECT "x',
    "SELECT `x",
    "SELECT 1 /*",
    "SELECT 1) /*",
    "SELECT 1) UNION ALL SELECT 2 --",
    "SELECT (1",
    "SELECT 1; SELECT 2",
    "SELECT 1;;",
    "SELECT 1 FORMAT JSON",
    "SELECT 1 SETTINGS max_threads=1",
    "SELECT 1 INTO /*gap*/ OUTFILE 'x'",
    "INSERT INTO x SELECT 1",
    "ALTER TABLE x DELETE WHERE 1",
    "SYSTEM DROP QUERY CACHE",
    "SELECT {x:String}",
  ])("refuses wrapper escape: %s", (source) => refused(source, "SQL_ERROR"));
  test.each(["SELECT 1 # (\n) UNION ALL SELECT 2 FROM (SELECT 1 # )\n", "SELECT $x$( $x$ AS t\n) UNION ALL SELECT 2 FROM (SELECT $x$)$x$"])(
    "rejects ClickHouse lexical forms outside the shared grammar: %s",
    (source) => refused(source, "SQL_ERROR"),
  );
  test("failure position points at user source", () => {
    try {
      validateSqlInput("-- lead\nSELECT\n  :missing");
    } catch (error) {
      expect(error).toMatchObject({ code: "PARAMETER_MISSING", line: 3, column: 3 });
    }
    try {
      validateSqlInput("SELECT 1\n)");
    } catch (error) {
      expect(error).toMatchObject({ code: "SQL_ERROR", line: 2, column: 1 });
    }
  });
  test("byte boundary and parameter counts apply before execution", () => {
    const exact = `SELECT '${"é".repeat((SQL_MAX_BYTES - 10) / 2)}' `;
    expect(new TextEncoder().encode(exact).length).toBe(SQL_MAX_BYTES);
    expect(validateSqlInput(exact).sql).toBe(exact);
    refused(exact + " ", "INPUT_TOO_LARGE");
    const params = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, "x"]));
    refused(
      `SELECT ${Object.keys(params)
        .map((k) => `:${k}`)
        .join(",")}`,
      "INPUT_TOO_LARGE",
      params,
    );
    expect(validateSqlInput("SELECT :v", { v: "x".repeat(SQL_PARAMETER_MAX_BYTES) }).names).toEqual(["v"]);
    refused("SELECT :v", "INPUT_TOO_LARGE", { v: "x".repeat(SQL_PARAMETER_MAX_BYTES + 1) });
  });
  test("missing, unused and reserved caller values are refused", () => {
    refused("SELECT :x", "PARAMETER_MISSING");
    refused("SELECT 1", "SQL_ERROR", { x: "1" });
    refused("SELECT :base_tz", "SQL_ERROR", { base_tz: "UTC" });
    expect(prepareSql("SELECT :base_tz", {}, "Europe/Berlin")).toEqual({
      sql: "SELECT {base_tz:String}",
      params: { base_tz: "Europe/Berlin" },
    });
  });
  test("typed binding and rewrite keep malicious values as data", () => {
    expect(bindSqlValue("2026-10-20", "Europe/Berlin")).toEqual({
      type: "DateTime64(3, 'Europe/Berlin')",
      value: "2026-10-20 00:00:00.000",
    });
    expect(bindSqlValue("2026-10-20T10:00:00Z", "UTC")).toEqual(bindSqlValue("2026-10-20T12:00:00+02:00", "UTC"));
    for (const [value, seconds] of [
      ["30s", 30],
      ["5m", 300],
      ["1h", 3600],
      ["1d", 86400],
      ["2w", 1209600],
    ] as const)
      expect(bindSqlValue(value, "UTC")).toEqual({ type: "UInt32", value: String(seconds) });
    expect(bindSqlValue("-1.5e2", "UTC")).toEqual({ type: "Float64", value: "-150" });
    expect(bindSqlValue("Infinity", "UTC").type).toBe("String");
    const attack = "'); DROP TABLE x; --";
    expect(prepareSql("SELECT :v, ':v'", { v: attack })).toEqual({ sql: "SELECT {v:String}, ':v'", params: { v: attack } });
  });
});
