import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { FORMULA_LIMITS, parseFormula } from "../formula/parser";
import { normalizedSqlParts } from "../sql-test-utils";
import { compileFormulaPredicateAstToSql, compileFormulaSourceToSql } from "./formula-sql-compiler";
import { requireValidCalculationSql } from "./formula-sql-values";
import type { Field } from "./types";

test("SQL compilation rejects expressions beyond the shared complexity budget", () => {
  const source = Array(FORMULA_LIMITS.depth + 1)
    .fill("1")
    .join("+");
  expect(compileFormulaSourceToSql(source, { fields: [] })).toMatchObject({
    ok: false,
    error: expect.stringContaining("levels of nesting"),
  });
});

const field = (overrides: Partial<Field> & Pick<Field, "id" | "shortId" | "name" | "type">): Field => ({
  id: overrides.id,
  shortId: overrides.shortId,
  tableId: "table_1",
  name: overrides.name,
  description: null,
  icon: null,
  type: overrides.type,
  config: overrides.config ?? {},
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

const fields = [
  field({ id: "price_id", shortId: "PRICE1", name: "Price", type: "number" }),
  field({ id: "qty_id", shortId: "QTY001", name: "Quantity", type: "number" }),
  field({ id: "name_id", shortId: "NAME01", name: "Name", type: "text" }),
  field({ id: "paid_id", shortId: "PAID01", name: "Paid", type: "boolean" }),
  field({ id: "due_id", shortId: "DUE001", name: "Due", type: "date" }),
  field({ id: "at_id", shortId: "AT0001", name: "Timestamp", type: "date", config: { includeTime: true } }),
  field({ id: "created_at_id", shortId: "CREAT1", name: "Created at", type: "created_at" }),
  field({ id: "created_by_id", shortId: "CREBY1", name: "Created by", type: "created_by" }),
  field({ id: "customer_id", shortId: "CUST01", name: "Customer", type: "relation" }),
  field({ id: "subtotal_id", shortId: "SUBTL1", name: "Subtotal", type: "formula", config: { expression: "{PRICE1} * {QTY001}" } }),
  field({ id: "blank_formula_id", shortId: "BLANK1", name: "Blank", type: "formula" }),
  field({ id: "cycle_a_id", shortId: "CYCLA1", name: "Cycle A", type: "formula", config: { expression: "{CYCLB1} + 1" } }),
  field({ id: "cycle_b_id", shortId: "CYCLB1", name: "Cycle B", type: "formula", config: { expression: "{CYCLA1} + 1" } }),
];

describe("compileFormulaSourceToSql", () => {
  test("total unary numeric expressions stay scalar SQL without planning stages", () => {
    const result = compileFormulaSourceToSql("-Price", { fields });
    if (!result.ok) throw new Error(result.error);
    const query = normalizedSqlParts(sql`SELECT ${requireValidCalculationSql(result.expression)}`);
    expect(query.text).not.toContain("LATERAL");
    expect(query.text).not.toContain("formula_seed");
    expect(result.expression.errorSql).toBeUndefined();
  });

  test("fallible arithmetic evaluates each numeric helper once per stage", () => {
    const result = compileFormulaSourceToSql("Price * Quantity + 0.20", { fields });
    if (!result.ok) throw new Error(result.error);
    const query = normalizedSqlParts(sql`SELECT ${requireValidCalculationSql(result.expression)}`);
    expect(query.text.match(/grids\.try_formula_numeric\(/g)).toHaveLength(2);
  });

  test("query boundaries share the value and error calculation plan", () => {
    const result = compileFormulaSourceToSql("Price / Quantity", { fields });
    if (!result.ok) throw new Error(result.error);
    const paired = normalizedSqlParts(sql`SELECT ${requireValidCalculationSql(result.expression)}`);
    const separate = normalizedSqlParts(sql`SELECT ${result.expression.sql}, ${result.expression.errorSql}`);
    expect(paired.text.match(/AS formula_seed/g)).toHaveLength(1);
    expect(separate.text.match(/AS formula_seed/g)).toHaveLength(2);
    expect(paired.text.length).toBeLessThan(separate.text.length);
  });

  test("a prepared formula retains its paired plan when referenced by another formula", () => {
    const prepared = compileFormulaSourceToSql("Price / Quantity", { fields });
    if (!prepared.ok) throw new Error(prepared.error);
    const result = compileFormulaSourceToSql("Subtotal + Subtotal", {
      fields,
      computedFieldSql: new Map([["subtotal_id", prepared.expression]]),
    });
    if (!result.ok) throw new Error(result.error);
    const query = normalizedSqlParts(sql`SELECT ${requireValidCalculationSql(result.expression)}`);
    // One outer plan and one prepared dependency, shared by both references.
    expect(query.text.match(/AS formula_seed/g)).toHaveLength(2);
    expect(query.text.match(/AS MATERIALIZED/g)).toHaveLength(1);
  });

  test("shared branch dependencies compile through eight levels", () => {
    const branches = Array.from({ length: 8 }, (_, index) =>
      field({
        id: `branch_${index}`,
        shortId: `BRANC${index}`,
        name: `Branch${index}`,
        type: "formula",
        config: { expression: index === 0 ? "1 + 2 + 3 + 4 + 5" : `IF(true, Branch${index - 1}, Branch${index - 1})` },
      }),
    );
    expect(compileFormulaSourceToSql("Branch7", { fields: branches })).toMatchObject({
      ok: true,
    });
    const size = (source: string) => {
      const compiled = compileFormulaSourceToSql(source, { fields: branches, useFinalizedFormulaValues: false });
      if (!compiled.ok) throw Error(compiled.error);
      return normalizedSqlParts(sql`SELECT ${compiled.expression.sql}, ${compiled.expression.errorSql ?? sql`false`}`);
    };
    const four = size("Branch3");
    const eight = size("Branch7");
    expect(eight.text.length).toBeLessThan(four.text.length * 3);
    expect(eight.values.length).toBeLessThan(four.values.length * 3);
    expect(eight.values.length).toBeLessThan(65535);
  });
  test("Select binding also applies to scoped resolver fields", () => {
    const select = { name: "Status", config: { options: [{ id: "ready", label: "Ready" }] } };
    const resolveField = () => ({ sql: sql`'[]'::jsonb`, type: "unknown" as const, select });
    expect(compileFormulaSourceToSql("customer.Status = 'Ready'", { fields: [], resolveField, scopedRefs: true }).ok).toBe(true);
    expect(compileFormulaSourceToSql("CONTAINS(customer.Status, 'read')", { fields: [], resolveField, scopedRefs: true })).toMatchObject({
      ok: false,
    });
  });
  test("list reductions respect resolved scopes and never fall back past resolver errors", () => {
    const list = field({
      id: "list_id",
      shortId: "ITEMS1",
      name: "Items",
      type: "object_list",
      config: {
        fields: [{ id: "Amount", name: "Amount", type: "number" }],
      },
    });
    expect(
      compileFormulaSourceToSql("LIST_COUNT(ITEMS1)", {
        fields: [list],
        resolveField: () => "This scope is not available",
      }),
    ).toEqual({ ok: false, error: "This scope is not available" });
    expect(
      compileFormulaSourceToSql("LIST_COUNT(ITEMS1)", {
        fields: [list],
        resolveField: () => ({ sql: sql`1`, type: "numeric" }),
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("not an object-list") });
    expect(
      compileFormulaSourceToSql("LIST_SUM(ITEMS1, 'Missing')", {
        fields: [],
        resolveField: () => ({ sql: sql`'[]'::jsonb`, type: "unknown", objectListConfig: list.config }),
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("numeric list column") });
  });
  test("compiles decimal arithmetic over named field refs", () => {
    const result = compileFormulaSourceToSql("Price * Quantity", { fields });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.expression.type).toBe("numeric");
  });

  test("compiles canonical public field id refs", () => {
    const result = compileFormulaSourceToSql("{PRICE1} * {QTY001}", { fields });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.expression.type).toBe("numeric");
  });

  test("compiles quoted field names", () => {
    const spaced = [field({ id: "unit_price_id", shortId: "uprice", name: "Unit price", type: "number" })];
    const result = compileFormulaSourceToSql('"Unit price" * 1.19', { fields: spaced });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.expression.type).toBe("numeric");
  });

  test("compiles text functions", () => {
    const result = compileFormulaSourceToSql("CONCAT(UPPER(Name), ' / ', Quantity)", { fields });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.expression.type).toBe("text");
  });

  test("keeps text addition runtime-shaped", () => {
    const result = compileFormulaSourceToSql("Name + ' suffix'", { fields });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.expression.type).toBe("text");
  });

  test("compiles boolean comparisons and IF", () => {
    const result = compileFormulaSourceToSql("IF(Price > 10 && Paid, 'ok', 'hold')", { fields });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.expression.type).toBe("text");
  });

  test("unifies null conditional branches and rejects incompatible types", () => {
    for (const source of ["IF(true, null, 1)", "IFEMPTY(null, 'fallback')", "IFERROR(1 / 0, 7)"]) {
      const result = compileFormulaSourceToSql(source, { fields });
      expect(result.ok, source).toBe(true);
    }

    for (const source of ["IF(true, 1, 'text')", "IFEMPTY('text', 2)", "IFERROR(1 / 0, 'bad')"]) {
      const result = compileFormulaSourceToSql(source, { fields });
      expect(result.ok, source).toBe(false);
      if (!result.ok) expect(result.error).toContain("must have the same type or use null");
    }
  });

  test("compiles date helpers with stable TODAY", () => {
    const result = compileFormulaSourceToSql("DATEDIFF(TODAY(), Due, 'days')", {
      fields,
      now: new Date("2026-06-08T12:00:00.000Z"),
      dateConfig: { timeZone: "Europe/Berlin" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.expression.type).toBe("numeric");
  });

  test("compiles date-time helpers", () => {
    const result = compileFormulaSourceToSql("DATEADD(Timestamp, 2, 'hours')", { fields });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.expression.type).toBe("datetime");

    const calendarResult = compileFormulaSourceToSql("DATEADD(Timestamp, 1, 'days')", { fields });
    expect(calendarResult.ok).toBe(true);
    if (calendarResult.ok) expect(calendarResult.expression.type).toBe("datetime");
  });

  test("rejects date functions over untyped text instead of guessing", () => {
    for (const source of ["DAY(Name)", "DATEADD(Name, 1, 'days')", "DATEDIFF(Name, Due, 'days')", "YEAR('not-a-date')"]) {
      const result = compileFormulaSourceToSql(source, { fields });
      expect(result.ok, source).toBe(false);
      if (!result.ok) expect(result.error).toContain("expects date/datetime fields or ISO date/instant literals");
    }
  });

  test("types system timestamps as datetime and system users as text", () => {
    const timestamp = compileFormulaSourceToSql('"Created at"', { fields });
    expect(timestamp.ok).toBe(true);
    if (timestamp.ok) expect(timestamp.expression.type).toBe("datetime");

    const user = compileFormulaSourceToSql('"Created by"', { fields });
    expect(user.ok).toBe(true);
    if (user.ok) expect(user.expression.type).toBe("text");
  });

  test("rejects unknown field refs", () => {
    const result = compileFormulaSourceToSql("{MISS01} + 1", { fields });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown formula field reference");
  });

  test("rejects non-projectable relation refs instead of falling back to JS", () => {
    const result = compileFormulaSourceToSql("{CUST01}", { fields });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot be compiled into SQL formulas");
  });

  test("inlines a referenced formula field's own expression", () => {
    const result = compileFormulaSourceToSql("{SUBTL1} + 1", { fields });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.expression.type).toBe("numeric");
  });

  test("rejects a formula field that has no expression", () => {
    const result = compileFormulaSourceToSql("{BLANK1} + 1", { fields });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("has no expression");
  });

  test("rejects a cycle between formula fields", () => {
    const result = compileFormulaSourceToSql("{CYCLA1} + 1", { fields });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cycle");
  });

  test("rejects unsafe record aliases", () => {
    const result = compileFormulaSourceToSql("{PRICE1}", { fields, recordAlias: "r; drop table records" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unsafe SQL record alias");
  });

  test("compiles only boolean formula predicates", () => {
    const bool = parseFormula("{PRICE1} <= {QTY001}");
    expect(bool.ok).toBe(true);
    if (bool.ok) expect(compileFormulaPredicateAstToSql(bool.ast, { fields })).toMatchObject({ ok: true });

    const numeric = parseFormula("{PRICE1} + {QTY001}");
    expect(numeric.ok).toBe(true);
    if (numeric.ok) expect(compileFormulaPredicateAstToSql(numeric.ast, { fields })).toMatchObject({ ok: false });
  });

  test("compiles predicates over caller-provided SQL refs", () => {
    const bool = parseFormula("revenue > 100 && rows >= 2");
    expect(bool.ok).toBe(true);
    if (!bool.ok) return;

    const result = compileFormulaPredicateAstToSql(bool.ast, {
      fields: [],
      resolveField: (ref) => {
        if (ref === "revenue") return { sql: sql`SUM(r.amount)`, type: "numeric" };
        if (ref === "rows") return { sql: sql`COUNT(*)`, type: "numeric" };
        return null;
      },
    });

    expect(result.ok).toBe(true);
  });

  test("compiles mixed-type comparisons without raw incompatible SQL operators", () => {
    const text = compileFormulaSourceToSql("Price = '10'", { fields });
    expect(text.ok).toBe(true);
    if (text.ok) expect(text.expression.type).toBe("boolean");

    const date = compileFormulaSourceToSql("Due < '2026-06-10'", { fields });
    expect(date.ok).toBe(true);
    if (date.ok) expect(date.expression.type).toBe("boolean");
  });

  test("rejects unsupported date units at compile time", () => {
    const result = compileFormulaSourceToSql("DATEADD(Due, 1, 'fortnights')", { fields });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("DATEADD needs a literal unit");
  });

  test("rejects wrong formula function arity before SQL generation", () => {
    const cases = [
      ["AND()", "AND needs at least 1 argument; got 0"],
      ["CONCAT()", "CONCAT needs at least 1 argument; got 0"],
      ["IF(Paid, 'ok')", "IF needs 3 arguments; got 2"],
      ["SUBSTRING({NAME01}, 1)", "SUBSTRING needs 3 arguments; got 2"],
      ["TODAY({DUE001})", "TODAY needs 0 arguments; got 1"],
    ] as const;

    for (const [source, message] of cases) {
      const result = compileFormulaSourceToSql(source, { fields });
      expect(result.ok, source).toBe(false);
      if (!result.ok) expect(result.error).toBe(message);
    }
  });

  test("covers the current formula function surface", () => {
    const examples = [
      "ABS({PRICE1})",
      "ROUND({PRICE1}, 2)",
      "FLOOR({PRICE1})",
      "CEIL({PRICE1})",
      "SQRT({PRICE1})",
      "POW({PRICE1}, 2)",
      "MOD({QTY001}, 2)",
      "SUM({PRICE1}, {QTY001})",
      "AVG({PRICE1}, {QTY001})",
      "MEAN({PRICE1}, {QTY001})",
      "COUNT({PRICE1}, {NAME01})",
      "MEDIAN({PRICE1}, {QTY001}, 10)",
      "MIN({PRICE1}, {QTY001})",
      "MAX({PRICE1}, {QTY001})",
      "PERCENT({PRICE1}, {QTY001})",
      "CONCAT({NAME01}, ' ', {QTY001})",
      "LEN({NAME01})",
      "LOWER({NAME01})",
      "UPPER({NAME01})",
      "TRIM({NAME01})",
      "LEFT({NAME01}, 2)",
      "RIGHT({NAME01}, 2)",
      "SUBSTRING({NAME01}, 1, 2)",
      "REPLACE({NAME01}, 'a', 'b')",
      "IF({PAID01}, 'yes', 'no')",
      "IFEMPTY({NAME01}, 'missing')",
      "IFERROR({PRICE1} / 0, 0)",
      "AND({PAID01}, {PRICE1} > 0)",
      "OR({PAID01}, {PRICE1} > 0)",
      "NOT({PAID01})",
      "ISBLANK({NAME01})",
      "CONTAINS({NAME01}, 'a')",
      "TODAY()",
      "NOW()",
      "YEAR({DUE001})",
      "MONTH({DUE001})",
      "DAY({DUE001})",
      "DATEADD({DUE001}, 1, 'days')",
      "DATEDIFF({DUE001}, TODAY(), 'days')",
    ];

    for (const source of examples) {
      const result = compileFormulaSourceToSql(source, { fields, now: new Date("2026-06-08T12:00:00.000Z") });
      expect(result, source).toMatchObject({ ok: true });
    }
  });
});

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

describe("compileFormulaSourceToSql postgres smoke", () => {
  postgresTest("runs decimal-safe arithmetic in Postgres numeric", async () => {
    const result = compileFormulaSourceToSql("{PRICE1} + {QTY001} * 0.20", { fields });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await sql`
      SELECT ${result.expression.sql} AS value
      FROM (
        SELECT jsonb_build_object(${fields[0]!.id}::text, ${"0.10"}::text, ${fields[1]!.id}::text, ${"1.00"}::text) AS data
      ) r
    `;

    expect(String(rows[0]?.value)).toBe("0.300");
  });

  postgresTest("runs date helpers in Postgres", async () => {
    const result = compileFormulaSourceToSql("DATEDIFF(TODAY(), {DUE001}, 'days')", {
      fields,
      now: new Date("2026-06-08T12:00:00.000Z"),
      dateConfig: { timeZone: "Europe/Berlin" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await sql`
      SELECT ${result.expression.sql} AS value
      FROM (
        SELECT jsonb_build_object(${fields[4]!.id}::text, ${"2026-06-10"}::text) AS data
      ) r
    `;

    expect(String(rows[0]?.value)).toBe("2");
  });

  postgresTest("runs text and IF helpers in Postgres", async () => {
    const result = compileFormulaSourceToSql("IF({PAID01}, CONCAT(UPPER({NAME01}), ' paid'), 'open')", { fields });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await sql`
      SELECT ${result.expression.sql} AS value
      FROM (
        SELECT jsonb_build_object(${fields[2]!.id}::text, ${"invoice"}::text, ${fields[3]!.id}::text, ${"true"}::text) AS data
      ) r
    `;

    expect(String(rows[0]?.value)).toBe("INVOICE paid");
  });
});
