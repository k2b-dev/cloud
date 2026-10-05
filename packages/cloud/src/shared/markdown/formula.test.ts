import { describe, expect, test } from "bun:test";
import {
  type ErrorCode,
  type EvalContext,
  type EvalResult,
  evaluateFormula,
  formatValue,
  isFormula,
  isTotalRow,
  parseProgressValue,
} from "./formula";

// =============================================================================
// Helpers
// =============================================================================

const ctx = (headers: string[], rows: string[][], currentRow = 0, currentCol = 0): EvalContext => ({
  headers,
  rows,
  currentRow,
  currentCol,
});

const expectOk = (res: EvalResult, value: number | string | boolean) => {
  expect(res.kind).toBe("ok");
  if (res.kind === "ok") expect(res.value).toBe(value);
};

const expectError = (res: EvalResult, code: ErrorCode) => {
  expect(res.kind).toBe("error");
  if (res.kind === "error") expect(res.code).toBe(code);
};

const expectProgress = (res: EvalResult, ratio: number, label: string) => {
  expect(res.kind).toBe("ok");
  if (res.kind !== "ok") return;
  const progress = parseProgressValue(res.value);
  expect(progress).not.toBeNull();
  expect(progress?.ratio).toBe(ratio);
  expect(progress?.label).toBe(label);
};

// =============================================================================
// isFormula + formatValue
// =============================================================================

describe("helpers", () => {
  test("isFormula recognises = prefix", () => {
    expect(isFormula("=SUM(price)")).toBe(true);
    expect(isFormula("100")).toBe(false);
    expect(isFormula("")).toBe(false);
  });

  test("formatValue keeps integers integer", () => {
    expect(formatValue(42)).toBe("42");
    expect(formatValue(0)).toBe("0");
    expect(formatValue(-5)).toBe("-5");
  });

  test("formatValue strips trailing zeros from decimals", () => {
    expect(formatValue(1.5)).toBe("1.5");
    expect(formatValue(1.23456)).toBe("1.23456");
  });

  test("formatValue handles infinity / NaN", () => {
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe("∞");
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe("-∞");
    expect(formatValue(Number.NaN)).toBe("NaN");
  });

  test("formatValue passes strings through, booleans → 1/0", () => {
    expect(formatValue("hello")).toBe("hello");
    expect(formatValue(true)).toBe("1");
    expect(formatValue(false)).toBe("0");
  });
});

// =============================================================================
// Lexer / parser smoke tests via end-to-end eval
// =============================================================================

describe("lexer + parser", () => {
  const c = ctx(["a"], [["10"]]);

  test("rejects formula without leading =", () => {
    expectError(evaluateFormula("SUM(a)", c), "PARSE_ERROR");
  });

  test("rejects empty formula", () => {
    expectError(evaluateFormula("=", c), "PARSE_ERROR");
    expectError(evaluateFormula("=   ", c), "PARSE_ERROR");
  });

  test("rejects trailing garbage", () => {
    expectError(evaluateFormula("=1 + 2 foo", c), "PARSE_ERROR");
  });

  test("rejects unterminated string", () => {
    expectError(evaluateFormula(`="hello`, c), "PARSE_ERROR");
  });

  test("rejects unexpected character", () => {
    expectError(evaluateFormula("=1 # 2", c), "PARSE_ERROR");
  });

  test("number literals parse including decimals", () => {
    expectOk(evaluateFormula("=42", c), 42);
    expectOk(evaluateFormula("=3.14", c), 3.14);
    expectOk(evaluateFormula("=.5", c), 0.5);
  });

  test("string literals with escapes", () => {
    expectOk(evaluateFormula(`="hello"`, c), "hello");
    expectOk(evaluateFormula(`="he said \\"hi\\""`, c), 'he said "hi"');
    expectOk(evaluateFormula(`="back\\\\slash"`, c), "back\\slash");
  });
});

// =============================================================================
// Operator precedence + associativity
// =============================================================================

describe("operator precedence", () => {
  const c = ctx(["a"], [["1"]]);

  test("multiplication binds tighter than addition", () => {
    expectOk(evaluateFormula("=2 + 3 * 4", c), 14);
    expectOk(evaluateFormula("=10 - 2 * 3", c), 4);
  });

  test("parens override precedence", () => {
    expectOk(evaluateFormula("=(2 + 3) * 4", c), 20);
  });

  test("left-associative subtraction", () => {
    expectOk(evaluateFormula("=10 - 3 - 2", c), 5);
  });

  test("comparison binds looser than arithmetic", () => {
    expectOk(evaluateFormula("=1 + 1 == 2", c), 1);
    expectOk(evaluateFormula("=2 * 3 > 5", c), 1);
  });

  test("unary minus", () => {
    expectOk(evaluateFormula("=-5", c), -5);
    expectOk(evaluateFormula("=10 + -3", c), 7);
    expectOk(evaluateFormula("=-(2 + 3)", c), -5);
  });

  test("division by zero", () => {
    expectError(evaluateFormula("=10 / 0", c), "DIV_BY_ZERO");
  });
});

// =============================================================================
// Column references
// =============================================================================

describe("column references", () => {
  test("reference resolves to current row's value", () => {
    const c = ctx(["price"], [["100"], ["200"]], 1);
    expectOk(evaluateFormula("=price", c), 200);
  });

  test("case-insensitive header match", () => {
    const c = ctx(["Price"], [["100"]]);
    expectOk(evaluateFormula("=price", c), 100);
    expectOk(evaluateFormula("=PRICE", c), 100);
  });

  test("non-numeric cell returns string", () => {
    const c = ctx(["status"], [["active"]]);
    expectOk(evaluateFormula("=status", c), "active");
  });

  test("a cell is a number only when its whole text is one", () => {
    const c = ctx(["date", "amount", "count"], [["2026-10-12", "1,5", " 12.50 "]]);
    expectOk(evaluateFormula("=date", c), "2026-10-12");
    expectOk(evaluateFormula("=amount", c), "1,5");
    expectOk(evaluateFormula("=count", c), 12.5);
    expectOk(evaluateFormula(`=COUNTIF(date, "2026-10-12")`, ctx(["date"], [["2026-10-12"], ["2026-10-31"]], 5)), 1);
  });

  test("a long run of digits before text stays text without backtracking", () => {
    const digits = `${"0".repeat(50_000)}x`;
    const c = ctx(["a", "b"], [[digits, ""]], 0, 1);
    expectOk(evaluateFormula("=a", c), digits);
    expectOk(evaluateFormula("=a == 0", c), 1);
    expectOk(evaluateFormula("=COUNTIF(a, 0)", c), 1);
  });

  test("unknown column reports suggestion", () => {
    const c = ctx(["price", "hours"], [["10", "5"]]);
    const res = evaluateFormula("=prce", c);
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.code).toBe("UNKNOWN_COLUMN");
      expect(res.suggestion).toBe("price");
      expect(res.message).toContain("did you mean");
    }
  });

  test("inline arithmetic with column refs", () => {
    const c = ctx(["hours", "rate"], [["10", "50"]]);
    expectOk(evaluateFormula("=hours * rate", c), 500);
    expectOk(evaluateFormula("=price / 1.19", ctx(["price"], [["119"]])), 100);
  });
});

