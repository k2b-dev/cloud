import { describe, expect, test } from "bun:test";
import { evaluate, renderResult } from "./evaluator";
import type { FormulaRuntimeContext } from "./functions";
import { parseFormula } from "./parser";

const run = (src: string, fields: Record<string, unknown> = {}, ctx: FormulaRuntimeContext = {}): unknown => {
  const r = parseFormula(src);
  if (!r.ok) throw new Error(r.error);
  return evaluate(r.ast, { fields, ...ctx });
};

test("numeric literals retain digits beyond JavaScript precision", () => {
  expect(run("9007199254740993.25 + 0.10")).toBe("9007199254740993.35");
  expect(run("0.00")).toBe(0);
});

test("list reductions use typed row values, exact arithmetic and explicit empty semantics", () => {
  const listColumns = { list: { amount: "Amount" } };
  const reduce = (fn: string, value: unknown) => {
    const parsed = parseFormula(`${fn}(Items${fn === "LIST_COUNT" ? "" : ", 'Amount'"})`);
    if (!parsed.ok) throw new Error(parsed.error);
    return evaluate(parsed.ast, { fields: { list: value }, slugToId: { items: "list" }, listColumns });
  };
  expect(reduce("LIST_SUM", [{ Amount: "9007199254740993.25" }, { Amount: "0.10" }])).toBe("9007199254740993.35");
  expect(reduce("LIST_AVG", [{ Amount: "0.10" }, { Amount: "0.30" }])).toBe("0.2");
  expect(reduce("LIST_MIN", [{ Amount: null }, { Amount: "0.30" }])).toBe("0.3");
  expect(reduce("LIST_MAX", [{ Amount: "0.10" }, { Amount: "0.30" }])).toBe("0.3");
  expect(reduce("LIST_COUNT", [{ Amount: null }, {}])).toBe("2");
  expect(reduce("LIST_SUM", [])).toBe("0");
  expect(reduce("LIST_SUM", null)).toBeNull();
  expect(reduce("LIST_AVG", [])).toBeNull();
  expect(reduce("LIST_COUNT", [])).toBe("0");
  expect(renderResult(reduce("LIST_SUM", [{ Amount: "bad" }]))).toBe("#INVALID_LIST_VALUE");
});

const runWithPublicIds = (src: string, fields: Record<string, unknown>, publicIdToInternalId: Record<string, string>): unknown => {
  const r = parseFormula(src);
  if (!r.ok) throw new Error(r.error);
  return evaluate(r.ast, { fields, slugToId: publicIdToInternalId });
};

// ── Math ────────────────────────────────────────────────────────
test("arithmetic: 1 + 2 * 3 = 7", () => {
  expect(run("1 + 2 * 3")).toBe(7);
});

test("numeric literal arithmetic does not introduce binary floating-point drift", () => {
  expect(run("0.1 + 0.2")).toBe(0.3);
  expect(run("0.3 - 0.1")).toBe(0.2);
  expect(run("0.1 * 0.2")).toBe(0.02);
  expect(run("0.3 / 0.1")).toBe(3);
  expect(run("0.3 % 0.1")).toBe(0);
});

test("numeric results promote to exact strings instead of rounding an intermediate value", () => {
  expect(run("9007199254740992 + 1")).toBe("9007199254740993");
  expect(run("9007199254740992 + 1 - 9007199254740992")).toBe("1");
  expect(run("SUM(9007199254740992, 1)")).toBe("9007199254740993");
  expect(run("SUM(9007199254740992, 1) - 9007199254740992")).toBe("1");
  expect(run("POW(3, 35)")).toBe("50031545098999707");
  expect(run("ROUND(9007199254740992 + 1, 0)")).toBe("9007199254740993");
  expect(run("AVG(9007199254740992, 1)")).toBe("4503599627370496.5");
  expect(run("2 * 3")).toBe(6);
});

test("non-finite math results are errors, not ordinary text values", () => {
  expect(renderResult(run("POW(-1, 0.5)"))).toBe("#NON_NUMERIC");
  expect(renderResult(run("POW(0, -1)"))).toBe("#NON_NUMERIC");
  expect(run("IFERROR(POW(-1, 0.5), 42)")).toBe(42);
});

