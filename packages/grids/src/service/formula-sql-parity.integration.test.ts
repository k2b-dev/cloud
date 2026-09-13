import { beforeAll, describe, expect, test } from "bun:test";
import type { DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import { evaluate } from "../formula/evaluator";
import { parseFormula } from "../formula/parser";
import { isFormulaError } from "../formula/types";
import { migrate } from "../migrate";
import { normalizeRefKey } from "../ref-syntax";
import { compileFormulaSourceToSql, type FormulaSqlType } from "./formula-sql-compiler";
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
