import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { MATH_FORMULA_FUNCTIONS } from "../formula/functions-math";
import { FormulaDecimal } from "../formula/numeric";
import { postgresTest } from "../integration-test-utils";
import { migrate } from "../migrate";
import { compileFormulaSourceToSql } from "./formula-sql-compiler";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
}, 120_000);

postgresTest("general powers retain the same 80 significant digits in both runtimes", async () => {
  const cases: Array<[string, string]> = [
    ["2", "0.5"],
    ["0.1", "0.5"],
    ["1.01", "37.5"],
    ["2", "300.5"],
    ["1.000000001", "2147483648"],
    ["1.000000001", "-2147483649"],
    ["0.00001", "199.5"],
    ["10", "-999.5"],
    ["10", "1000.5"],
    ["1.00000000000000000001", "2147483648"],
    ["-1", "2147483649"],
    ["-1", "2147483650"],
  ];
  for (let i = 1; i <= 50; i++) cases.push([String(i / 13), String(i / 7)]);
  for (const [base, exponent] of cases) {
    const compiled = compileFormulaSourceToSql(`POW('${base}', '${exponent}')`, { fields: [] });
    if (!compiled.ok) throw new Error(compiled.error);
    const [row] = await sql<Array<{ value: string }>>`SELECT trim_scale(${compiled.expression.sql})::text AS value`;
    const result = MATH_FORMULA_FUNCTIONS.POW!([base, exponent], {});
    expect(String(result) === row?.value, `${base} ^ ${exponent}`).toBe(true);
  }
});

postgresTest("integer powers match numeric SQL without losing large integer digits", async () => {
  const cases: Array<[string, string]> = [
    ["2", "300"],
    ["1.01", "37"],
    ["1.01000000000000000000", "37.00000000000000000000"],
    ["0", "0"],
    ["0", "2"],
    ["-2", "3"],
    ["-2", "4"],
    ["2", "-3"],
    ["10", "1000"],
    ["0.1", "1001"],
    ["1e-1001", "1"],
    ["5e-1001", "1"],
    ["1e80", "2"],
    ["9999", "2"],
    ["10000", "2"],
    ["10001", "2"],
    ["1", "2147483647"],
    ["-1", "-2147483648"],
  ];
  for (let i = 1; i <= 100; i++) cases.push([String(i / 13), String((i % 31) - 15)]);
  for (const [base, exponent] of cases) {
    const input = base.includes("e") ? new FormulaDecimal(base).toFixed() : base;
    const expression = `POW('${input}', '${exponent}')`;
    const compiled = compileFormulaSourceToSql(expression, { fields: [] });
    if (!compiled.ok) throw new Error(compiled.error);
    const [row] = await sql<Array<{ value: string }>>`SELECT trim_scale(${compiled.expression.sql})::text AS value`;
    const result = MATH_FORMULA_FUNCTIONS.POW!([input, exponent], {});
    expect(String(result) === row?.value, `${base} ^ ${exponent}`).toBe(true);
  }
});
