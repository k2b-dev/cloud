import { expect } from "bun:test";
import { sql } from "bun";
import { FormulaDecimal, sqrtDecimal } from "../formula/numeric";
import { isFormulaError } from "../formula/types";
import { postgresTest } from "../integration-test-utils";
import { compileFormulaSourceToSql } from "./formula-sql-compiler";

postgresTest("square roots match PostgreSQL across scales and rounding boundaries", async () => {
  const values = [
    "0",
    "-0",
    "2",
    "2.00000000000000000000",
    "4",
    "0.04",
    "9999",
    "10000",
    "10001",
    "1e80",
    "2e-1001",
    "25e-2002",
    "24.999999999999999e-2002",
  ];
  for (let i = 1; i <= 100; i++) values.push(`${i * 7919 + 11}e${(i % 31) - 15}`);
  const rows = await sql<Array<{ value: string; root: string }>>`
    SELECT value, trim_scale(sqrt(trim_scale(value::numeric)))::text AS root
    FROM jsonb_array_elements_text(${{ values }}::jsonb->'values') input(value)`;
  expect(rows).toHaveLength(values.length);
  for (const row of rows) {
    const result = sqrtDecimal(new FormulaDecimal(row.value));
    if (isFormulaError(result)) throw new Error(`${row.value}: ${result.code}`);
    expect(result.toFixed() === row.root, row.value).toBe(true);
  }
  const compiled = compileFormulaSourceToSql("SQRT('2.00000000000000000000')", { fields: [] });
  if (!compiled.ok) throw new Error(compiled.error);
  const [row] = await sql<Array<{ value: string }>>`SELECT trim_scale(${compiled.expression.sql})::text AS value`;
  expect(row?.value).toBe("1.414213562373095");
});
