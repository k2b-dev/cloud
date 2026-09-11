import { expect, spyOn, test } from "bun:test";
import Decimal from "decimal.js";
import { numberHandler } from "./number";

test("number: rejects out-of-range exponents before expanding decimal text", () => {
  const expanded = spyOn(Decimal.prototype, "toFixed").mockImplementation(() => {
    throw new Error("Out-of-range decimal must not be expanded");
  });
  try {
    for (const value of ["1e1000000000", "1e-1000000000", "1e131072", "1e-16384"]) {
      expect(numberHandler.validate(value, {}, false)).toEqual({
        ok: false,
        error: "outside the supported numeric range (131072 integer digits, 16383 decimal places)",
      });
      expect(numberHandler.configSchema.safeParse({ min: value }).success).toBe(false);
    }
    expect(expanded).not.toHaveBeenCalled();
  } finally {
    expanded.mockRestore();
  }
});

test("number: accepts values at the supported numeric boundaries", () => {
  expect(numberHandler.validate("1e131071", {}, false)).toEqual({ ok: true, value: `1${"0".repeat(131071)}` });
  expect(numberHandler.validate("1e-16383", {}, false)).toEqual({ ok: true, value: `0.${"0".repeat(16382)}1` });
});

test("number: accepts numeric input and string-of-number", () => {
  expect(numberHandler.validate(42, {}, false)).toEqual({ ok: true, value: "42" });
  expect(numberHandler.validate("42", {}, false)).toEqual({ ok: true, value: "42" });
  expect(numberHandler.validate("3.14", {}, false)).toEqual({ ok: true, value: "3.14" });
});

test("number: empty/null collapse to null when not required", () => {
  expect(numberHandler.validate(null, {}, false)).toEqual({ ok: true, value: null });
  expect(numberHandler.validate("", {}, false)).toEqual({ ok: true, value: null });
});

test("number: required rejects null/empty", () => {
  expect(numberHandler.validate(null, {}, true).ok).toBe(false);
  expect(numberHandler.validate("", {}, true).ok).toBe(false);
});

test("number: rejects non-finite (Infinity, NaN)", () => {
  expect(numberHandler.validate(Number.POSITIVE_INFINITY, {}, false).ok).toBe(false);
  expect(numberHandler.validate(NaN, {}, false).ok).toBe(false);
  expect(numberHandler.validate("not-a-number", {}, false).ok).toBe(false);
});

test("number: enforces min/max", () => {
  expect(numberHandler.validate(5, { min: 10 }, false).ok).toBe(false);
  expect(numberHandler.validate(20, { max: 10 }, false).ok).toBe(false);
  expect(numberHandler.validate(5, { min: "0", max: "10" }, false)).toEqual({ ok: true, value: "5" });
});

test("number: integerOnly rejects floats", () => {
  expect(numberHandler.validate(3.14, { integerOnly: true }, false).ok).toBe(false);
  expect(numberHandler.validate(3, { integerOnly: true }, false)).toEqual({ ok: true, value: "3" });
});

test("number: fixed decimal places canonicalize to strings", () => {
  expect(numberHandler.validate("123.4", { precision: 10, decimalPlaces: 2 }, false)).toEqual({ ok: true, value: "123.40" });
  expect(numberHandler.validate("123", { precision: 10, decimalPlaces: 2 }, false)).toEqual({ ok: true, value: "123.00" });
  expect(numberHandler.validate(123.45, { precision: 10, decimalPlaces: 2 }, false)).toEqual({ ok: true, value: "123.45" });
});

test("number: rejects too many decimal places when configured", () => {
  expect(numberHandler.validate("123.456", { precision: 10, decimalPlaces: 2 }, false).ok).toBe(false);
});

test("number: rejects exceeding precision", () => {
  expect(numberHandler.validate("12345678901.23", { precision: 10, decimalPlaces: 2 }, false).ok).toBe(false);
});

test("number: rejects integer side exceeding precision-decimalPlaces", () => {
  expect(numberHandler.validate("1000", { precision: 5, decimalPlaces: 2 }, false).ok).toBe(false);
  expect(numberHandler.validate("999", { precision: 5, decimalPlaces: 2 }, false)).toEqual({ ok: true, value: "999.00" });
});

test("number: zero is valid for fully-fractional precision", () => {
  expect(numberHandler.validate("0", { precision: 2, decimalPlaces: 2 }, false)).toEqual({ ok: true, value: "0.00" });
  expect(numberHandler.validate("0.50", { precision: 2, decimalPlaces: 2 }, false)).toEqual({ ok: true, value: "0.50" });
  expect(numberHandler.validate("1", { precision: 2, decimalPlaces: 2 }, false).ok).toBe(false);
});

test("number: accepts display-only unit config", () => {
  expect(
    numberHandler.configSchema.safeParse({
      precision: 16,
      decimalPlaces: 2,
      unit: "EUR",
      unitPosition: "suffix",
    }).success,
  ).toBe(true);
});

test("number: does not persist legacy scale config", () => {
  const parsed = numberHandler.configSchema.safeParse({ scale: 2 });

  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data).toEqual({});
  expect(numberHandler.validate("123.456", { scale: 2 }, false)).toEqual({ ok: true, value: "123.456" });
});

test("number: preserves precision as decimal strings", () => {
  expect(numberHandler.validate("0.30", { precision: 10, decimalPlaces: 2 }, false)).toEqual({ ok: true, value: "0.30" });
});