test("ROUND truncates fractional places and rejects scales outside the shared numeric range", () => {
  expect(run("ROUND(125, -1.9)")).toBe(130);
  expect(run("ROUND(1.25, 1.9)")).toBe(1.3);
  expect(renderResult(run("ROUND(1, 2147483648)"))).toBe("#ROUND_BAD_PLACES");
  expect(renderResult(run("ROUND(1, -131073)"))).toBe("#ROUND_BAD_PLACES");
  expect(renderResult(run("ROUND(1, 16384)"))).toBe("#ROUND_BAD_PLACES");
  expect(run("ROUND(1, -131072)")).toBe(0);
  expect(run("ROUND(1, 16383)")).toBe(1);
  expect(run("IFERROR(ROUND(1, 2147483648), 42)")).toBe(42);
  expect(run("ROUND(null, 2147483648)")).toBeNull();
  expect(renderResult(run("ROUND(1, Places)", { Places: "9".repeat(400) }))).toBe("#ROUND_BAD_PLACES");
});

test("arithmetic and reductions retain the declared 38-digit field precision", () => {
  const fields = { Amount: "123456789012345678901234567890.12" };
  expect(run("Amount + 1", fields)).toBe("123456789012345678901234567891.12");
  expect(run("SUM(Amount, 1)", fields)).toBe("123456789012345678901234567891.12");
  expect(run("AVG(Amount, Amount)", fields)).toBe(fields.Amount);
  expect(run("ROUND(Amount, 2)", fields)).toBe(fields.Amount);
});

test("finite arithmetic and reductions retain digits beyond the default calculation precision", () => {
  const amount = `1${"0".repeat(80)}`;
  const fields = { Amount: amount, Small: "0.01" };
  expect(run("Amount + 1 - Amount", fields)).toBe("1");
  expect(run("SUM(Amount, 1) - Amount", fields)).toBe("1");
  expect(run("Amount * (Amount + 1) - Amount * Amount", fields)).toBe(amount);
  expect(run("MOD(Amount + 1, Amount)", fields)).toBe("1");
  expect(run("(Amount + 1) % Amount", fields)).toBe("1");
  expect(run("AVG(Amount, Amount + 2) - Amount", fields)).toBe("1");
  expect(run("MEDIAN(Amount, Amount + 2) - Amount", fields)).toBe("1");
  expect(run("Amount + Small - Amount", fields)).toBe("0.01");
  expect(run("AVG(1, 2, 4)")).not.toBe(2.3);
});
test("negative ROUND places round once, including values beyond the working precision", () => {
  const fields = { Amount: `1${"0".repeat(80)}` };
  expect(run("ROUND(Amount + 149, -2) - Amount", fields)).toBe("100");
  expect(run("ROUND(Amount + 150, -2) - Amount", fields)).toBe("200");
  expect(run("ROUND(-Amount - 149, -2) + Amount", fields)).toBe("-100");
  expect(run("ROUND(-Amount - 150, -2) + Amount", fields)).toBe("-200");
});
test("subtract + unary minus", () => {
  expect(run("5 - -3")).toBe(8);
});
test("division by zero → DIV_ZERO error", () => {
  const v = run("1 / 0");
  expect(renderResult(v)).toBe("#DIV_ZERO");
});

// ── Null propagation ──────────────────────────────────────────────
test("any null operand → null in arithmetic", () => {
  expect(run("{FIELD1} + 1", { FIELD1: null })).toBeNull();
  expect(run("1 + {FIELD1}", { FIELD1: null })).toBeNull();
});
test("equality treats null = null as true", () => {
  expect(run("{FIELD1} = {FIELD2}", { FIELD1: null, FIELD2: null })).toBe(true);
  expect(run("{FIELD1} = 0", { FIELD1: null })).toBe(false);
});

// ── Comparison ────────────────────────────────────────────────────
test("number comparison", () => {
  expect(run("3 > 2")).toBe(true);
  expect(run("2 >= 2")).toBe(true);
});
test("comparison coercion is numeric, temporal, boolean, then text", () => {
  expect(run("'10.00' = 10")).toBe(true);
  expect(run("'9.99' < '24.50'")).toBe(true);
  expect(run("null = ''")).toBe(false);
  expect(run("true = 'true'")).toBe(false);
  expect(run("'alpha' < 'beta'")).toBe(true);
  expect(run("'2026-05-02' = '2026-05-01T22:00:00Z'", {}, { dateConfig: { timeZone: "Europe/Berlin" } })).toBe(true);
  expect(run("'2026-05-01T22:00:00Z' = '2026-05-02T00:00:00+02:00'")).toBe(true);
});

