import Decimal from "decimal.js";
import { type FormulaFunction, type FormulaFunctionReturn, formulaNumber } from "./function-runtime";
import {
  decimalResult,
  divideDecimals,
  exactDecimalOperation,
  FORMULA_ROUND_PLACES,
  FormulaDecimal,
  isNullish,
  powerDecimal,
  sqrtDecimal,
  toDecimalValue,
} from "./numeric";
import { formulaError, isFormulaError } from "./types";

const decimalArgs = (args: unknown[]) => {
  const values = args.map(toDecimalValue).filter((value): value is NonNullable<ReturnType<typeof toDecimalValue>> => value !== null);
  return { values, exact: values.some((value) => value.exact) };
};

const oneDecimal = (value: unknown): NonNullable<ReturnType<typeof toDecimalValue>> | null => toDecimalValue(value);
const numericResult = (value: Decimal, exact: boolean): FormulaFunctionReturn => decimalResult(value, exact);

const sumDecimals = (values: Array<{ decimal: Decimal }>) => {
  let sum: Decimal = new FormulaDecimal(0);
  for (const value of values) {
    const next = exactDecimalOperation(sum, value.decimal, "+");
    if (isFormulaError(next)) return next;
    sum = next;
  }
  return sum;
};

const average: FormulaFunction = (args) => {
  const { values, exact } = decimalArgs(args);
  if (values.length === 0) return null;
  const sum = sumDecimals(values);
  if (isFormulaError(sum)) return sum;
  const value = divideDecimals(sum, new FormulaDecimal(values.length));
  return isFormulaError(value) ? value : numericResult(value, exact);
};

export const MATH_FORMULA_FUNCTIONS: Record<string, FormulaFunction> = {
  ABS: ([value]) => {
    const decimal = oneDecimal(value);
    return decimal === null ? null : numericResult(decimal.decimal.abs(), decimal.exact);
  },
  ROUND: ([value, places]) => {
    const decimal = oneDecimal(value);
    if (decimal === null) return null;
    const requestedPlaces = (oneDecimal(places)?.decimal ?? new FormulaDecimal(formulaNumber(places) ?? 0)).trunc();
    if (requestedPlaces.lt(FORMULA_ROUND_PLACES.min) || requestedPlaces.gt(FORMULA_ROUND_PLACES.max))
      return formulaError("ROUND_BAD_PLACES");
    const placesInt = requestedPlaces.toNumber();
    if (placesInt < 0) {
      const factor = new FormulaDecimal(`1e${-placesInt}`);
      return numericResult(decimal.decimal.toNearest(factor, Decimal.ROUND_HALF_UP), decimal.exact);
    }
    return numericResult(decimal.decimal.toDecimalPlaces(placesInt, Decimal.ROUND_HALF_UP), decimal.exact);
  },
  FLOOR: ([value]) => {
    const decimal = oneDecimal(value);
    return decimal === null ? null : numericResult(decimal.decimal.floor(), decimal.exact);
  },
  CEIL: ([value]) => {
    const decimal = oneDecimal(value);
    return decimal === null ? null : numericResult(decimal.decimal.ceil(), decimal.exact);
  },
  SQRT: ([value]) => {
    const decimal = oneDecimal(value);
    if (decimal === null) return null;
    const result = sqrtDecimal(decimal.decimal);
    return isFormulaError(result) ? result : numericResult(result, decimal.exact);
  },
  POW: ([base, exponent]) => {
    const left = oneDecimal(base);
    const right = oneDecimal(exponent);
    if (left === null || right === null) return null;
    const result = powerDecimal(left.decimal, right.decimal);
    return isFormulaError(result) ? result : numericResult(result, left.exact || right.exact);
  },
  MOD: ([dividend, divisor]) => {
    const left = oneDecimal(dividend);
    const right = oneDecimal(divisor);
    if (left === null || right === null) return null;
    if (right.decimal.isZero()) return formulaError("DIV_ZERO");
    const value = exactDecimalOperation(left.decimal, right.decimal, "%");
    return isFormulaError(value) ? value : numericResult(value, left.exact || right.exact);
  },
  SUM: (args) => {
    const { values, exact } = decimalArgs(args);
    if (values.length === 0) return null;
    const sum = sumDecimals(values);
    return isFormulaError(sum) ? sum : numericResult(sum, exact);
  },
  AVG: average,
  MEAN: average,
  COUNT: (args) => args.filter((value) => !isNullish(value) && value !== "").length,
  MEDIAN: (args) => {
    const { values, exact } = decimalArgs(args);
    if (values.length === 0) return null;
    const sorted = values.map((value) => value.decimal).sort((left, right) => left.comparedTo(right));
    const middle = Math.floor(sorted.length / 2);
    let value = sorted[middle]!;
    if (sorted.length % 2 === 0) {
      const sum = exactDecimalOperation(sorted[middle - 1]!, value, "+");
      if (isFormulaError(sum)) return sum;
      const divided = divideDecimals(sum, new FormulaDecimal(2));
      if (isFormulaError(divided)) return divided;
      value = divided;
    }
    return numericResult(value, exact);
  },
  MIN: (args) => {
    const { values, exact } = decimalArgs(args);
    return values.length === 0 ? null : numericResult(FormulaDecimal.min(...values.map((value) => value.decimal)), exact);
  },
  MAX: (args) => {
    const { values, exact } = decimalArgs(args);
    return values.length === 0 ? null : numericResult(FormulaDecimal.max(...values.map((value) => value.decimal)), exact);
  },
  PERCENT: ([part, total]) => {
    const numerator = oneDecimal(part);
    const denominator = oneDecimal(total);
    if (numerator === null || denominator === null) return null;
    if (denominator.decimal.isZero()) return formulaError("DIV_ZERO");
    const divided = divideDecimals(numerator.decimal, denominator.decimal);
    if (isFormulaError(divided)) return divided;
    const value = exactDecimalOperation(divided, new FormulaDecimal(100), "*");
    return isFormulaError(value) ? value : numericResult(value, numerator.exact || denominator.exact);
  },
};
