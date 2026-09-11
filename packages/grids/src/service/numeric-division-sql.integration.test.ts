import { expect } from "bun:test";
import { sql } from "bun";
import { divideDecimals, FormulaDecimal } from "../formula/numeric";
import { isFormulaError } from "../formula/types";
import { postgresTest } from "../integration-test-utils";
import { numericAverageSql, numericDivideSql } from "./numeric-division-sql";

postgresTest("decimal division matches PostgreSQL over magnitudes, signs and rounding boundaries", async () => {
  const cases: Array<{ left: string; right: string }> = [];
  const values = [
    "0",
    "1",
    "-1",
    "3",
    "7",
    "9999",
    "10000",
    "10001",
    "0.0001",
    "0.9999999999999999999999999",
    "1e80",
    "1e-1001",
    "5e-1001",
    "-5e-1001",
    "4.999999999999999999999999e-1001",
  ];
  for (const left of values) for (const right of values.slice(1)) cases.push({ left, right });
  for (let i = 1; i <= 100; i++) cases.push({ left: `${i * 7919 + 11}e${(i % 17) - 8}`, right: `${i * 3571 + 13}e${(i % 13) - 6}` });
  const rows = await sql<Array<{ index: number; value: string }>>`
    SELECT position::int AS index, trim_scale(${numericDivideSql(sql`data->>'left'`, sql`data->>'right'`)})::text AS value
    FROM jsonb_array_elements(${{ rows: cases }}::jsonb->'rows') WITH ORDINALITY input(data, position)`;
  expect(rows.length).toBe(cases.length);
  for (const row of rows) {
    const pair = cases[row.index - 1]!;
    const expected = divideDecimals(new FormulaDecimal(pair.left), new FormulaDecimal(pair.right));
    if (isFormulaError(expected)) throw new Error(`${pair.left}/${pair.right}: ${expected.code}`);
    expect(row.value === expected.toFixed(), `${pair.left}/${pair.right}`).toBe(true);
  }
});

postgresTest("averages ignore presentation scale and preserve empty/null semantics", async () => {
  for (const [values, expected] of [
    [[], null],
    [[null, null], null],
    [["0.000000000000000000000000000001", "0.999999999999999999999999999999", "0", null], "0.33333333333333333333"],
  ] as const) {
    const [row] = await sql<Array<{ value: string | null }>>`
      SELECT trim_scale(${numericAverageSql(sql`v::numeric`)})::text AS value
      FROM jsonb_array_elements_text(${{ rows: values }}::jsonb->'rows') input(v)`;
    expect(row?.value).toBe(expected);
  }
});