// ── Logic ────────────────────────────────────────────────────────
test("logical AND short-circuits on falsy left", () => {
  expect(run("false && {FIELD1}", { FIELD1: 1 })).toBe(false);
});
test("logical OR short-circuits on truthy left", () => {
  expect(run("true || {FIELD1}", { FIELD1: 1 })).toBe(true);
});

// ── Functions: math ───────────────────────────────────────────────
test("ABS", () => {
  expect(run("ABS(-5)")).toBe(5);
});
test("ROUND with places", () => {
  expect(run("ROUND(3.14159, 2)")).toBe(3.14);
});
test("MIN / MAX", () => {
  expect(run("MIN(3, 1, 2)")).toBe(1);
  expect(run("MAX(3, 1, 2)")).toBe(3);
});
test("SUM / AVG / MEDIAN / COUNT", () => {
  expect(run("SUM(3, 1, 2)")).toBe(6);
  expect(run("AVG(3, 1, 2)")).toBe(2);
  expect(run("MEAN(3, 1, 2)")).toBe(2);
  expect(run("MEDIAN(10, 1, 3)")).toBe(3);
  expect(run("COUNT(0, '', null, 'x')")).toBe(2);
});
test("SQRT / POW / MOD / PERCENT", () => {
  expect(run("SQRT(9)")).toBe(3);
  expect(run("POW(2, 3)")).toBe(8);
  expect(run("MOD(10, 4)")).toBe(2);
  expect(run("PERCENT(1, 4)")).toBe(25);
});

// ── Functions: text ──────────────────────────────────────────────
test("CONCAT", () => {
  expect(run("CONCAT('foo', ' ', 'bar')")).toBe("foo bar");
});
test("LEN / LOWER / UPPER / TRIM", () => {
  expect(run("LEN('hello')")).toBe(5);
  expect(run("LOWER('HELLO')")).toBe("hello");
  expect(run("UPPER('hello')")).toBe("HELLO");
  expect(run("TRIM('  spaced  ')")).toBe("spaced");
});
test("CONTAINS / LEFT / RIGHT / SUBSTRING / REPLACE", () => {
  expect(run("CONTAINS('Invoice paid', 'paid')")).toBe(true);
  expect(run("STARTSWITH('Invoice paid', 'Invoice')")).toBe(true);
  expect(run("ENDSWITH('Invoice paid', 'paid')")).toBe(true);
  expect(run("ICONTAINS('Invoice paid', 'PAID')")).toBe(true);
  expect(run("ISTARTSWITH('Invoice paid', 'invoice')")).toBe(true);
  expect(run("IENDSWITH('Invoice paid', 'PAID')")).toBe(true);
  expect(run("LEFT('abcdef', 2)")).toBe("ab");
  expect(run("RIGHT('abcdef', 2)")).toBe("ef");
  expect(run("SUBSTRING('abcdef', 2, 3)")).toBe("cde");
  expect(run("REPLACE('a-b-a', 'a', 'x')")).toBe("x-b-x");
});

// ── Functions: logic ─────────────────────────────────────────────
test("IF returns then-branch when truthy", () => {
  expect(run("IF(true, 'yes', 'no')")).toBe("yes");
  expect(run("IF(false, 'yes', 'no')")).toBe("no");
});
test("IFEMPTY and IFERROR", () => {
  expect(run("IFEMPTY({FIELD1}, 'fallback')", { FIELD1: "" })).toBe("fallback");
  expect(run("IFEMPTY({FIELD1}, 'fallback')", { FIELD1: "value" })).toBe("value");
  expect(run("IFEMPTY(5, 1 / 0)")).toBe(5);
  expect(run("IFERROR(1 / 0, 'fallback')")).toBe("fallback");
  expect(run("IFERROR(2 + 2, 'fallback')")).toBe(4);
  expect(run("IFERROR(null, 'fallback')")).toBeNull();
  expect(renderResult(run("IFERROR(1 / 0)"))).toBe("#IFERROR_BAD_ARGS");
});
test("ISBLANK", () => {
  expect(run("ISBLANK({FIELD1})", { FIELD1: null })).toBe(true);
  expect(run("ISBLANK({FIELD1})", { FIELD1: "" })).toBe(true);
  expect(run("ISBLANK({FIELD1})", { FIELD1: "set" })).toBe(false);
});

