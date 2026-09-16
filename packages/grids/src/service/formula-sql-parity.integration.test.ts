import { beforeAll, describe, expect, test } from "bun:test";
import type { DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import { evaluate } from "../formula/evaluator";
import { parseFormula } from "../formula/parser";
import { isFormulaError } from "../formula/types";
import { migrate } from "../migrate";
import { normalizeRefKey } from "../ref-syntax";
import { normalizedSqlParts } from "../sql-test-utils";
import { compileFormulaSourceToSql, type FormulaSqlType } from "./formula-sql-compiler";
import { requireValidCalculationSql } from "./formula-sql-values";
import type { Field } from "./types";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

const normalize = (value: unknown, type: FormulaSqlType): unknown => {
  if (value === null || value === undefined) return null;
  if (type === "numeric") return Number(value);
  if (type === "date") return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  if (type === "datetime") return new Date(value as string | number | Date).toISOString();
  if (type === "boolean") return Boolean(value);
  return String(value);
};

const formulaField = (id: string, name: string, type: Field["type"], config: Field["config"] = {}): Field => ({
  id,
  shortId: name,
  tableId: "formula_parity",
  name,
  description: null,
  icon: null,
  type,
  config,
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
});

postgresTest("list reductions reuse prepared cells and preserve their error and null semantics", async () => {
  const items = formulaField("prepared-list", "Items1", "object_list", {
    fields: [{ id: "Total1", name: "Total", type: "number", formula: { expression: "1 / 0" } }],
  });
  for (const sample of [
    { value: [{ Total1: "0.1" }, { Total1: "0.2" }], error: false, count: "2", sum: "0.3" },
    { value: [], error: false, count: "0", sum: "0" },
    { value: null, error: false, count: null, sum: null },
    { value: sql`'null'::jsonb`, error: false, count: null, sum: null },
    { value: [{ Total1: "0.1" }], error: true, count: null, sum: null },
  ]) {
    for (const [source, expected] of [
      ["LIST_COUNT(Items1)", sample.count],
      ["LIST_SUM(Items1, 'Total1')", sample.sum],
    ] as const) {
      const compiled = compileFormulaSourceToSql(source, {
        fields: [items],
        computedFieldSql: new Map([
          [items.id, { type: "unknown", sql: sql`${sample.value}::jsonb`, errorSql: sql`${sample.error}::boolean` }],
        ]),
      });
      if (!compiled.ok) throw new Error(compiled.error);
      const [row] = await sql<Array<{ value: string | null; error: boolean }>>`
        SELECT (${compiled.expression.sql})::text AS value, ${compiled.expression.errorSql} AS error
        FROM (SELECT ${{ [items.id]: [{}] }}::jsonb AS data, NULL::timestamptz AS finalized_at) r`;
      expect(row).toEqual({ value: expected, error: sample.error });
      // The sole LIST_SUM scan consumes prepared values; no live cell plan is rebuilt.
      const text = normalizedSqlParts(sql`SELECT ${compiled.expression.sql}`).text;
      expect(text.match(/jsonb_array_elements\(/g) ?? []).toHaveLength(source.startsWith("LIST_COUNT") ? 0 : 1);
    }
  }
});

postgresTest("unused list reductions do not demand a failing prepared list", async () => {
  const items = formulaField("prepared-list", "Items1", "object_list", {
    fields: [{ id: "Total1", name: "Total", type: "number" }],
  });
  for (const source of ["IF(false, LIST_SUM(Items1, 'Total1'), 17)", "IFERROR(17, LIST_COUNT(Items1))"]) {
    const compiled = compileFormulaSourceToSql(source, {
      fields: [items],
      computedFieldSql: new Map([
        [
          items.id,
          {
            type: "unknown",
            sql: sql`jsonb_build_array(jsonb_build_object('Total1', 1 / (r.data->>'zero')::numeric))`,
            errorSql: sql`false`,
          },
        ],
      ]),
    });
    if (!compiled.ok) throw new Error(compiled.error);
    const [row] = await sql<Array<{ value: string; error: boolean }>>`
      SELECT (${compiled.expression.sql})::text AS value, COALESCE(${compiled.expression.errorSql}, false) AS error
      FROM (SELECT ${{ zero: "0", [items.id]: [] }}::jsonb AS data, NULL::timestamptz AS finalized_at OFFSET 0) r`;
    expect(row).toEqual({ value: "17", error: false });
  }
});

const expectParity = async (
  source: string,
  options: { dateConfig?: DateContext; fields?: Field[]; now?: Date; values?: Record<string, unknown> } = {},
): Promise<void> => {
  const parsed = parseFormula(source);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const slugToId = Object.fromEntries(
    (options.fields ?? []).flatMap((field) => [
      [field.shortId, field.id],
      [normalizeRefKey(field.shortId), field.id],
      [normalizeRefKey(field.name), field.id],
    ]),
  );
  const evaluated = evaluate(parsed.ast, {
    fields: options.values ?? {},
    slugToId,
    dateConfig: options.dateConfig,
    now: options.now,
    selectFields: Object.fromEntries((options.fields ?? []).filter((field) => field.type === "select").map((field) => [field.id, field])),
  });
  const compiled = compileFormulaSourceToSql(source, {
    fields: options.fields ?? [],
    dateConfig: options.dateConfig,
    now: options.now,
  });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  const errorSql = compiled.expression.errorSql ?? sql`false`;
  const [row] = options.fields
    ? await sql<Array<{ error: boolean; value: unknown }>>`
        SELECT ${compiled.expression.sql} AS value, ${errorSql} AS error
        FROM (SELECT ${options.values ?? {}}::jsonb AS data) r
      `
    : await sql<Array<{ error: boolean; value: unknown }>>`SELECT ${compiled.expression.sql} AS value, ${errorSql} AS error`;
  expect(Boolean(row?.error)).toBe(isFormulaError(evaluated));
  if (isFormulaError(evaluated)) {
    expect(row?.value).toBeNull();
    return;
  }
  expect(normalize(row?.value, compiled.expression.type)).toEqual(normalize(evaluated, compiled.expression.type));
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("formula evaluator and PostgreSQL parity", () => {
  postgresTest("eager local arithmetic reports numeric overflow and IFERROR handles it", async () => {
    const amount = formulaField("numeric-overflow", "Amount", "number");
    const largest = "9".repeat(131072);
    const median = compileFormulaSourceToSql("MEDIAN(Amount)", { fields: [amount] });
    if (!median.ok) throw new Error(median.error);
    const [single] = await sql`SELECT (${requireValidCalculationSql(median.expression)})::text AS value
      FROM (SELECT ${{ [amount.id]: largest }}::jsonb AS data OFFSET 0) r`;
    expect(single?.value).toBe(largest);
    for (const [source, value] of [
      ["Amount + Amount", largest],
      ["Amount - -Amount", largest],
      ["Amount * 2", largest],
      ["Amount / 0.1", largest],
      ["SUM(Amount, Amount)", largest],
      ["AVG(Amount, Amount)", largest],
      ["MEDIAN(Amount, Amount)", largest],
      ["PERCENT(Amount, 1)", largest],
      ["ROUND(Amount, 0)", `${largest}.9`],
      ["CEIL(Amount)", `${largest}.9`],
      ["FLOOR(Amount)", `-${largest}.9`],
    ] as const) {
      const compiled = compileFormulaSourceToSql(source, { fields: [amount] });
      if (!compiled.ok) throw new Error(compiled.error);
      const [row] = await sql`SELECT calculation.* FROM (SELECT ${{ [amount.id]: value }}::jsonb AS data OFFSET 0) r
        CROSS JOIN LATERAL (${compiled.expression.rowSql}) calculation`;
      expect(row, source).toMatchObject({ value: null, error: true });
      const recovered = compileFormulaSourceToSql(`IFERROR(${source}, 17)`, { fields: [amount] });
      if (!recovered.ok) throw new Error(recovered.error);
      const [handled] = await sql`SELECT ${requireValidCalculationSql(recovered.expression)} AS value
        FROM (SELECT ${{ [amount.id]: value }}::jsonb AS data OFFSET 0) r`;
      expect(Number(handled?.value), source).toBe(17);
    }
  });
  postgresTest("text offsets saturate before integer conversion even when evaluated eagerly", async () => {
    for (const value of ["999999999999", "-999999999999", "2147483647", "2147483648", "1.9", null]) {
      const amount = formulaField("text-offset", "Amount", "number");
      for (const source of [
        "LEFT('abc', Amount)",
        "RIGHT('abc', Amount)",
        "SUBSTRING('abc', Amount, 2)",
        "SUBSTRING('abc', 1, Amount)",
        "SUBSTRING('abc', Amount, Amount)",
      ])
        await expectParity(source, { fields: [amount], values: { [amount.id]: value } });
    }
  });
  postgresTest("query boundaries evaluate fallible formula value and error together once", async () => {
    await sql.begin(async (tx) => {
      await tx`CREATE TEMP SEQUENCE formula_evaluation_count`;
      try {
        const prepared = compileFormulaSourceToSql("Counter / 2", {
          fields: [],
          resolveField: () => ({ type: "numeric", sql: sql`nextval('formula_evaluation_count')::numeric` }),
        });
        if (!prepared.ok) throw new Error(prepared.error);
        for (const source of ["Counter", "Counter + Counter"]) {
          await tx`ALTER SEQUENCE formula_evaluation_count RESTART WITH 1`;
          const compiled = compileFormulaSourceToSql(source, { fields: [], resolveField: () => prepared.expression });
          if (!compiled.ok) throw new Error(compiled.error);
          const [row] = await tx`SELECT ${requireValidCalculationSql(compiled.expression)} AS value`;
          expect(Number(row?.value)).toBe(source === "Counter" ? 0.5 : 1);
          const [count] = await tx`SELECT currval('formula_evaluation_count')::integer AS value`;
          expect(count?.value).toBe(1);
        }
      } finally {
        await tx`DROP SEQUENCE formula_evaluation_count`;
      }
    });
  });

  postgresTest("paired query boundaries preserve errors, exact decimals and lazy prepared branches", async () => {
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL plan_cache_mode = ${mode}`);
        const bad = compileFormulaSourceToSql("Bad", {
          fields: [formulaField("prepared-bad", "Bad", "formula", { expression: "LEFT('x', 999999999999)" })],
          useFinalizedFormulaValues: false,
        });
        if (!bad.ok) throw new Error(bad.error);
        for (const [source, expected] of [
          ["IF(true, 'ok', Bad)", "ok"],
          ["IFERROR('ok', Bad)", "ok"],
          ["IFEMPTY('ok', Bad)", "ok"],
          ["IFERROR(1 / 0, 0.1 + 0.2)", "0.3"],
          ["9007199254740993 + 0.1", "9007199254740993.1"],
        ] as const) {
          const compiled = compileFormulaSourceToSql(source, { fields: [], resolveField: () => bad.expression });
          if (!compiled.ok) throw new Error(compiled.error);
          const [row] = await tx`SELECT (${requireValidCalculationSql(compiled.expression)})::text AS value`;
          expect(row?.value).toBe(expected);
        }
      });
    }
    const invalid = compileFormulaSourceToSql("1 / 0", { fields: [] });
    if (!invalid.ok) throw new Error(invalid.error);
    await expect(sql`SELECT ${requireValidCalculationSql(invalid.expression)}`.execute()).rejects.toThrow("grids: invalid calculation");
  });

  postgresTest("row-dependent named branches stay lazy across repeated executions", async () => {
    const amount = formulaField("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Amount", "number");
    const bad = formulaField("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Bad", "formula", { expression: "LEFT('x', Amount)" });
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL plan_cache_mode = ${mode}`);
        for (const source of ["IF(Amount > 1, 'ok', Bad)", "IFERROR(IF(Amount > 1, 'ok', Bad), 'fallback')"]) {
          const compiled = compileFormulaSourceToSql(source, { fields: [amount, bad], useFinalizedFormulaValues: false });
          if (!compiled.ok) throw Error(compiled.error);
          for (let repeat = 0; repeat < 6; repeat++) {
            const [row] = await tx`SELECT ${compiled.expression.sql} AS value, ${compiled.expression.errorSql ?? sql`false`} AS error
              FROM (SELECT ${{ [amount.id]: 999999999999 }}::jsonb AS data) r`;
            expect(row).toMatchObject({ value: "ok", error: false });
          }
        }
      });
    }
  });
  postgresTest("measures bounded scalar filter and shared dependency plans", async () => {
    const amount = formulaField("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Amount", "number");
    const branches = Array.from({ length: 8 }, (_, index) =>
      formulaField(`branch-${index}`, `Branch${index}`, "formula", {
        expression: index === 0 ? "Amount / 100" : `IF(Amount > 0, Branch${index - 1} + 1, Branch${index - 1} - 1)`,
      }),
    );
    for (const source of ["Amount", "Branch7"]) {
      const compiled = compileFormulaSourceToSql(source, { fields: [amount, ...branches], useFinalizedFormulaValues: false });
      if (!compiled.ok) throw Error(compiled.error);
      const plan = await sql`EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF)
        SELECT ${compiled.expression.sql}, ${compiled.expression.errorSql ?? sql`false`}
        FROM (SELECT jsonb_build_object(${amount.id}::text, n) AS data FROM generate_series(1, 25) n) r
        WHERE ${compiled.expression.sql} > 0`;
      const report = plan[0]?.["QUERY PLAN"]?.[0];
      expect(report?.Plan?.["Actual Rows"]).toBe(25);
      expect(Number.isFinite(report?.["Planning Time"])).toBe(true);
      expect(Number.isFinite(report?.["Execution Time"])).toBe(true);
      console.info("formula-plan", source, { planningMs: report["Planning Time"], executionMs: report["Execution Time"] });
    }
  });
  postgresTest("shared named dependencies stay lazy with custom and generic plans", async () => {
    const bad = formulaField("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Bad", "formula", { expression: "LEFT('x', 999999999999)" });
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL plan_cache_mode = ${mode}`);
        for (const source of ["IF(true, 'ok', Bad)", "IF(false, Bad, 'ok')", "IFERROR('ok', Bad)", "IFEMPTY('ok', Bad)"]) {
          const compiled = compileFormulaSourceToSql(source, { fields: [bad], useFinalizedFormulaValues: false });
          if (!compiled.ok) throw Error(compiled.error);
          const [row] = await tx`SELECT ${compiled.expression.sql} AS value, ${compiled.expression.errorSql ?? sql`false`} AS error`;
          expect(row).toMatchObject({ value: "ok", error: false });
        }
      });
    }
  });
  postgresTest("Select equality and membership retain exact IDs, labels and empty semantics", async () => {
    for (const multiple of [false, true]) {
      const tax = formulaField("55555555-5555-4555-8555-555555555555", "Tax", "select", {
        multiple,
        options: [
          { id: "ust-19", label: "19 %" },
          { id: "ust-1", label: "1 %" },
        ],
      });
      for (const value of [null, [], ["ust-19"]]) {
        for (const source of [
          "HAS_OPTION(Tax, 'ust-1')",
          "HAS_OPTION(Tax, '19 %')",
          "ISBLANK(Tax)",
          "Tax = null",
          "Tax != null",
          ...(multiple ? [] : ["Tax = '19 %'", "Tax != 'ust-19'"]),
        ])
          await expectParity(source, { fields: [tax], values: { [tax.id]: value } });
      }
    }
  });
  postgresTest("staged branches do not execute unused failing SQL expressions", async () => {
    for (const source of [
      "IF(true, 'ok', LEFT('x', 999999999999))",
      "IF(false, LEFT('x', 999999999999), 'ok')",
      "IFERROR('ok', LEFT('x', 999999999999))",
      "IFEMPTY('ok', LEFT('x', 999999999999))",
      "AND(false, LEN(LEFT('x', 999999999999)) > 0)",
      "OR(true, LEN(LEFT('x', 999999999999)) > 0)",
      "false && LEN(LEFT('x', 999999999999)) > 0",
      "true || LEN(LEFT('x', 999999999999)) > 0",
      "IF(true, IF(false, 1, null), 2)",
      "IFERROR(1 / 0, 42)",
    ])
      await expectParity(source);
  });
  const berlin = { timeZone: "Europe/Berlin" } satisfies DateContext;
  const due = formulaField("11111111-1111-4111-8111-111111111111", "Due", "date");
  const timestamp = formulaField("22222222-2222-4222-8222-222222222222", "Timestamp", "date", { includeTime: true });
  const amount = formulaField("33333333-3333-4333-8333-333333333333", "Amount", "number");
  const numericText = formulaField("44444444-4444-4444-8444-444444444444", "Numeric text", "text");

  postgresTest("DATEADD bounds preserve calendar semantics and recoverable errors", async () => {
    for (const unit of ["years", "months", "days", "hours", "minutes"]) {
      for (const value of ["1000000000000", "-1000000000000", `1${"0".repeat(400)}`, null]) {
        const source = `DATEADD('2026-09-16', Amount, '${unit}')`;
        await expectParity(source, { fields: [amount], values: { [amount.id]: value } });
        await expectParity(`IFERROR(${source}, null)`, { fields: [amount], values: { [amount.id]: value } });
      }
    }
    for (const source of [
      "DATEADD('1000-01-01', -1, 'days')",
      "DATEADD('0001-01-01', 1, 'days')",
      "DATEADD('0099-12-31', 1, 'days')",
      "DATEADD('0001-01-01T12:00:00Z', 1, 'days')",
      "DATEADD('0000-01-01', 1, 'days')",
      "DATEADD('0099-02-30', 1, 'days')",
      "DATEDIFF('0099-12-31', '0100-01-01', 'days')",
      "DATEADD('2026-09-16', ' 2 ', 'days')",
      "DATEADD('2026-09-16', '2e1', 'days')",
      "IFERROR(DATEADD('2026-09-16', '1e400', 'days'), null)",
      "DATEADD('9999-12-31', 1, 'days')",
      "DATEADD('0999-12-31', 1, 'days')",
      "DATEADD('9999-12-31T23:00:00Z', 1, 'hours')",
      "DATEADD('1000-01-31', 1, 'months')",
      "DATEADD('1000-01-01', 8999, 'years')",
      "DATEADD('9999-12-31', -8999, 'years')",
      "DATEADD('9999-12-31', 0, 'minutes')",
      "DATEADD('1000-01-01', 0, 'hours')",
      "DATEADD('2026-09-16', 30, 'days')",
      "DATEADD('9999-12-31T22:00:00Z', 1, 'hours')",
    ])
      await expectParity(source);
    for (const timeZone of ["Pacific/Kiritimati", "America/New_York"]) {
      await expectParity("DATEADD('9999-12-31', 23, 'hours')", { dateConfig: { timeZone } });
    }
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL plan_cache_mode = ${mode}`);
        for (const source of [
          "IFERROR(DATEADD('2026-09-16', Amount, 'years'), null)",
          "IF(false, DATEADD('2026-09-16', Amount, 'days'), null)",
        ]) {
          const compiled = compileFormulaSourceToSql(source, { fields: [amount] });
          if (!compiled.ok) throw new Error(compiled.error);
          for (const value of [`1${"0".repeat(400)}`, `-1${"0".repeat(400)}`]) {
            const [row] = await tx`SELECT ${requireValidCalculationSql(compiled.expression)} AS value
              FROM (SELECT ${{ [amount.id]: value }}::jsonb AS data) r`;
            expect(row.value).toBeNull();
          }
        }
      });
    }
  });

  postgresTest("extracts instant calendar parts in the configured timezone", async () => {
    await expectParity("DAY('2026-05-01T22:30:00.000Z')", { dateConfig: berlin });
    await expectParity("DAY(Timestamp)", {
      dateConfig: berlin,
      fields: [timestamp],
      values: { [timestamp.id]: "2026-05-01T22:30:00.000Z" },
    });
  });

  postgresTest("adds calendar days across DST without losing the datetime", async () => {
    await expectParity("DATEADD('2026-03-28T11:00:00.000Z', 1, 'days')", { dateConfig: berlin });
    await expectParity("DATEADD(Timestamp, 1, 'days')", {
      dateConfig: berlin,
      fields: [timestamp],
      values: { [timestamp.id]: "2026-03-28T11:00:00.000Z" },
    });
  });

  postgresTest("moves nonexistent local clock times forward consistently", async () => {
    await expectParity("DATEADD('2026-03-29T00:30:00.000Z', 1, 'hours')", { dateConfig: berlin });
  });

  postgresTest("clamps month and year additions to the target calendar month", async () => {
    await expectParity("DATEADD('2026-01-31', 1, 'months')", { dateConfig: berlin });
    await expectParity("DATEADD('2026-03-31', -1, 'months')", { dateConfig: berlin });
    await expectParity("DATEADD('2024-02-29', 1, 'years')", { dateConfig: berlin });
    await expectParity("DATEADD('2026-01-31', 1.9, 'months')", { dateConfig: berlin });
    await expectParity("DATEADD(Due, 1, 'months')", {
      dateConfig: berlin,
      fields: [due],
      values: { [due.id]: "2026-01-31" },
    });
  });

  postgresTest("uses local calendar days but instant time for smaller differences", async () => {
    await expectParity("DATEDIFF('2026-05-01T22:30:00.000Z', '2026-05-02T21:30:00.000Z', 'days')", {
      dateConfig: berlin,
    });
    await expectParity("DATEDIFF('2026-03-29T00:30:00.000Z', '2026-03-29T02:30:00.000Z', 'hours')", {
      dateConfig: berlin,
    });
  });

  postgresTest("keeps conditional nulls separate from formula errors", async () => {
    await expectParity("IF(true, null, 7)");
    await expectParity("IF(false, null, 7)");
    await expectParity("IF(false, 1 / 0, 7)");
    await expectParity("IF(true, 1 / 0, 7)");
    await expectParity("IFEMPTY(null, 'fallback')");
    await expectParity("IFEMPTY(5, 1 / 0)");
    await expectParity("IFEMPTY(1 / 0, 5)");
    await expectParity("IFERROR(null, 7)");
    await expectParity("IFERROR(1 / 0, 7)");
    await expectParity("IFERROR(SQRT(-1), 9)");
    await expectParity("IFERROR(1 / 0, 2 / 0)");
    await expectParity("AND(false, 1 / 0)");
    await expectParity("AND(true, 1 / 0)");
    await expectParity("OR(true, 1 / 0)");
    await expectParity("CONCAT(1 / 0, 'x')");
  });

  postgresTest("uses one coercion matrix for equality and ordering", async () => {
    await expectParity("'10.00' = 10");
    await expectParity("'9.99' < '24.50'");
    await expectParity("null = null");
    await expectParity("null = ''");
    await expectParity("true = true");
    await expectParity("true = 'true'");
    await expectParity("'alpha' < 'beta'");
    await expectParity("'2026-05-02' = '2026-05-01T22:00:00Z'", { dateConfig: berlin });
    await expectParity("'2026-05-01T22:00:00Z' = '2026-05-02T00:00:00+02:00'", { dateConfig: berlin });
    await expectParity("Amount = 10", { fields: [amount], values: { [amount.id]: "10.00" } });
    await expectParity('"Numeric text" < 24', { fields: [numericText], values: { [numericText.id]: "9.99" } });
    await expectParity("\"Numeric text\" = ''", { fields: [numericText], values: { [numericText.id]: null } });
    await expectParity("Due = Timestamp", {
      dateConfig: berlin,
      fields: [due, timestamp],
      values: { [due.id]: "2026-05-02", [timestamp.id]: "2026-05-01T22:00:00Z" },
    });
  });

  postgresTest("matches runtime text addition and null propagation", async () => {
    await expectParity("'5.00' + '3.0'");
    await expectParity("'hello ' + 'world'");
    await expectParity("null + 'world'");
    await expectParity("\"Numeric text\" + '1.10'", {
      fields: [numericText],
      values: { [numericText.id]: "24.50" },
    });
  });
});
