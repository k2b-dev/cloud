import { expect, spyOn, test } from "bun:test";
import {
  decimalResult,
  divideDecimals,
  exactDecimalOperation,
  FormulaDecimal,
  integerPowerDecimal,
  powerDecimal,
  sqrtDecimal,
} from "./numeric";
import { formulaError, isFormulaError } from "./types";

test("integer powers retain all integer digits and bound extreme results", () => {
  const large = integerPowerDecimal(new FormulaDecimal(2), 300);
  if (isFormulaError(large)) throw new Error(large.code);
  expect(large.toFixed()).toBe((2n ** 300n).toString());
  const compounded = integerPowerDecimal(new FormulaDecimal("1.01"), 37);
  if (isFormulaError(compounded)) throw new Error(compounded.code);
  expect(compounded.toFixed()).toBe("1.4450764714274963");
  expect(integerPowerDecimal(new FormulaDecimal(2), 2_147_483_647)).toEqual(formulaError("VALUE_TOO_LARGE"));
  const tiny = integerPowerDecimal(new FormulaDecimal(2), -2_147_483_648);
  if (isFormulaError(tiny)) throw new Error(tiny.code);
  expect(tiny.isZero()).toBe(true);
  expect(integerPowerDecimal(new FormulaDecimal("1e1000000000"), 2)).toEqual(formulaError("VALUE_TOO_LARGE"));
  expect(integerPowerDecimal(new FormulaDecimal(0), -1)).toEqual(formulaError("NON_NUMERIC"));
});

test("general powers bound overflow, underflow and invalid domains", () => {
  expect(powerDecimal(new FormulaDecimal(10), new FormulaDecimal("1000000.5"))).toEqual(formulaError("VALUE_TOO_LARGE"));
  expect(powerDecimal(new FormulaDecimal(-2), new FormulaDecimal("0.5"))).toEqual(formulaError("NON_NUMERIC"));
  expect(powerDecimal(new FormulaDecimal(0), new FormulaDecimal("-0.5"))).toEqual(formulaError("NON_NUMERIC"));
  const tiny = powerDecimal(new FormulaDecimal(10), new FormulaDecimal("-1000000.5"));
  if (isFormulaError(tiny)) throw new Error(tiny.code);
  expect(tiny.isZero()).toBe(true);
  for (const source of ["Infinity", "NaN", "1e1000000000", "1e-1000000000"]) {
    expect(powerDecimal(new FormulaDecimal(source), new FormulaDecimal("0.5"))).toEqual(formulaError("VALUE_TOO_LARGE"));
  }
});

test("square roots preserve scale parity and reject invalid inputs before calculation", () => {
  for (const source of ["2", "2.00000000000000000000"]) {
    const result = sqrtDecimal(new FormulaDecimal(source));
    if (isFormulaError(result)) throw new Error(result.code);
    expect(result.toFixed()).toBe("1.414213562373095");
  }
  expect(sqrtDecimal(new FormulaDecimal(-1))).toEqual(formulaError("NON_NUMERIC"));
  for (const source of ["Infinity", "NaN", "1e1000000000", "1e-1000000000"]) {
    expect(sqrtDecimal(new FormulaDecimal(source))).toEqual(formulaError("VALUE_TOO_LARGE"));
  }
});

test("rejects oversized finite results before allocating their expanded text", () => {
  for (const source of ["1e1000000000", "1e-1000000000"]) {
    const value = new FormulaDecimal(source);
    const expanded = spyOn(value, "toFixed").mockImplementation(() => {
      throw new Error("must not expand an oversized result");
    });
    try {
      expect(decimalResult(value, true)).toEqual(formulaError("VALUE_TOO_LARGE"));
      expect(decimalResult(value, false)).toEqual(formulaError("VALUE_TOO_LARGE"));
      expect(expanded).not.toHaveBeenCalled();
    } finally {
      expanded.mockRestore();
    }
  }
});

test("division has a deterministic decimal scale independent of display zeroes", () => {
  for (const [left, right, expected] of [
    ["1", "3", "0.33333333333333333333"],
    ["1.000000000000000000000000000000", "3", "0.33333333333333333333"],
    ["-2", "3", "-0.66666666666666666667"],
    ["1", "8", "0.125"],
    ["0", "7", "0"],
    ["1e-1001", "1", "0"],
  ] as const) {
    const value = divideDecimals(new FormulaDecimal(left), new FormulaDecimal(right));
    if (isFormulaError(value)) throw new Error(value.code);
    expect(value.toFixed()).toBe(expected);
  }
  expect(divideDecimals(new FormulaDecimal(1), new FormulaDecimal(0))).toEqual(formulaError("DIV_ZERO"));
});

test("exact operations bound input and output to the supported numeric digit range", () => {
  const one = new FormulaDecimal(1);
  expect(isFormulaError(exactDecimalOperation(new FormulaDecimal("1e131072"), one, "+"))).toBe(true);
  expect(isFormulaError(exactDecimalOperation(new FormulaDecimal("1e-16384"), one, "+"))).toBe(true);
  expect(isFormulaError(exactDecimalOperation(new FormulaDecimal("1e131071"), new FormulaDecimal(10), "*"))).toBe(true);
  const maximum = exactDecimalOperation(new FormulaDecimal("1e131071"), new FormulaDecimal("1e131071"), "+");
  if (isFormulaError(maximum)) throw new Error("supported large result rejected");
  expect(maximum.eq("2e131071")).toBe(true);
  const minimum = exactDecimalOperation(new FormulaDecimal("1e-16383"), one, "*");
  if (isFormulaError(minimum)) throw new Error("supported fractional result rejected");
  expect(minimum.eq("1e-16383")).toBe(true);
});