// ── Functions: date ──────────────────────────────────────────────
test("YEAR / MONTH / DAY", () => {
  expect(run("YEAR('2026-05-02')")).toBe(2026);
  expect(run("MONTH('2026-05-02')")).toBe(5);
  expect(run("DAY('2026-05-02')")).toBe(2);
  expect(run("DAY('2026-05-02T00:30')")).toBe(2);
});
test("date functions use the configured timezone for instants", () => {
  const ctx = { dateConfig: { timeZone: "Europe/Berlin" }, now: new Date("2026-05-01T22:30:00.000Z") };
  expect(run("TODAY()", {}, ctx)).toBe("2026-05-02");
  expect(run("NOW()", {}, ctx)).toBe("2026-05-01T22:30:00.000Z");
  expect(run("DAY('2026-05-01T22:30:00.000Z')", {}, ctx)).toBe(2);
});
test("DATEADD days", () => {
  expect(run("DATEADD('2026-05-02', 7, 'days')")).toBe("2026-05-09");
});
test("DATEADD clamps month and year additions to the target month", () => {
  expect(run("DATEADD('2026-01-31', 1, 'months')")).toBe("2026-02-28");
  expect(run("DATEADD('2026-03-31', -1, 'months')")).toBe("2026-02-28");
  expect(run("DATEADD('2024-02-29', 1, 'years')")).toBe("2025-02-28");
});
test("DATEADD uses whole units", () => {
  expect(run("DATEADD('2026-05-02', 1.9, 'days')")).toBe("2026-05-03");
});
test("DATEADD preserves instants for time-aware inputs", () => {
  expect(run("DATEADD('2026-05-01T22:30:00.000Z', 1, 'days')", {}, { dateConfig: { timeZone: "Europe/Berlin" } })).toBe(
    "2026-05-02T22:30:00.000Z",
  );
});
test("DATEDIFF days", () => {
  expect(run("DATEDIFF('2026-05-02', '2026-05-09', 'days')")).toBe(7);
});
test("DATEDIFF days compares local calendar days for instants", () => {
  expect(
    run("DATEDIFF('2026-05-01T22:30:00.000Z', '2026-05-02T21:30:00.000Z', 'days')", {}, { dateConfig: { timeZone: "Europe/Berlin" } }),
  ).toBe(0);
});

// ── Field references ─────────────────────────────────────────────
test("price * quantity", () => {
  expect(run("{PRICE1} * {QUANT1}", { PRICE1: 9.99, QUANT1: 3 })).toBeCloseTo(29.97);
});

// ── Render ────────────────────────────────────────────────────────
test("renderResult passes literals through, errors as #CODE", () => {
  expect(renderResult(42)).toBe(42);
  expect(renderResult("hello")).toBe("hello");
  expect(renderResult(null)).toBeNull();
  expect(renderResult(run("1/0"))).toBe("#DIV_ZERO");
});

test("function arity matches the SQL compiler catalog", () => {
  expect(renderResult(run("ROUND()"))).toBe("#ROUND_BAD_ARGS");
  expect(renderResult(run("ROUND(1, 2, 3)"))).toBe("#ROUND_BAD_ARGS");
  expect(renderResult(run("IF(true, 'yes')"))).toBe("#IF_BAD_ARGS");
  expect(renderResult(run("AND()"))).toBe("#AND_BAD_ARGS");
});

