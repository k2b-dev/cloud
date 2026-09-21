import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { validateObjectList } from "../field-types/object-list";
import { FORMULA_LIMITS } from "../formula/parser";
import { postgresTest } from "../integration-test-utils";
import { migrate } from "../migrate";
import { normalizedSqlParts } from "../sql-test-utils";
import { applyComputedProjections, buildComputedColumnSqlProjections } from "./computed-projections";
import { compileFormulaAstToSql, compileFormulaSourceToSql } from "./formula-sql-compiler";
import { compileObjectListRow, compileObjectListValue } from "./object-list-sql";
import type { Field, GridRecord } from "./types";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

const rowPlan = (fields: unknown[]) =>
  compileObjectListRow({ fields }, "item", (ast, resolveField) =>
    compileFormulaAstToSql(ast, { fields: [], recordAlias: "item", resolveField }),
  );

describe("object-list SQL calculation", () => {
  postgresTest("collects list values and errors in one value pass without dropping invalid rows", async () => {
    const field = {
      id: "Items1",
      config: {
        fields: [
          { id: "Amount", name: "Amount", type: "number", required: true },
          { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount / 2" } },
        ],
      },
    };
    const compiled = compileObjectListValue(field, "r", (ast, resolveField, recordAlias) =>
      compileFormulaAstToSql(ast, { fields: [], resolveField, recordAlias }),
    );
    if (!compiled.ok) throw new Error(compiled.error);
    const valueQuery = normalizedSqlParts(sql`SELECT ${compiled.expression.sql}`);
    expect(valueQuery.text.match(/jsonb_array_elements\(/g)).toHaveLength(1);
    for (const invalid of [false, true]) {
      const values = [{ Amount: "2" }, { Amount: invalid ? "not-a-number" : "4" }];
      const [result] = await sql`SELECT ${compiled.expression.sql} AS value, ${compiled.expression.errorSql} AS error
        FROM (SELECT ${{ Items1: values }}::jsonb AS data, NULL::timestamptz AS finalized_at) r`;
      expect(result.error).toBe(invalid);
      expect(result.value).toEqual(
        invalid
          ? null
          : [
              { Amount: "2", Total1: "1" },
              { Amount: "4", Total1: "2" },
            ],
      );
    }
  });
  test("stages select normalization once for value and cardinality checks", () => {
    const compiled = rowPlan([
      {
        id: "Choice",
        name: "Choice",
        type: "select",
        required: true,
        config: {
          multiple: true,
          minSelected: 1,
          maxSelected: 2,
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      },
    ]);
    if (!compiled.ok) throw new Error(compiled.error);
    const query = normalizedSqlParts(sql`SELECT ${compiled.plan.json}, ${compiled.plan.errorSql}
      FROM (SELECT '{}'::jsonb AS data) item ${compiled.plan.joins}`);
    expect(query.text.match(/jsonb_agg\(/g)).toHaveLength(1);
  });
  postgresTest("preserves nullable calculated date types through staging", async () => {
    for (const includeTime of [false, true]) {
      const fields = [
        {
          id: "Result",
          name: "Result",
          type: "date",
          config: {
            includeTime,
            min: includeTime ? "2026-01-01T00:00:00Z" : "2026-01-01",
            max: includeTime ? "2026-12-31T00:00:00Z" : "2026-12-31",
          },
          formula: { expression: "NULL" },
        },
      ];
      expect(validateObjectList([{}], { fields }, false)).toEqual({ ok: true, value: [{ Result: null }] });
      const compiled = rowPlan(fields);
      if (!compiled.ok) throw new Error(compiled.error);
      const [row] = await sql<
        Array<{ value: unknown; error: boolean }>
      >`SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
        FROM (SELECT '{}'::jsonb AS data) item ${compiled.plan.joins}`;
      expect(row).toEqual({ value: { Result: null }, error: false });
    }
  });
  postgresTest("preserves calculated scalar nulls and rejects required nulls in both runtimes", async () => {
    for (const type of ["number", "boolean", "text"] as const) {
      for (const required of [false, true]) {
        const fields = [{ id: "Result", name: "Result", type, required, config: {}, formula: { expression: "NULL" } }];
        const checked = validateObjectList([{}], { fields }, false);
        expect(checked.ok).toBe(!required);
        if (checked.ok) expect(checked.value).toEqual([{ Result: null }]);
        const compiled = rowPlan(fields);
        if (!compiled.ok) throw new Error(compiled.error);
        const [row] = await sql<Array<{ value: unknown; error: boolean }>>`
          SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
          FROM (SELECT '{}'::jsonb AS data) item ${compiled.plan.joins}`;
        expect(row).toEqual({ value: { Result: null }, error: required });
      }
    }
  });
  postgresTest("matches select membership, cardinality and normalization after schema changes", async () => {
    for (const required of [false, true]) {
      for (const multiple of [false, true]) {
        const fields = [
          {
            id: "Choice",
            name: "Choice",
            type: "select",
            required,
            config: {
              multiple,
              options: [
                { id: "a", label: "A" },
                { id: "b", label: "B" },
              ],
              minSelected: 1,
              maxSelected: multiple ? 2 : 1,
            },
          },
        ];
        const compiled = rowPlan(fields);
        if (!compiled.ok) throw new Error(compiled.error);
        for (const value of [null, "", [], [""], ["a"], ["b", "a", "b", ""], ["removed"], [null], [1], "a"]) {
          const expected = validateObjectList([{ Choice: value }], { fields }, false, { stored: true });
          const [row] = await sql<
            Array<{ value: unknown; error: boolean }>
          >`SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
            FROM (SELECT ${{ Choice: value }}::jsonb AS data) item ${compiled.plan.joins}`;
          expect(row?.error).toBe(!expected.ok);
          if (expected.ok) expect(row?.value).toEqual(expected.value?.[0]);
        }
      }
    }
  });

  postgresTest("rechecks tightened numeric input constraints through the shared scalar checks", async () => {
    const fields = [{ id: "Amount", name: "Amount", type: "number", required: true, config: { min: "1", max: "10", decimalPlaces: 2 } }];
    const compiled = rowPlan(fields);
    if (!compiled.ok) throw new Error(compiled.error);
    for (const value of [null, "0.99", "10.01", "1.001", "1.25", "not a number", "NaN", "Infinity", true, {}]) {
      const expected = validateObjectList([{ Amount: value }], { fields }, false, { stored: true });
      const [row] = await sql<Array<{ error: boolean }>>`SELECT ${compiled.plan.errorSql} AS error
        FROM (SELECT ${{ Amount: value }}::jsonb AS data) item ${compiled.plan.joins}`;
      expect(row?.error).toBe(!expected.ok);
    }
  });

  postgresTest("reports invalid list containers and cardinality without throwing or changing frozen lists", async () => {
    const config = { fields: [{ id: "Amount", name: "Amount", type: "number", config: {} }], minItems: 1, maxItems: 2 };
    const compiled = compileObjectListValue({ id: "Items1", config }, "r", (ast, resolveField, recordAlias) =>
      compileFormulaAstToSql(ast, { fields: [], recordAlias, resolveField }),
    );
    if (!compiled.ok) throw new Error(compiled.error);
    for (const [value, expected] of [
      [null, true],
      [[], true],
      ["invalid", true],
      [[null], true],
      [[{}], false],
      [[{}, {}, {}], true],
    ] as const) {
      const [row] = await sql<Array<{ error: boolean }>>`SELECT ${compiled.expression.errorSql} AS error
        FROM (SELECT ${{ Items1: value }}::jsonb AS data, NULL::timestamptz AS finalized_at) r`;
      expect(row?.error).toBe(expected);
    }
    const original = [{ Amount: "1" }, { Amount: "2" }, { Amount: "3" }];
    const [frozen] = await sql<
      Array<{ value: unknown; error: boolean }>
    >`SELECT ${compiled.expression.sql} AS value, ${compiled.expression.errorSql} AS error
      FROM (SELECT ${{ Items1: original }}::jsonb AS data, now() AS finalized_at) r`;
    expect(frozen).toEqual({ value: original, error: false });
  });

  postgresTest("rounds calculated percentages identically in JavaScript and PostgreSQL", async () => {
    for (const [expression, expected] of [
      ["1.075", 1.08],
      ["2.675", 2.68],
      ["0.125", 0.13],
    ] as const) {
      const fields = [{ id: "Result", name: "Result", type: "percent", config: { decimals: 2 }, formula: { expression } }];
      expect(validateObjectList([{}], { fields }, false)).toEqual({ ok: true, value: [{ Result: expected }] });
      const compiled = rowPlan(fields);
      if (!compiled.ok) throw new Error(compiled.error);
      const [row] = await sql<Array<{ value: unknown; error: boolean }>>`
        SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
        FROM (SELECT '{}'::jsonb AS data) item ${compiled.plan.joins}`;
      expect(row).toEqual({ value: { Result: expected }, error: false });
    }
  });
  postgresTest("uses the same canonical decimal division scale in JS and SQL", async () => {
    for (const [expression, expected] of [
      ["1 / 3", "0.33333333333333333333"],
      ["1.000000000000000000000000000000 / 3", "0.33333333333333333333"],
      ["AVG(1, 0, 0)", "0.33333333333333333333"],
      ["ROUND(1, 40) / 3", "0.33333333333333333333"],
      [`(${"1" + "0".repeat(80)} + 2) / 2 - ${"5" + "0".repeat(79)}`, "1"],
    ]) {
      const fields = [{ id: "Result", name: "Result", type: "number", formula: { expression } }];
      expect(validateObjectList([{}], { fields }, false)).toEqual({ ok: true, value: [{ Result: expected }] });
      const compiled = rowPlan(fields);
      if (!compiled.ok) throw new Error(compiled.error);
      const [row] = await sql<Array<{ value: unknown; error: boolean }>>`
        SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
        FROM (SELECT '{}'::jsonb AS data) item ${compiled.plan.joins}`;
      expect(row).toEqual({ value: { Result: expected }, error: false });
    }
  });
  postgresTest("matches scalar text trimming and UTF-16 length constraints", async () => {
    for (const [text, maxLength, expected] of [
      ["\t\u00a0hello\u2003\n", 5, "hello"],
      ["\ufeff😀\u2029", 2, "😀"],
      ["😀", 1, null],
    ] as const) {
      const fields = [
        { id: "Source", name: "Source", type: "longtext" },
        { id: "Result", name: "Result", type: "text", config: { maxLength }, formula: { expression: "Source" } },
      ];
      const input = { Source: text };
      const checked = validateObjectList([input], { fields }, false);
      expect(checked.ok).toBe(expected !== null);
      const compiled = rowPlan(fields);
      if (!compiled.ok) throw new Error(compiled.error);
      const [row] = await sql<Array<{ value: unknown; error: boolean }>>`
        SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
        FROM (SELECT ${input}::jsonb AS data) item ${compiled.plan.joins}`;
      expect(row!.error).toBe(expected === null);
      if (expected !== null) expect(row!.value).toEqual({ ...input, Result: expected });
    }
  });
  postgresTest("uses only the scalar owner's supported calculation constraints", async () => {
    const fields = [
      {
        id: "Period",
        name: "Period",
        type: "duration",
        config: { min: 500, unit: "hours" },
        formula: { expression: "60" },
      },
    ];
    expect(validateObjectList([{}], { fields }, false)).toEqual({ ok: true, value: [{ Period: 60 }] });
    const compiled = rowPlan(fields);
    if (!compiled.ok) throw new Error(compiled.error);
    const [row] = await sql<Array<{ value: unknown; error: boolean }>>`
      SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
      FROM (SELECT '{}'::jsonb AS data) item ${compiled.plan.joins}`;
    expect(row).toEqual({ value: { Period: 60 }, error: false });
  });
  postgresTest("preserves long finite calculations and cancellation in both runtimes", async () => {
    const amount = `1${"0".repeat(80)}`;
    const input = { Amount: amount };
    for (const [expression, expected] of [
      ["Amount + 1 - Amount", "1"],
      ["SUM(Amount, 1) - Amount", "1"],
      ["Amount * (Amount + 1) - Amount * Amount", amount],
      ["MOD(Amount + 1, Amount)", "1"],
      ["AVG(Amount, Amount + 2) - Amount", "1"],
      ["MEDIAN(Amount, Amount + 2) - Amount", "1"],
      ["ROUND(Amount + 149, -2) - Amount", "100"],
      ["ROUND(Amount + 150, -2) - Amount", "200"],
      ["ROUND(-Amount - 149, -2) + Amount", "-100"],
      ["ROUND(-Amount - 150, -2) + Amount", "-200"],
      [`POW(2, 300) - ${2n ** 300n - 1n}`, "1"],
      ["POW(1.01, 37)", "1.4450764714274963"],
    ]) {
      const fields = [
        { id: "Amount", name: "Amount", type: "number" },
        { id: "Result", name: "Result", type: "number", formula: { expression } },
      ];
      expect(validateObjectList([input], { fields }, false)).toEqual({ ok: true, value: [{ ...input, Result: expected }] });
      const compiled = rowPlan(fields);
      if (!compiled.ok) throw new Error(compiled.error);
      const [row] = await sql<Array<{ value: unknown; error: boolean }>>`
        SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
        FROM (SELECT ${input}::jsonb AS data) item ${compiled.plan.joins}`;
      expect(row).toEqual({ value: { ...input, Result: expected }, error: false });
    }
  });
  postgresTest("shares rounding-scale semantics and rejects out-of-range scales without SQL exceptions", async () => {
    for (const [expression, expected] of [
      ["ROUND(125, -1.9)", "130"],
      ["ROUND(1.25, 1.9)", "1.3"],
      ["ROUND(1, -131072)", "0"],
      ["ROUND(1, 16383)", "1"],
      ["IFERROR(ROUND(1, 2147483648), 42)", "42"],
      ["IFERROR(ROUND(1, -131073), 42)", "42"],
      ["IFERROR(ROUND(1, 16384), 42)", "42"],
    ]) {
      const fields = [{ id: "Result", name: "Result", type: "number", formula: { expression } }];
      expect(validateObjectList([{}], { fields }, false)).toEqual({ ok: true, value: [{ Result: expected }] });
      const compiled = rowPlan(fields);
      if (!compiled.ok) throw new Error(compiled.error);
      const [row] = await sql<Array<{ value: unknown; error: boolean }>>`
        SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
        FROM (SELECT '{}'::jsonb AS data) item ${compiled.plan.joins}`;
      expect(row).toEqual({ value: { Result: expected }, error: false });
    }
  });
  postgresTest("turns undefined real powers into recoverable formula errors in both runtimes", async () => {
    for (const expression of ["POW(-1, 0.5)", "POW(0, -1)", "POW(2, 2147483647)", "POW(10, 1000000.5)"]) {
      const fields = [{ id: "Result", name: "Result", type: "number", formula: { expression } }];
      expect(validateObjectList([{}], { fields }, false).ok).toBe(false);
      const compiled = rowPlan(fields);
      if (!compiled.ok) throw new Error(compiled.error);
      const [row] = await sql<Array<{ value: unknown; error: boolean }>>`
        SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
        FROM (SELECT '{}'::jsonb AS data) item ${compiled.plan.joins}`;
      expect(row).toEqual({ value: { Result: null }, error: true });
      const fallback = [{ id: "Result", name: "Result", type: "number", formula: { expression: `IFERROR(${expression}, 42)` } }];
      expect(validateObjectList([{}], { fields: fallback }, false)).toEqual({ ok: true, value: [{ Result: "42" }] });
      const recovered = rowPlan(fallback);
      if (!recovered.ok) throw new Error(recovered.error);
      const [result] = await sql<Array<{ value: unknown; error: boolean }>>`
        SELECT ${recovered.plan.json} AS value, ${recovered.plan.errorSql} AS error
        FROM (SELECT '{}'::jsonb AS data) item ${recovered.plan.joins}`;
      expect(result).toEqual({ value: { Result: "42" }, error: false });
    }
  });
  postgresTest("keeps literal-only intermediate results exact in JS and SQL", async () => {
    for (const [expression, expected] of [
      ["9007199254740992 + 1 - 9007199254740992", "1"],
      ["SUM(9007199254740992, 1)", "9007199254740993"],
      ["POW(3, 35)", "50031545098999707"],
      ["AVG(9007199254740992, 1)", "4503599627370496.5"],
    ]) {
      const fields = [{ id: "Result", name: "Result", type: "number", formula: { expression } }];
      expect(validateObjectList([{}], { fields }, false)).toEqual({ ok: true, value: [{ Result: expected }] });
      const compiled = rowPlan(fields);
      if (!compiled.ok) throw new Error(compiled.error);
      const [row] = await sql<Array<{ value: unknown; error: boolean }>>`
        SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
        FROM (SELECT '{}'::jsonb AS data) item ${compiled.plan.joins}`;
      expect(row).toEqual({ value: { Result: expected }, error: false });
    }
  });
  postgresTest("validates literal decimal arithmetic identically in JS and SQL", async () => {
    const fields = [
      {
        id: "Result",
        name: "Result",
        type: "number",
        config: { decimalPlaces: 2 },
        formula: { expression: "0.1 + 0.2" },
      },
    ];
    expect(validateObjectList([{}], { fields }, false)).toEqual({ ok: true, value: [{ Result: "0.30" }] });
    const compiled = rowPlan(fields);
    if (!compiled.ok) throw new Error(compiled.error);
    const [row] = await sql<Array<{ value: unknown; error: boolean }>>`
      SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
      FROM (SELECT '{}'::jsonb AS data) item ${compiled.plan.joins}`;
    expect(row).toEqual({ value: { Result: "0.30" }, error: false });
  });
  postgresTest("evaluates an expression at the nesting boundary identically in JS and SQL", async () => {
    const fields = [
      {
        id: "Result",
        name: "Result",
        type: "number",
        formula: { expression: Array(FORMULA_LIMITS.depth).fill("1").join("+") },
      },
    ];
    const validated = validateObjectList([{}], { fields }, false);
    expect(validated).toEqual({ ok: true, value: [{ Result: String(FORMULA_LIMITS.depth) }] });
    const compiled = rowPlan(fields);
    if (!compiled.ok) throw new Error(compiled.error);
    const [row] = await sql<Array<{ value: unknown; error: boolean }>>`
      SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
      FROM (SELECT '{}'::jsonb AS data) item ${compiled.plan.joins}`;
    expect(row).toEqual({ value: { Result: String(FORMULA_LIMITS.depth) }, error: false });
  });
  postgresTest("keeps reused calculation dependencies bounded", async () => {
    const fields: unknown[] = [{ id: "Amount", name: "Amount", type: "number" }];
    let previous = "Amount";
    for (let index = 0; index < 24; index++) {
      const id = `Calc${String(index).padStart(2, "0")}`;
      fields.push({ id, name: `Step ${index}`, type: "number", formula: { expression: `{${previous}} + {${previous}}` } });
      previous = id;
    }
    const compiled = rowPlan(fields);
    if (!compiled.ok) throw new Error(compiled.error);
    const [row] = await sql<
      Array<{ value: Record<string, unknown>; error: boolean }>
    >`SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error
      FROM (SELECT ${{ Amount: "0.1" }}::jsonb AS data) item ${compiled.plan.joins}`;
    expect(row?.error).toBe(false);
    expect(row?.value[previous]).toBe("1677721.6");
  });

  postgresTest("reduces typed list columns and preserves finalized cells", async () => {
    const field: Field = {
      id: "00000000-0000-7000-8000-000000000001",
      shortId: "Items1",
      tableId: "00000000-0000-7000-8000-000000000002",
      name: "Items",
      type: "object_list",
      config: {
        fields: [
          { id: "Amount", name: "Amount", type: "number" },
          { id: "Total1", name: "Total", type: "number", config: { decimalPlaces: 2 }, formula: { expression: "Amount * 2" } },
        ],
      },
      description: null,
      icon: null,
      position: 0,
      required: false,
      presentable: false,
      hideInTable: false,
      defaultValue: null,
      indexed: false,
      uniqueConstraint: false,
      deletedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    for (const [fn, expected] of [
      ["SUM", "0.6"],
      ["AVG", "0.3"],
      ["MIN", "0.2"],
      ["MAX", "0.4"],
    ]) {
      const compiled = compileFormulaSourceToSql(`LIST_${fn}(Items, 'Total')`, { fields: [field] });
      if (!compiled.ok) throw new Error(compiled.error);
      const [row] = await sql<
        Array<{ value: string }>
      >`SELECT trim_scale((${compiled.expression.sql})::numeric)::text AS value FROM (SELECT ${{
        [field.id]: [
          { Amount: "0.10", Total1: "99" },
          { Amount: "0.20", Total1: "99" },
        ],
      }}::jsonb AS data, NULL::timestamptz AS finalized_at) r`;
      expect(row?.value).toBe(expected);
    }
    const sum = compileFormulaSourceToSql("LIST_SUM(Items, 'Total')", { fields: [field] });
    if (!sum.ok) throw new Error(sum.error);
    const { projections } = buildComputedColumnSqlProjections(
      [{ kind: "computed", id: "computed_View01", label: "Total", expression: "LIST_SUM(Items, 'Total')" }],
      [field],
    );
    expect(projections).toHaveLength(1);
    const rows = await sql<Array<Record<string, unknown>>>`SELECT 'record_1' AS id, ${projections[0]!.fragment}
      FROM (SELECT ${{ [field.id]: "invalid" }}::jsonb AS data, NULL::timestamptz AS finalized_at) r`;
    const record: Pick<GridRecord, "data" | "fieldErrors"> = { data: {} };
    applyComputedProjections(rows, new Map([["record_1", record]]), projections);
    expect(record.data.computed_View01).toBeNull();
    expect(record.fieldErrors?.computed_View01).toContain("could not be calculated");
    for (const [expression, expected] of [
      ["IFERROR(LIST_SUM(Items, 'Total'), 42)", "42"],
      ["IF(false, LIST_SUM(Items, 'Total'), 7)", "7"],
    ]) {
      const checked = compileFormulaSourceToSql(expression!, { fields: [field] });
      if (!checked.ok) throw new Error(checked.error);
      const [row] = await sql<Array<{ value: string; error: boolean }>>`SELECT (${checked.expression.sql})::text AS value,
        COALESCE(${checked.expression.errorSql ?? sql`false`}, false) AS error
        FROM (SELECT ${{ [field.id]: "invalid" }}::jsonb AS data, NULL::timestamptz AS finalized_at) r`;
      expect(row).toEqual({ value: expected!, error: false });
    }
    for (const [value, expected] of [
      [null, null],
      [[], "0"],
      [[{ Amount: "0.10", Total1: "9007199254740993.25" }], "9007199254740993.25"],
    ] as const) {
      const [row] = await sql<
        Array<{ value: string | null }>
      >`SELECT (${sum.expression.sql})::text AS value FROM (SELECT ${{ [field.id]: value }}::jsonb AS data, now() AS finalized_at) r`;
      expect(row?.value).toBe(expected);
    }
  });

  postgresTest("matches exact row calculations and declared numeric scale", async () => {
    const fields = [
      { id: "Amount", name: "Amount", type: "number", config: { decimalPlaces: 2 } },
      { id: "Qty001", name: "Quantity", type: "number" },
      { id: "Subtot", name: "Subtotal", type: "number", config: { decimalPlaces: 2 }, formula: { expression: "Amount * Quantity" } },
      { id: "Total1", name: "Total", type: "number", config: { decimalPlaces: 2 }, formula: { expression: "ROUND(Subtotal * 1.19, 2)" } },
    ];
    const compiled = rowPlan(fields);
    if (!compiled.ok) throw new Error(compiled.error);
    for (const input of [
      { Amount: "0.10", Qty001: "3" },
      { Amount: "9007199254740993.25", Qty001: "1" },
      { Amount: "123456789012345678901234567890.12", Qty001: "1" },
    ]) {
      const validated = validateObjectList([input], { fields }, true);
      if (!validated.ok) throw new Error(validated.error);
      const [row] = await sql<Array<{ value: unknown; error: boolean }>>`
        SELECT ${compiled.plan.json} AS value, ${compiled.plan.errorSql} AS error FROM (SELECT ${input}::jsonb AS data) item ${compiled.plan.joins}
      `;
      expect(row?.error).toBe(false);
      expect(row?.value).toEqual(Array.isArray(validated.value) ? validated.value[0] : null);
    }
  });

  postgresTest("retains calculation errors and rejects invalid numeric results", async () => {
    for (const expression of ["Amount / 0", "Amount / 3", "Amount * -1", "Amount * 10000"]) {
      const compiled = rowPlan([
        { id: "Amount", name: "Amount", type: "number" },
        { id: "Total1", name: "Total", type: "number", config: { min: "0", precision: 4, decimalPlaces: 2 }, formula: { expression } },
      ]);
      if (!compiled.ok) throw new Error(compiled.error);
      const [row] = await sql<
        Array<{ error: boolean }>
      >`SELECT ${compiled.plan.errorSql} AS error FROM (SELECT ${{ Amount: "1" }}::jsonb AS data) item ${compiled.plan.joins}`;
      expect(row?.error).toBe(true);
    }
  });

  test("rejects unsafe aliases and mismatched result types before executing SQL", () => {
    expect(
      compileObjectListRow({ fields: [{ id: "Amount", name: "Amount", type: "number" }] }, "item; DROP TABLE grids.records", () => ({
        ok: false,
        error: "not called",
      })).ok,
    ).toBe(false);
    expect(rowPlan([{ id: "Amount", name: "Amount", type: "number", formula: { expression: "'not a number'" } }]).ok).toBe(false);
  });
});