// =============================================================================
// Column aggregates
// =============================================================================

describe("column aggregates", () => {
  const c = ctx(
    ["price", "name"],
    [
      ["10", "a"],
      ["20", "b"],
      ["30", "c"],
      ["", "d"],
      ["x", "e"],
    ],
  );

  test("SUM skips empty + non-numeric", () => {
    expectOk(evaluateFormula("=SUM(price)", c), 60);
  });

  test("SUM and arithmetic read the leading number of unit text", () => {
    const money = ctx(
      ["Price", "Qty"],
      [
        ["5 €", "2"],
        ["2.50 €", "4"],
      ],
    );
    expectOk(evaluateFormula("=SUM(Price)", money), 7.5);
    expectOk(evaluateFormula("=Price * Qty", money), 10);
  });

  test("SUM skips the current formula cell when aggregating its own column", () => {
    const ownColumn = ctx(["Hours"], [["10"], ["10"], ["=SUM(Hours)"]], 2, 0);
    expectOk(evaluateFormula("=SUM(Hours)", ownColumn), 20);
  });

  test("AVG counts only numeric cells", () => {
    expectOk(evaluateFormula("=AVG(price)", c), 20);
  });

  test("MEAN is alias for AVG", () => {
    expectOk(evaluateFormula("=MEAN(price)", c), 20);
  });

  test("MIN / MAX over numeric cells", () => {
    expectOk(evaluateFormula("=MIN(price)", c), 10);
    expectOk(evaluateFormula("=MAX(price)", c), 30);
  });

  test("COUNT counts non-empty cells (incl non-numeric)", () => {
    // 5 rows, one empty cell in price — counts the 4 non-empty (incl "x")
    expectOk(evaluateFormula("=COUNT(price)", c), 4);
  });

  test("COUNT skips the current formula cell when aggregating its own column", () => {
    const ownColumn = ctx(["Name"], [["Ada"], ["Grace"], ["=COUNT(Name)"]], 2, 0);
    expectOk(evaluateFormula("=COUNT(Name)", ownColumn), 2);
  });

  test("aggregates on empty column return 0", () => {
    const empty = ctx(["x"], []);
    expectOk(evaluateFormula("=SUM(x)", empty), 0);
    expectOk(evaluateFormula("=AVG(x)", empty), 0);
  });

  test("unknown column in aggregate", () => {
    const res = evaluateFormula("=SUM(prce)", c);
    expectError(res, "UNKNOWN_COLUMN");
  });

  test("wrong arg count for aggregate", () => {
    expectError(evaluateFormula("=SUM()", c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula("=SUM(price, name)", c), "WRONG_ARG_COUNT");
  });
});

describe("UNIQUE / COUNTIF / SUMIF / STDEV", () => {
  test("UNIQUE counts distinct non-empty values", () => {
    const c = ctx(["status"], [["done"], ["pending"], ["done"], [""], ["pending"], ["new"]]);
    expectOk(evaluateFormula("=UNIQUE(status)", c), 3); // done, pending, new
  });

  test("UNIQUE skips the current formula cell when aggregating its own column", () => {
    const c = ctx(["status"], [["done"], ["pending"], ["done"], ["=UNIQUE(status)"]], 3, 0);
    expectOk(evaluateFormula("=UNIQUE(status)", c), 2);
  });

  test("UNIQUE is case-sensitive", () => {
    const c = ctx(["x"], [["A"], ["a"], ["A"]]);
    expectOk(evaluateFormula("=UNIQUE(x)", c), 2);
  });

  test("UNIQUE empty column returns 0", () => {
    const c = ctx(["x"], []);
    expectOk(evaluateFormula("=UNIQUE(x)", c), 0);
  });

  test("UNIQUE arg count + unknown column", () => {
    const c = ctx(["x"], [["1"]]);
    expectError(evaluateFormula("=UNIQUE()", c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula("=UNIQUE(y)", c), "UNKNOWN_COLUMN");
  });

  test("COUNTIF counts exact-string matches", () => {
    const c = ctx(["status"], [["done"], ["pending"], ["done"], ["done"]]);
    expectOk(evaluateFormula(`=COUNTIF(status, "done")`, c), 3);
    expectOk(evaluateFormula(`=COUNTIF(status, "pending")`, c), 1);
    expectOk(evaluateFormula(`=COUNTIF(status, "missing")`, c), 0);
  });

  test("COUNTIF skips the current formula cell when counting its own column", () => {
    const c = ctx(["status"], [["done"], ["pending"], ["done"], [`=COUNTIF(status, "done")`]], 3, 0);
    expectOk(evaluateFormula(`=COUNTIF(status, "done")`, c), 2);
  });

  test("COUNTIF matches numbers as strings", () => {
    const c = ctx(["price"], [["10"], ["20"], ["10"], ["30"]]);
    expectOk(evaluateFormula("=COUNTIF(price, 10)", c), 2);
  });

  test("COUNTIF and SUMIF match a cell the way == does", () => {
    const c = ctx(
      ["Price", "Qty", "Due"],
      [
        ["5 €", "1", "2026-10-12"],
        ["5 €", "2", "2026-10-12T00:00"],
        ["7 €", "4", "2026-10-13"],
      ],
    );
    expectOk(evaluateFormula("=COUNTIF(Price, 5)", c), 2);
    expectOk(evaluateFormula(`=COUNTIF(Price, "5 €")`, c), 2);
    expectOk(evaluateFormula(`=COUNTIF(Price, "5.00 €")`, c), 0);
    expectOk(evaluateFormula("=SUMIF(Qty, Price, 5)", c), 3);
    expectOk(evaluateFormula(`=COUNTIF(Due, "2026-10-12")`, c), 2);
    expectOk(evaluateFormula(`=SUMIF(Qty, Due, "2026-10-13")`, c), 4);
  });

  test("COUNTIF arg count + unknown column", () => {
    const c = ctx(["x"], [["1"]]);
    expectError(evaluateFormula("=COUNTIF(x)", c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula(`=COUNTIF(y, "v")`, c), "UNKNOWN_COLUMN");
  });

  test("SUMIF sums values where condition matches", () => {
    const c = ctx(
      ["hours", "status"],
      [
        ["8", "done"],
        ["4", "pending"],
        ["6", "done"],
        ["3", "done"],
        ["5", "pending"],
      ],
    );
    expectOk(evaluateFormula(`=SUMIF(hours, status, "done")`, c), 17); // 8 + 6 + 3
    expectOk(evaluateFormula(`=SUMIF(hours, status, "pending")`, c), 9); // 4 + 5
  });

  test("SUMIF skips the current formula cell when summing its own column", () => {
    const c = ctx(
      ["hours", "status"],
      [
        ["10", "done"],
        ["10", "done"],
        [`=SUMIF(hours, status, "done")`, "done"],
      ],
      2,
      0,
    );
    expectOk(evaluateFormula(`=SUMIF(hours, status, "done")`, c), 20);
  });

  test("SUMIF skips non-numeric sum cells silently", () => {
    const c = ctx(
      ["amount", "type"],
      [
        ["10", "a"],
        ["x", "a"],
        ["20", "a"],
      ],
    );
    expectOk(evaluateFormula(`=SUMIF(amount, type, "a")`, c), 30);
  });

  test("SUMIF no matches returns 0", () => {
    const c = ctx(["x", "y"], [["1", "a"]]);
    expectOk(evaluateFormula(`=SUMIF(x, y, "z")`, c), 0);
  });

  test("SUMIF arg count + type errors", () => {
    const c = ctx(["x", "y"], [["1", "a"]]);
    expectError(evaluateFormula(`=SUMIF(x, y)`, c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula(`=SUMIF(1, y, "a")`, c), "TYPE_ERROR");
    expectError(evaluateFormula(`=SUMIF(x, 1, "a")`, c), "TYPE_ERROR");
    expectError(evaluateFormula(`=SUMIF(x, missing, "a")`, c), "UNKNOWN_COLUMN");
  });

  test("STDEV computes sample standard deviation", () => {
    const c = ctx(["n"], [["2"], ["4"], ["4"], ["4"], ["5"], ["5"], ["7"], ["9"]]);
    // Sample stdev = sqrt(32/7) ≈ 2.138...
    const r = evaluateFormula("=STDEV(n)", c);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.value as number).toBeCloseTo(2.138, 2);
  });

  test("STDEV returns 0 for fewer than 2 numbers", () => {
    expectOk(evaluateFormula("=STDEV(x)", ctx(["x"], [])), 0);
    expectOk(evaluateFormula("=STDEV(x)", ctx(["x"], [["5"]])), 0);
  });

  test("STDEV arg count + unknown column", () => {
    const c = ctx(["x"], [["1"]]);
    expectError(evaluateFormula("=STDEV()", c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula("=STDEV(y)", c), "UNKNOWN_COLUMN");
  });
});

// =============================================================================
// Row aggregates
// =============================================================================

describe("row aggregates", () => {
  test("ROWSUM sums numeric cells, excludes self column", () => {
    const c = ctx(["a", "b", "c", "d"], [["10", "20", "30", "?"]], 0, 2);
    // Excluding currentCol=2 ("30") and skipping non-numeric "?"
    expectOk(evaluateFormula("=ROWSUM()", c), 30);
  });

  test("ROWAVG averages numeric cells, excludes self", () => {
    const c = ctx(["a", "b", "c"], [["10", "20", "30"]], 0, 2);
    // Excluding "30", avg of [10, 20] = 15
    expectOk(evaluateFormula("=ROWAVG()", c), 15);
  });

  test("ROWMEAN is alias for ROWAVG", () => {
    const c = ctx(["a", "b"], [["4", "6"]], 0, 0);
    expectOk(evaluateFormula("=ROWMEAN()", c), 6);
  });

  test("row aggregates take no arguments", () => {
    const c = ctx(["a"], [["1"]]);
    expectError(evaluateFormula("=ROWSUM(a)", c), "WRONG_ARG_COUNT");
  });

  test("ROWAVG on row with no numeric cells returns 0", () => {
    const c = ctx(["a", "b"], [["x", "y"]], 0, 0);
    expectOk(evaluateFormula("=ROWAVG()", c), 0);
  });
});

// =============================================================================
// Math functions
// =============================================================================

describe("ROUND + ABS", () => {
  const c = ctx(["a"], [["1"]]);

  test("ROUND with positive digits", () => {
    expectOk(evaluateFormula("=ROUND(3.14159, 2)", c), 3.14);
    expectOk(evaluateFormula("=ROUND(0.5, 0)", c), 1);
  });

  test("ROUND with 0 digits", () => {
    expectOk(evaluateFormula("=ROUND(2.7, 0)", c), 3);
  });

  test("ABS handles negative + positive", () => {
    expectOk(evaluateFormula("=ABS(-5)", c), 5);
    expectOk(evaluateFormula("=ABS(5)", c), 5);
    expectOk(evaluateFormula("=ABS(0)", c), 0);
  });

  test("wrong arg count", () => {
    expectError(evaluateFormula("=ROUND(1)", c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula("=ABS(1, 2)", c), "WRONG_ARG_COUNT");
  });
});

describe("SQRT + POW + MOD", () => {
  const c = ctx(["a"], [["1"]]);

  test("SQRT computes square root", () => {
    expectOk(evaluateFormula("=SQRT(9)", c), 3);
    expectOk(evaluateFormula("=SQRT(2)", c), Math.SQRT2);
    expectOk(evaluateFormula("=SQRT(0)", c), 0);
  });

  test("SQRT rejects negative input", () => {
    expectError(evaluateFormula("=SQRT(-1)", c), "NON_NUMERIC");
  });

  test("SQRT wrong arg count", () => {
    expectError(evaluateFormula("=SQRT()", c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula("=SQRT(1, 2)", c), "WRONG_ARG_COUNT");
  });

  test("POW computes powers", () => {
    expectOk(evaluateFormula("=POW(2, 10)", c), 1024);
    expectOk(evaluateFormula("=POW(5, 0)", c), 1);
    expectOk(evaluateFormula("=POW(4, 0.5)", c), 2);
  });

  test("POW handles negative base", () => {
    expectOk(evaluateFormula("=POW(-2, 3)", c), -8);
  });

  test("POW wrong arg count", () => {
    expectError(evaluateFormula("=POW(2)", c), "WRONG_ARG_COUNT");
  });

  test("MOD computes modulo", () => {
    expectOk(evaluateFormula("=MOD(10, 3)", c), 1);
    expectOk(evaluateFormula("=MOD(15, 5)", c), 0);
    expectOk(evaluateFormula("=MOD(-7, 3)", c), -1); // JS modulo keeps sign of dividend
  });

  test("MOD rejects zero divisor", () => {
    expectError(evaluateFormula("=MOD(10, 0)", c), "DIV_BY_ZERO");
  });

  test("MOD wrong arg count", () => {
    expectError(evaluateFormula("=MOD(10)", c), "WRONG_ARG_COUNT");
  });
});

describe("AND / OR / NOT / CONTAINS", () => {
  const c = ctx(["a"], [["1"]]);

  test("AND returns 1 when all truthy, 0 otherwise", () => {
    expectOk(evaluateFormula("=AND(1, 2, 3)", c), 1);
    expectOk(evaluateFormula(`=AND("yes", 1)`, c), 1);
    expectOk(evaluateFormula("=AND(1, 0, 3)", c), 0);
    expectOk(evaluateFormula(`=AND("", 1)`, c), 0);
  });

  test("AND short-circuits on first false (later errors not surfaced)", () => {
    // The 1/0 short-circuit means the third arg is never evaluated;
    // if it were, the unknown column would error.
    expectOk(evaluateFormula("=AND(0, missingCol)", c), 0);
  });

  test("AND requires at least one argument", () => {
    expectError(evaluateFormula("=AND()", c), "WRONG_ARG_COUNT");
  });

  test("OR returns 1 if any truthy, 0 if all falsy", () => {
    expectOk(evaluateFormula("=OR(0, 0, 1)", c), 1);
    expectOk(evaluateFormula("=OR(0, 0, 0)", c), 0);
    expectOk(evaluateFormula(`=OR("", "")`, c), 0);
  });

  test("OR short-circuits on first true", () => {
    expectOk(evaluateFormula("=OR(1, missingCol)", c), 1);
  });

  test("OR requires at least one argument", () => {
    expectError(evaluateFormula("=OR()", c), "WRONG_ARG_COUNT");
  });

  test("NOT inverts truthiness", () => {
    expectOk(evaluateFormula("=NOT(1)", c), 0);
    expectOk(evaluateFormula("=NOT(0)", c), 1);
    expectOk(evaluateFormula(`=NOT("")`, c), 1);
    expectOk(evaluateFormula(`=NOT("hi")`, c), 0);
  });

  test("NOT requires exactly one argument", () => {
    expectError(evaluateFormula("=NOT()", c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula("=NOT(1, 2)", c), "WRONG_ARG_COUNT");
  });

  test("CONTAINS does substring match", () => {
    expectOk(evaluateFormula(`=CONTAINS("hello world", "world")`, c), 1);
    expectOk(evaluateFormula(`=CONTAINS("hello world", "xyz")`, c), 0);
    expectOk(evaluateFormula(`=CONTAINS("hello", "")`, c), 1); // empty needle always matches
  });

  test("CONTAINS coerces numbers to string", () => {
    expectOk(evaluateFormula(`=CONTAINS("price: 42", 42)`, c), 1);
  });

  test("CONTAINS requires two arguments", () => {
    expectError(evaluateFormula(`=CONTAINS("hi")`, c), "WRONG_ARG_COUNT");
  });

  test("AND/OR/NOT integrate with IF", () => {
    const c2 = ctx(["x", "y"], [["10", "20"]]);
    expectOk(evaluateFormula(`=IF(AND(x > 5, y < 30), "yes", "no")`, c2), "yes");
    expectOk(evaluateFormula(`=IF(OR(x > 100, y > 100), "high", "low")`, c2), "low");
    expectOk(evaluateFormula(`=IF(NOT(x == 0), "non-zero", "zero")`, c2), "non-zero");
  });
});

// =============================================================================
// Conditional functions
// =============================================================================

describe("IF / IFEMPTY / IFERROR", () => {
  test("IF picks the true branch", () => {
    const c = ctx(["price"], [["100"]]);
    expectOk(evaluateFormula(`=IF(price > 50, "expensive", "cheap")`, c), "expensive");
    expectOk(evaluateFormula(`=IF(price > 200, "expensive", "cheap")`, c), "cheap");
  });

  test("IF: 0 is false, non-zero is true", () => {
    const c = ctx(["a"], [["0"]]);
    expectOk(evaluateFormula(`=IF(a, "yes", "no")`, c), "no");
    expectOk(evaluateFormula(`=IF(1, "yes", "no")`, c), "yes");
  });

  test("IF: text with a unit is non-empty text and therefore true", () => {
    const c = ctx(["Discount", "Progress"], [["0 €", "0%"]]);
    expectOk(evaluateFormula(`=IF(Discount, "yes", "no")`, c), "yes");
    expectOk(evaluateFormula(`=NOT(Progress)`, c), 0);
    expectOk(evaluateFormula(`=IF(Discount > 0, "yes", "no")`, c), "no");
    expectOk(evaluateFormula(`=IF(Progress == 0, "todo", "started")`, c), "todo");
  });

  test("IF lazily evaluates only chosen branch", () => {
    const c = ctx(["a"], [["10"]]);
    // false branch divides by zero — must NOT evaluate when condition true
    expectOk(evaluateFormula(`=IF(1, 42, 1 / 0)`, c), 42);
  });

  test("IFEMPTY falls back when column cell is empty", () => {
    const c = ctx(["notes"], [[""]]);
    expectOk(evaluateFormula(`=IFEMPTY(notes, "(none)")`, c), "(none)");
  });

  test("IFEMPTY passes value through when not empty", () => {
    const c = ctx(["notes"], [["hello"]]);
    expectOk(evaluateFormula(`=IFEMPTY(notes, "(none)")`, c), "hello");
  });

  test("IFERROR catches errors and returns fallback", () => {
    const c = ctx(["a"], [["10"]]);
    expectOk(evaluateFormula(`=IFERROR(10 / 0, "—")`, c), "—");
    expectOk(evaluateFormula(`=IFERROR(SUM(missing), 0)`, c), 0);
  });

  test("IFERROR passes through ok results", () => {
    const c = ctx(["a"], [["10"]]);
    expectOk(evaluateFormula(`=IFERROR(10 / 2, "—")`, c), 5);
  });
});

// =============================================================================
// String functions
// =============================================================================

describe("string functions", () => {
  const c = ctx(["name"], [["Hello"]]);

  test("CONCAT joins values, coerces numbers to strings", () => {
    expectOk(evaluateFormula(`=CONCAT("Hi ", name, "!")`, c), "Hi Hello!");
    expectOk(evaluateFormula(`=CONCAT(1, "+", 2, "=", 3)`, c), "1+2=3");
  });

  test("UPPER / LOWER", () => {
    expectOk(evaluateFormula(`=UPPER(name)`, c), "HELLO");
    expectOk(evaluateFormula(`=LOWER(name)`, c), "hello");
  });

  test("LEN measures string length", () => {
    expectOk(evaluateFormula(`=LEN(name)`, c), 5);
    expectOk(evaluateFormula(`=LEN("")`, c), 0);
  });

  test("SUBSTRING is 0-indexed", () => {
    // "Hello", start=0, len=3 → "Hel"
    expectOk(evaluateFormula(`=SUBSTRING(name, 0, 3)`, c), "Hel");
    // "Hello", start=1, len=3 → "ell"
    expectOk(evaluateFormula(`=SUBSTRING(name, 1, 3)`, c), "ell");
    // out-of-range start clamps to 0
    expectOk(evaluateFormula(`=SUBSTRING(name, -1, 2)`, c), "He");
    // length past end returns what's available
    expectOk(evaluateFormula(`=SUBSTRING(name, 2, 99)`, c), "llo");
  });

  test("string function arg count", () => {
    expectError(evaluateFormula(`=UPPER()`, c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula(`=SUBSTRING("hi", 0)`, c), "WRONG_ARG_COUNT");
  });
});

describe("TRIM / LEFT / RIGHT / REPLACE", () => {
  const c = ctx(["a"], [["1"]]);

  test("TRIM strips leading/trailing whitespace", () => {
    // NOTE: the formula string-literal parser only supports `\"` and
    // `\\` escapes (see lexer comment) — no `\t` / `\n`. So we test
    // with plain spaces here. TRIM uses String.prototype.trim which
    // strips all Unicode whitespace, so real tabs/newlines passing
    // through (e.g. via column refs that contain them) would also be
    // stripped at runtime.
    expectOk(evaluateFormula(`=TRIM("  hi  ")`, c), "hi");
    expectOk(evaluateFormula(`=TRIM("hi")`, c), "hi");
    expectOk(evaluateFormula(`=TRIM("   ")`, c), "");
  });

  test("TRIM wrong arg count", () => {
    expectError(evaluateFormula("=TRIM()", c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula(`=TRIM("a", "b")`, c), "WRONG_ARG_COUNT");
  });

  test("LEFT takes first N chars", () => {
    expectOk(evaluateFormula(`=LEFT("Hello", 3)`, c), "Hel");
    expectOk(evaluateFormula(`=LEFT("Hi", 5)`, c), "Hi"); // n > length: full string
    expectOk(evaluateFormula(`=LEFT("Hi", 0)`, c), "");
    expectOk(evaluateFormula(`=LEFT("Hi", -1)`, c), ""); // negative clamps to 0
  });

  test("LEFT rejects non-numeric n", () => {
    expectError(evaluateFormula(`=LEFT("hi", "x")`, c), "NON_NUMERIC");
  });

  test("RIGHT takes last N chars", () => {
    expectOk(evaluateFormula(`=RIGHT("Hello", 3)`, c), "llo");
    expectOk(evaluateFormula(`=RIGHT("Hi", 5)`, c), "Hi");
    expectOk(evaluateFormula(`=RIGHT("Hi", 0)`, c), "");
    expectOk(evaluateFormula(`=RIGHT("Hi", -1)`, c), "");
  });

  test("LEFT/RIGHT arg count", () => {
    expectError(evaluateFormula(`=LEFT("hi")`, c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula(`=RIGHT()`, c), "WRONG_ARG_COUNT");
  });

  test("REPLACE substitutes all occurrences", () => {
    expectOk(evaluateFormula(`=REPLACE("aaa", "a", "b")`, c), "bbb");
    expectOk(evaluateFormula(`=REPLACE("hello world", "world", "there")`, c), "hello there");
    expectOk(evaluateFormula(`=REPLACE("none here", "xyz", "abc")`, c), "none here");
  });

  test("REPLACE rejects empty search", () => {
    expectError(evaluateFormula(`=REPLACE("hi", "", "x")`, c), "PARSE_ERROR");
  });

  test("REPLACE arg count", () => {
    expectError(evaluateFormula(`=REPLACE("hi", "x")`, c), "WRONG_ARG_COUNT");
  });
});

describe("NOW / TODAY / DATEDIFF", () => {
  const c = ctx(["a"], [["1"]]);

  test("NOW returns YYYY-MM-DD HH:MM:SS", () => {
    const r = evaluateFormula("=NOW()", c);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(typeof r.value).toBe("string");
      expect(r.value as string).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
  });

  test("TODAY returns YYYY-MM-DD", () => {
    const r = evaluateFormula("=TODAY()", c);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.value as string).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("NOW / TODAY reject arguments", () => {
    expectError(evaluateFormula(`=NOW("hi")`, c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula(`=TODAY(1)`, c), "WRONG_ARG_COUNT");
  });

  test("DATEDIFF default unit is days", () => {
    expectOk(evaluateFormula(`=DATEDIFF("2026-01-01", "2026-01-11")`, c), 10);
    expectOk(evaluateFormula(`=DATEDIFF("2026-01-11", "2026-01-01")`, c), -10);
  });

  test("DATEDIFF supports h / hours / m / minutes / s / seconds", () => {
    expectOk(evaluateFormula(`=DATEDIFF("2026-01-01T00:00:00Z", "2026-01-01T03:00:00Z", "h")`, c), 3);
    expectOk(evaluateFormula(`=DATEDIFF("2026-01-01T00:00:00Z", "2026-01-01T03:00:00Z", "hours")`, c), 3);
    expectOk(evaluateFormula(`=DATEDIFF("2026-01-01T00:00:00Z", "2026-01-01T00:30:00Z", "m")`, c), 30);
    expectOk(evaluateFormula(`=DATEDIFF("2026-01-01T00:00:00Z", "2026-01-01T00:00:45Z", "s")`, c), 45);
  });

  test("DATEDIFF reads ISO dates and timestamps from cells", () => {
    const cells = ctx(
      ["Start", "End", "Opened", "Closed", "Days"],
      [["2026-10-01", "2026-10-12", "2026-01-01T00:00:00Z", "2026-01-01T03:00:00Z", ""]],
      0,
      4,
    );
    expectOk(evaluateFormula(`=DATEDIFF(Start, End, "d")`, cells), 11);
    expectOk(evaluateFormula(`=DATEDIFF(End, "2027-10-12")`, cells), 365);
    expectOk(evaluateFormula(`=DATEDIFF(Opened, Closed, "h")`, cells), 3);
  });

  test("DATEDIFF agrees with the comparison operators in every time zone", () => {
    const cells = ctx(["Due", "Done", "Utc"], [["2026-10-12", "2026-10-11T20:00", "2026-10-12T00:00:00Z"]]);
    const zones: [string, number][] = [
      ["UTC", 0],
      ["Europe/Berlin", 2],
      ["America/Los_Angeles", -7],
    ];
    const previous = process.env.TZ;
    try {
      for (const [zone, utcHoursAfterDue] of zones) {
        process.env.TZ = zone;
        const result = (formula: string) => {
          const res = evaluateFormula(formula, cells);
          return res.kind === "ok" ? res.value : res.code;
        };
        expect({
          zone,
          doneBeforeDue: result("=Done < Due"),
          hoursFromDoneToDue: result(`=DATEDIFF(Done, Due, "h")`),
          hoursFromMidnight: result(`=DATEDIFF(Due, "2026-10-12 00:00", "h")`),
          daysAcrossDst: result(`=DATEDIFF("2026-10-20", "2026-11-03")`),
          // Text without an offset is local time, so a date against a UTC
          // timestamp depends on the zone, the same way for both.
          utcHoursAfterDue: result(`=DATEDIFF(Due, Utc, "h")`),
          dueBeforeUtc: result("=Due < Utc"),
        }).toEqual({
          zone,
          doneBeforeDue: 1,
          hoursFromDoneToDue: 4,
          hoursFromMidnight: 0,
          daysAcrossDst: 14,
          utcHoursAfterDue,
          dueBeforeUtc: utcHoursAfterDue > 0 ? 1 : 0,
        });
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  test("DATEDIFF returns 0 for same date", () => {
    expectOk(evaluateFormula(`=DATEDIFF("2026-05-12", "2026-05-12")`, c), 0);
  });

  test("DATEDIFF rejects invalid date input", () => {
    expectError(evaluateFormula(`=DATEDIFF("not-a-date", "2026-01-01")`, c), "PARSE_ERROR");
    expectError(evaluateFormula(`=DATEDIFF("2026-01-01", "garbage")`, c), "PARSE_ERROR");
  });

  test("DATEDIFF rejects unknown unit", () => {
    expectError(evaluateFormula(`=DATEDIFF("2026-01-01", "2026-01-02", "weeks")`, c), "PARSE_ERROR");
  });

  test("DATEDIFF arg count", () => {
    expectError(evaluateFormula(`=DATEDIFF("2026-01-01")`, c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula(`=DATEDIFF("2026-01-01", "2026-01-02", "d", "extra")`, c), "WRONG_ARG_COUNT");
  });
});

// =============================================================================
// Comparison + equality
// =============================================================================

describe("comparison operators", () => {
  const c = ctx(["a", "b", "name"], [["10", "20", "alice"]]);

  test("numeric comparisons return 1 / 0", () => {
    expectOk(evaluateFormula("=a < b", c), 1);
    expectOk(evaluateFormula("=a >= b", c), 0);
    expectOk(evaluateFormula("=a == 10", c), 1);
    expectOk(evaluateFormula("=a != 11", c), 1);
  });

  test("string equality", () => {
    expectOk(evaluateFormula(`=name == "alice"`, c), 1);
    expectOk(evaluateFormula(`=name == "bob"`, c), 0);
  });

  test("equality works across coercions", () => {
    // "10" (string) vs 10 (number) — both look numeric, compare as numbers
    const n = ctx(["s"], [["10"]]);
    expectOk(evaluateFormula(`=s == 10`, n), 1);
  });

  test("non-numeric ordering errors", () => {
    expectError(evaluateFormula(`=name < 10`, c), "NON_NUMERIC");
  });

  test("ISO dates compare by day, not by their leading year", () => {
    const d = ctx(["Deadline", "Done"], [["2026-10-12", "2026-03-01"]]);
    expectOk(evaluateFormula(`=Deadline < "2026-12-24"`, d), 1);
    expectOk(evaluateFormula(`=Deadline > "2026-12-24"`, d), 0);
    expectOk(evaluateFormula(`=Deadline >= "2026-10-12"`, d), 1);
    expectOk(evaluateFormula(`=Deadline <= "2026-10-11"`, d), 0);
    expectOk(evaluateFormula(`=Done < Deadline`, d), 1);
    expectOk(evaluateFormula(`=Deadline == "2026-12-24"`, d), 0);
    expectOk(evaluateFormula(`=Deadline != "2026-12-24"`, d), 1);
    expectOk(evaluateFormula(`=Deadline == "2026-10-12"`, d), 1);
    expectOk(evaluateFormula(`=IF(Deadline < "2027-01-01", "this year", "later")`, d), "this year");
  });

  test("dates compare with TODAY() and NOW()", () => {
    const day = (offset: number) => {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      const pad = (n: number) => n.toString().padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };
    // Two days ahead, so the test also passes when midnight falls between
    // building the row and evaluating NOW().
    const d = ctx(["Past", "Future"], [[day(-1), day(2)]]);
    expectOk(evaluateFormula(`=Past < TODAY()`, d), 1);
    expectOk(evaluateFormula(`=Future < TODAY()`, d), 0);
    expectOk(evaluateFormula(`=Future > NOW()`, d), 1);
    expectOk(evaluateFormula(`=TODAY() == TODAY()`, d), 1);
  });

  test("timestamps compare by time and against dates", () => {
    const d = ctx(["Opened", "Closed", "Day", "Utc"], [["2026-10-12 09:30", "2026-10-12T17:05:00", "2026-10-12", "2026-10-12T10:00:00Z"]]);
    expectOk(evaluateFormula(`=Opened < Closed`, d), 1);
    expectOk(evaluateFormula(`=Opened > Day`, d), 1);
    expectOk(evaluateFormula(`=Day == "2026-10-12T00:00"`, d), 1);
    expectOk(evaluateFormula(`=Utc == "2026-10-12T12:00:00+02:00"`, d), 1);
    expectOk(evaluateFormula(`=Utc < "2026-10-12T12:00:01+02:00"`, d), 1);
  });

  test("a date never compares with its leading number", () => {
    const d = ctx(["Date", "Name"], [["2026-10-12", "2026 plan"]]);
    expectOk(evaluateFormula(`=Date == 2026`, d), 0);
    expectOk(evaluateFormula(`=Date != 2026`, d), 1);
    expectOk(evaluateFormula(`=Date == Name`, d), 0);
    expectError(evaluateFormula(`=Date > 2025`, d), "TYPE_ERROR");
    expectError(evaluateFormula(`=Date < "soon"`, d), "TYPE_ERROR");
    expectError(evaluateFormula(`=Date < Name`, d), "TYPE_ERROR");
  });

  test("text that only looks like a date stays text", () => {
    const d = ctx(["Date"], [["2026-13-45"]]);
    expectOk(evaluateFormula(`=Date == "2026-13-45"`, d), 1);
    expectOk(evaluateFormula(`=Date < 2027`, d), 1);
  });

  test("text compares as text unless the other side is a number", () => {
    const t = ctx(["Version", "Fruit", "Price", "Cheap"], [["1.2.3", "3 apples", "5 €", "4 €"]]);
    expectOk(evaluateFormula(`=Version == "1.2.4"`, t), 0);
    expectOk(evaluateFormula(`=Version == "1.2.3"`, t), 1);
    expectOk(evaluateFormula(`=Fruit == "3 pears"`, t), 0);
    expectOk(evaluateFormula(`=Fruit != "3 pears"`, t), 1);
    expectOk(evaluateFormula(`=Price == 5`, t), 1);
    expectOk(evaluateFormula(`=Price > 3`, t), 1);
    expectOk(evaluateFormula(`=Cheap < Price`, t), 1);
    expectOk(evaluateFormula(`="10" == "10.0"`, t), 1);
    // Ordering reads the amount, so two texts for the same amount are
    // neither smaller nor greater, while == still tells the texts apart.
    expectOk(evaluateFormula(`=Price <= "5.00 €"`, t), 1);
    expectOk(evaluateFormula(`=Price >= "5.00 €"`, t), 1);
    expectOk(evaluateFormula(`=Price == "5.00 €"`, t), 0);
  });

  test("equal infinite numbers order as equal", () => {
    expectOk(evaluateFormula("=POW(10, 1000) >= POW(10, 1000)", c), 1);
    expectOk(evaluateFormula("=POW(10, 1000) <= POW(10, 1000)", c), 1);
    expectOk(evaluateFormula("=POW(10, 1000) > POW(10, 1000)", c), 0);
    expectOk(evaluateFormula("=a >= a", ctx(["a"], [["1e400"]])), 1);
  });
});

// =============================================================================
// Unknown function — suggestion
// =============================================================================

describe("unknown function", () => {
  test("UNKNOWN_FUNCTION with did-you-mean", () => {
    const res = evaluateFormula("=SUMM(a)", ctx(["a"], [["1"]]));
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.code).toBe("UNKNOWN_FUNCTION");
      expect(res.suggestion).toBe("SUM");
    }
  });

  test("totally unknown function — no suggestion", () => {
    const res = evaluateFormula("=ZZZBOOM(a)", ctx(["a"], [["1"]]));
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.code).toBe("UNKNOWN_FUNCTION");
      expect(res.suggestion).toBeUndefined();
    }
  });
});

// =============================================================================
// End-to-end realistic formulas
// =============================================================================

describe("realistic scenarios", () => {
  test("invoice line: tax = price × 0.19", () => {
    const c = ctx(["price"], [["100"], ["200"]], 1);
    expectOk(evaluateFormula("=price * 0.19", c), 38);
  });

  test("invoice total: SUM(total)", () => {
    const c = ctx(
      ["price", "total"],
      [
        ["100", "119"],
        ["200", "238"],
      ],
    );
    expectOk(evaluateFormula("=SUM(total)", c), 357);
  });

  test("conditional discount", () => {
    const c = ctx(["qty", "price"], [["50", "10"]]);
    expectOk(evaluateFormula(`=IF(qty > 10, price * qty * 0.9, price * qty)`, c), 450);
  });

  test("display a status badge with fallback", () => {
    const c = ctx(["status"], [[""]]);
    expectOk(evaluateFormula(`=UPPER(IFEMPTY(status, "draft"))`, c), "DRAFT");
  });

  test("safe divide with IFERROR", () => {
    const c = ctx(["total", "qty"], [["100", "0"]]);
    expectOk(evaluateFormula(`=IFERROR(total / qty, "—")`, c), "—");
  });

  test("ROUND of an aggregate", () => {
    const c = ctx(["x"], [["1.111"], ["2.222"], ["3.333"]]);
    expectOk(evaluateFormula("=ROUND(AVG(x), 2)", c), 2.22);
  });

  test("CONCAT with column refs + literal", () => {
    const c = ctx(["first", "last"], [["Ada", "Lovelace"]]);
    expectOk(evaluateFormula(`=CONCAT(first, " ", last)`, c), "Ada Lovelace");
  });
});

// =============================================================================
// Formula-in-formula resolution + cycle detection
// =============================================================================

describe("formula-in-formula resolution", () => {
  test("col-ref to a formula cell evaluates the formula", () => {
    // total = =hours * rate, then tax = total * 0.19
    const c = ctx(["hours", "rate", "total"], [["10", "50", "=hours * rate"]], 0, 0);
    // Reference "total" from a formula → recursive eval → 500
    expectOk(evaluateFormula("=total * 0.19", c), 95);
  });

  test("aggregate over a column of formulas", () => {
    // Each row's total is a formula; SUM(total) should compute each
    const c = ctx(
      ["hours", "rate", "total"],
      [
        ["10", "50", "=hours * rate"],
        ["20", "60", "=hours * rate"],
        ["5", "100", "=hours * rate"],
      ],
    );
    expectOk(evaluateFormula("=SUM(total)", c), 500 + 1200 + 500);
  });

  test("ROWSUM picks up formula cells in this row", () => {
    // Row has [10, =a + 5, 20]; ROWSUM at col 0 → eval col 1 (15) + col 2 (20) = 35
    const c = ctx(["a", "b", "c"], [["10", "=a + 5", "20"]], 0, 0);
    expectOk(evaluateFormula("=ROWSUM()", c), 35);
  });

  test("circular reference is detected", () => {
    // a → b → a
    const c = ctx(["a", "b"], [["=b", "=a"]], 0, 0);
    expectError(evaluateFormula("=a", c), "CIRCULAR_REF");
  });

  test("self-referential formula errors", () => {
    // a column references itself
    const c = ctx(["a"], [["=a"]], 0, 0);
    expectError(evaluateFormula("=a", c), "CIRCULAR_REF");
  });

  test("aggregate skips circular cells silently", () => {
    // Column has two valid + one circular; SUM should ignore the cycle
    const c = ctx(
      ["a", "b"],
      [
        ["10", "=a"],
        ["20", "=b"], // circular: b references b
        ["30", "=a + 5"],
      ],
    );
    // SUM(b): row0 b=a=10, row1 cycle skipped, row2 b=a+5=35. Total: 45.
    expectOk(evaluateFormula("=SUM(b)", c), 45);
  });

  test("non-numeric formula result is preserved through chaining", () => {
    const c = ctx(["a", "b"], [["hello", `=UPPER(a)`]], 0, 0);
    expectOk(evaluateFormula("=b", c), "HELLO");
  });
});

// =============================================================================
// Backtick-quoted column names (for headers with spaces / special chars)
// =============================================================================

describe("backtick-quoted column references", () => {
  test("references a column with spaces", () => {
    const c = ctx(["Tax (19%)", "other"], [["100", "x"]], 0, 0);
    expectOk(evaluateFormula("=`Tax (19%)`", c), 100);
  });

  test("backtick ident in function arg", () => {
    const c = ctx(["Total Cost"], [["100"], ["200"], ["300"]]);
    expectOk(evaluateFormula("=SUM(`Total Cost`)", c), 600);
  });

  test("backtick supports escapes for literal backtick", () => {
    const c = ctx(["weird `name"], [["42"]], 0, 0);
    expectOk(evaluateFormula("=`weird \\`name`", c), 42);
  });

  test("unterminated backtick is a parse error", () => {
    const c = ctx(["a"], [["1"]]);
    expectError(evaluateFormula("=`unterm", c), "PARSE_ERROR");
  });

  test("backtick + arithmetic", () => {
    const c = ctx(["Hours per Day", "rate"], [["8", "50"]], 0, 0);
    expectOk(evaluateFormula("=`Hours per Day` * rate", c), 400);
  });
});

// =============================================================================
// MEDIAN + PERCENT
// =============================================================================

describe("MEDIAN", () => {
  test("median of odd-length numeric column", () => {
    const c = ctx(["x"], [["1"], ["3"], ["2"], ["5"], ["4"]]);
    expectOk(evaluateFormula("=MEDIAN(x)", c), 3);
  });

  test("median of even-length numeric column", () => {
    const c = ctx(["x"], [["1"], ["2"], ["3"], ["4"]]);
    // (2 + 3) / 2 = 2.5
    expectOk(evaluateFormula("=MEDIAN(x)", c), 2.5);
  });

  test("median ignores non-numeric cells", () => {
    const c = ctx(["x"], [["1"], ["x"], ["3"], [""], ["5"]]);
    // numeric: [1, 3, 5] → median 3
    expectOk(evaluateFormula("=MEDIAN(x)", c), 3);
  });

  test("median of empty column returns 0", () => {
    const c = ctx(["x"], []);
    expectOk(evaluateFormula("=MEDIAN(x)", c), 0);
  });
});

describe("PERCENT", () => {
  test("PERCENT computes part / total × 100", () => {
    const c = ctx(["a"], [["1"]]);
    expectOk(evaluateFormula("=PERCENT(25, 200)", c), 12.5);
  });

  test("PERCENT rounds to 2 decimals", () => {
    const c = ctx(["a"], [["1"]]);
    // 1/3 = 33.333... → 33.33
    expectOk(evaluateFormula("=PERCENT(1, 3)", c), 33.33);
  });

  test("PERCENT with column refs", () => {
    const c = ctx(["price", "total"], [["50", "200"]]);
    expectOk(evaluateFormula("=PERCENT(price, total)", c), 25);
  });

  test("PERCENT division by zero", () => {
    const c = ctx(["a"], [["1"]]);
    expectError(evaluateFormula("=PERCENT(5, 0)", c), "DIV_BY_ZERO");
  });

  test("PERCENT with non-numeric arg", () => {
    const c = ctx(["a"], [["1"]]);
    expectError(evaluateFormula(`=PERCENT("foo", 100)`, c), "NON_NUMERIC");
  });
});

describe("PROGRESS", () => {
  test("PROGRESS renders a ratio", () => {
    const c = ctx(["a"], [["1"]]);
    expectProgress(evaluateFormula("=PROGRESS(0.4)", c), 0.4, "40%");
  });

  test("PROGRESS renders done / total", () => {
    const c = ctx(["done", "total"], [["2", "10"]]);
    expectProgress(evaluateFormula("=PROGRESS(done, total)", c), 0.2, "2/10");
  });

  test("PROGRESS clamps visual ratio", () => {
    const c = ctx(["a"], [["1"]]);
    expectProgress(evaluateFormula("=PROGRESS(2)", c), 1, "100%");
    expectProgress(evaluateFormula("=PROGRESS(-1)", c), 0, "0%");
  });

  test("PROGRESS validates arguments", () => {
    const c = ctx(["a"], [["1"]]);
    expectError(evaluateFormula("=PROGRESS()", c), "WRONG_ARG_COUNT");
    expectError(evaluateFormula(`=PROGRESS("x")`, c), "NON_NUMERIC");
    expectError(evaluateFormula("=PROGRESS(1, 0)", c), "DIV_BY_ZERO");
  });
});

describe("isTotalRow", () => {
  test("label + empty cells + single =SUM is a total row", () => {
    // User's exact scenario: only the formula counts toward the ratio.
    expect(isTotalRow(["Sum", "", "", "=SUM(price)"])).toBe(true);
  });

  test("row of pure literals is not a total row", () => {
    expect(isTotalRow(["10", "20", "30"])).toBe(false);
  });

  test("row with single non-aggregate formula is not a total row", () => {
    expect(isTotalRow(["10", "20", "=hours * rate"])).toBe(false);
  });

  test("row with mixed aggregate + arithmetic — ratio ≥ 0.5 → true", () => {
    expect(isTotalRow(["Total", "=SUM(qty)", "=SUM(price)", "=hours * rate"])).toBe(true);
  });

  test("row with mostly arithmetic formulas — ratio < 0.5 → false", () => {
    expect(isTotalRow(["=a+b", "=a*c", "=SUM(d)"])).toBe(false);
  });

  test("ROWSUM / ROWAVG count as aggregates", () => {
    expect(isTotalRow(["Row total", "=ROWSUM"])).toBe(true);
    expect(isTotalRow(["Row avg", "=ROWAVG"])).toBe(true);
  });

  test("MEDIAN counts as aggregate", () => {
    expect(isTotalRow(["Median", "=MEDIAN(price)"])).toBe(true);
  });

  test("aggregate function name is case-insensitive", () => {
    expect(isTotalRow(["Total", "=sum(price)"])).toBe(true);
    expect(isTotalRow(["Total", "=Avg(price)"])).toBe(true);
  });

  test("leading whitespace after `=` is tolerated", () => {
    // `slice(1).trim()` strips the space between `=` and the function name.
    expect(isTotalRow(["Total", "=  SUM(price)"])).toBe(true);
  });

  test("PERCENT is NOT considered an aggregate (it's pairwise math)", () => {
    expect(isTotalRow(["Tax %", "=PERCENT(tax, total)"])).toBe(false);
  });

  test("empty row is not a total row", () => {
    expect(isTotalRow([])).toBe(false);
  });

  test("row of all-empty cells is not a total row", () => {
    expect(isTotalRow(["", "", ""])).toBe(false);
  });

  test("ratio threshold — exactly 0.5 → true", () => {
    expect(isTotalRow(["=SUM(a)", "=b+c"])).toBe(true);
  });
});