// ── Decimal precision ─────────────────────────────────────────────
//
// Decimal-safe number cells store their value as a string ("24.50") to dodge JS
// double drift.
describe("exact-arithmetic for decimal-string values", () => {
  test("decimal string * number literal preserves precision", () => {
    expect(run("{FIELD1} * 1.19", { FIELD1: "24.50" })).toBe("29.155");
  });
  test("0.1 + 0.2 — the canonical float-drift case", () => {
    expect(run("{FIELD1} + {FIELD2}", { FIELD1: "0.1", FIELD2: "0.2" })).toBe("0.3");
  });
  test("decimal-string + decimal-string adds (does NOT string-concat)", () => {
    // Pre-fix this concat'd to "24.501.19". Regression guard.
    expect(run("{FIELD1} + {FIELD2}", { FIELD1: "24.50", FIELD2: "1.19" })).toBe("25.69");
  });
  test("plain-text + plain-text still concats", () => {
    expect(run("{FIELD1} + {FIELD2}", { FIELD1: "Hello, ", FIELD2: "world" })).toBe("Hello, world");
  });
  test("comparison between decimal strings uses numeric ordering", () => {
    // Lexicographic would say "24.50" < "9.99" (true), which is wrong.
    expect(run("{FIELD1} < {FIELD2}", { FIELD1: "9.99", FIELD2: "24.50" })).toBe(true);
  });
  test("division by zero still surfaces #DIV_ZERO on the exact path", () => {
    expect(renderResult(run("{FIELD1} / 0", { FIELD1: "24.50" }))).toBe("#DIV_ZERO");
  });
  test("plain-number arithmetic keeps using JS numbers", () => {
    // 9.99 * 3 = 29.97 mathematically; expect the existing toBeCloseTo
    // behaviour the parser/evaluator has always had for unboxed numbers.
    expect(run("{PRICE1} * {QUANT1}", { PRICE1: 9.99, QUANT1: 3 })).toBeCloseTo(29.97);
  });
  test("numeric functions keep decimal strings exact", () => {
    expect(run("SUM({FIELD1}, {FIELD2})", { FIELD1: "0.1", FIELD2: "0.2" })).toBe("0.3");
    expect(run("AVG({FIELD1}, {FIELD2})", { FIELD1: "0.1", FIELD2: "0.2" })).toBe("0.15");
    expect(run("ROUND({FIELD1}, 2)", { FIELD1: "1.005" })).toBe("1.01");
    expect(run("PERCENT({FIELD1}, {FIELD2})", { FIELD1: "1.50", FIELD2: "6.00" })).toBe("25");
  });
  test("legacy amount-shaped numeric objects still calculate", () => {
    expect(run("{FIELD1} * 2", { FIELD1: { amount: "1.20" } })).toBe("2.4");
    expect(run("SUM({FIELD1}, 0.30)", { FIELD1: { amount: "1.20" } })).toBe("1.5");
  });
});

// ── Public field ID references ───────────────────────────────────
describe("public field id references", () => {
  const fieldId = "00000000-0000-0000-0000-000000000001";
  test("a public id resolves to the internal field value", () => {
    expect(runWithPublicIds("{PRICE1} * 2", { [fieldId]: 5 }, { PRICE1: fieldId })).toBe(10);
  });
  test("a public id keeps decimal precision", () => {
    expect(runWithPublicIds("{PRICE1} * 1.19", { [fieldId]: "24.50" }, { PRICE1: fieldId })).toBe("29.155");
  });
  test("a public id pointing to a missing field returns null", () => {
    expect(runWithPublicIds("{PRICE1} + 1", {}, { PRICE1: fieldId })).toBeNull();
  });
  test("multiple public ids interoperate inside one expression", () => {
    const otherFieldId = "00000000-0000-0000-0000-000000000002";
    expect(runWithPublicIds("{PRICE1} + {PRICE2}", { [fieldId]: 5, [otherFieldId]: 7 }, { PRICE1: fieldId, PRICE2: otherFieldId })).toBe(
      12,
    );
  });
});

// ── Function library edge cases ──────────────────────────────────
//
// The evaluator dispatches into FN_LIBRARY for every CALL node. The
// happy path is covered above; here we lock in the error-/edge-case
// behaviour so a regression in any one helper doesn't silently turn
// `null` results into garbage.
describe("FN_LIBRARY edge cases", () => {
  test("ROUND with no places defaults to 0 places", () => {
    expect(run("ROUND(3.7)")).toBe(4);
    expect(run("ROUND(-2.5)")).toBe(-3); // half-away-from-zero, negative
  });
  test("ROUND with negative places (round to 10s)", () => {
    expect(run("ROUND(127, -1)")).toBe(130);
  });
  test("MIN / MAX skip null inputs and use the rest", () => {
    expect(run("MIN({FIELD1}, 3, 1, {FIELD2})", { FIELD1: null, FIELD2: null })).toBe(1);
    expect(run("MAX({FIELD1}, 3, 1, {FIELD2})", { FIELD1: null, FIELD2: null })).toBe(3);
  });
  test("MIN / MAX of all-null args → null (no Math.min(...[])=Infinity bug)", () => {
    expect(run("MIN({FIELD1}, {FIELD2})", { FIELD1: null, FIELD2: null })).toBeNull();
    expect(run("MAX({FIELD1}, {FIELD2})", { FIELD1: null, FIELD2: null })).toBeNull();
  });
  test("CONCAT coerces nulls to empty string, numbers to digits", () => {
    expect(run("CONCAT('a', {FIELD1}, 42)", { FIELD1: null })).toBe("a42");
    expect(run("CONCAT('a', true)")).toBe("atrue");
  });
  test("ISBLANK considers '' and null blank, but 0 / false are NOT blank", () => {
    expect(run("ISBLANK({FIELD1})", { FIELD1: 0 })).toBe(false);
    expect(run("ISBLANK({FIELD1})", { FIELD1: false })).toBe(false);
    expect(run("ISBLANK({FIELD1})", { FIELD1: " " })).toBe(false); // whitespace ≠ blank
  });
  test("AND / OR coerce truthy/falsy across types", () => {
    expect(run("AND(1, 'x', true)")).toBe(true);
    expect(run("AND(1, 0, true)")).toBe(false);
    expect(run("OR(0, '', false)")).toBe(false);
    expect(run("OR(0, 1)")).toBe(true);
  });
  test("DATEADD with bad unit surfaces #DATEADD_BAD_UNIT", () => {
    expect(renderResult(run("DATEADD('2026-01-01', 1, 'fortnights')"))).toBe("#DATEADD_BAD_UNIT");
  });
  test("DATEDIFF with bad unit surfaces #DATEDIFF_BAD_UNIT", () => {
    expect(renderResult(run("DATEDIFF('2026-01-01', '2026-02-01', 'moons')"))).toBe("#DATEDIFF_BAD_UNIT");
  });
  test("DATEADD with unparseable date → null", () => {
    expect(run("DATEADD('not-a-date', 7, 'days')")).toBeNull();
  });
  test("DATEDIFF supports hours / minutes / seconds units", () => {
    expect(run("DATEDIFF('2026-01-01T00:00:00Z', '2026-01-01T03:30:00Z', 'hours')")).toBe(3);
    expect(run("DATEDIFF('2026-01-01T00:00:00Z', '2026-01-01T00:05:30Z', 'minutes')")).toBe(5);
  });
  test("YEAR / MONTH / DAY return null on garbage input rather than throwing", () => {
    expect(run("YEAR({FIELD1})", { FIELD1: "garbage" })).toBeNull();
    expect(run("YEAR('2025-13-45')")).toBeNull();
    expect(run("MONTH({FIELD1})", { FIELD1: null })).toBeNull();
    expect(run("DAY({FIELD1})", { FIELD1: 42 })).toBeNull(); // numbers aren't dates
  });
  test("unknown function surfaces #UNKNOWN_FN:NAME", () => {
    expect(renderResult(run("FOO(1, 2)"))).toBe("#UNKNOWN_FN:FOO");
  });
});

// ── Whitespace insensitivity ─────────────────────────────────────
//
// Regression guard: every form below tokenises to the same `[field,
// op, num]` sequence around a canonical public field ID.
describe("whitespace insensitivity around operators", () => {
  test.each(["{FIELD1}*1.19", "{FIELD1} *1.19", "{FIELD1}* 1.19", "{FIELD1} * 1.19", "{FIELD1}  *  1.19", "\t{FIELD1}\t*\t1.19\t"])(
    "'%s' → 119",
    (src) => {
      expect(runWithPublicIds(src, { internal: 100 }, { FIELD1: "internal" })).toBe(119);
    },
  );
});
