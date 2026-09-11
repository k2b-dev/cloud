import Decimal from "decimal.js";
import { formulaError } from "./types";

// Independent from decimal.js's process-global default (20 significant digits).
// Finite basic operations below increase precision from their operands;
// division and square roots follow PostgreSQL's scale policy below; other mathematical
// functions use this default unless their intermediate required more precision.
export const FormulaDecimal = Decimal.clone({ precision: 80 });

// PostgreSQL numeric's supported integer/fractional digit range. ROUND must
// validate before constructing powers or casting its scale to a SQL integer.
export const FORMULA_ROUND_PLACES = { min: -131_072, max: 16_383 } as const;

export const fitsNumericRange = (value: Decimal): boolean =>
  value.isFinite() && value.e < -FORMULA_ROUND_PLACES.min && value.decimalPlaces() <= FORMULA_ROUND_PLACES.max;

/** Finite decimal arithmetic must not round away digits before a later cancellation. */
export const exactDecimalOperation = (left: Decimal, right: Decimal, operation: "+" | "-" | "*" | "%") => {
  if (!fitsNumericRange(left) || !fitsNumericRange(right)) return formulaError("VALUE_TOO_LARGE");
  const precision =
    operation === "*"
      ? left.precision() + right.precision()
      : Math.max(0, left.e + 1, right.e + 1) + Math.max(left.decimalPlaces(), right.decimalPlaces()) + 1;
  // At most twice the supported numeric digit range for one operation. Keep
  // the ordinary division/function precision when the exact result is small.
  const CalculationDecimal = precision <= 80 ? FormulaDecimal : Decimal.clone({ precision });
  const value = new CalculationDecimal(left);
  const result =
    operation === "+"
      ? value.plus(right)
      : operation === "-"
        ? value.minus(right)
        : operation === "*"
          ? value.times(right)
          : value.mod(right);
  return fitsNumericRange(result) ? result : formulaError("VALUE_TOO_LARGE");
};

const TruncatedEstimateDecimal = Decimal.clone({ precision: 1, rounding: Decimal.ROUND_DOWN });

/** Integer powers retain every integer digit and at least 16 decimal places. */
export const integerPowerDecimal = (base: Decimal, exponent: number) => {
  if (!fitsNumericRange(base)) return formulaError("VALUE_TOO_LARGE");
  if (!Number.isInteger(exponent) || exponent < -2_147_483_648 || exponent > 2_147_483_647) return formulaError("NON_NUMERIC");
  if (exponent === 0) return new FormulaDecimal(1);
  if (base.isZero()) return exponent < 0 ? formulaError("NON_NUMERIC") : new FormulaDecimal(0);

  // PostgreSQL estimates the result's decimal weight from up to four
  // base-10000 digits. Only this scale estimate uses floating point;
  // the power itself stays decimal, including all integer result digits.
  const digits = base.abs().toExponential().split("e")[0]!.replace(".", "");
  const firstLength = base.e - Math.floor(base.e / 4) * 4 + 1;
  let leading = Number(digits.slice(0, firstLength).padEnd(firstLength, "0"));
  let shift = base.e - firstLength + 1;
  for (let offset = firstLength, group = 1; offset < digits.length && group < 4; offset += 4, group++) {
    leading = leading * 10_000 + Number(digits.slice(offset, offset + 4).padEnd(4, "0"));
    shift -= 4;
  }
  const weight = exponent * (Math.log10(leading) + shift);
  if (weight > -FORMULA_ROUND_PLACES.min) return formulaError("VALUE_TOO_LARGE");
  if (weight + 1 < -1_000) return new FormulaDecimal(0);
  const scale = Math.min(1_000, Math.max(16, base.decimalPlaces()));
  // Reserve the result's integer digits as well as its scale. Extra working
  // digits cover repeated multiplication; round only the final decimal value.
  const precision = Math.max(1, 1 + scale + Math.trunc(weight) + Math.trunc(Math.log(Math.abs(exponent))) + 8);
  const PowerDecimal = Decimal.clone({ precision, rounding: Decimal.ROUND_HALF_UP });
  const result = new PowerDecimal(base).pow(exponent).toDecimalPlaces(scale);
  return fitsNumericRange(result) ? result : formulaError("VALUE_TOO_LARGE");
};

/** Non-integer and larger exponents keep the formula engine's 80 significant digits. */
export const powerDecimal = (base: Decimal, exponent: Decimal) => {
  if (!fitsNumericRange(base) || !fitsNumericRange(exponent)) return formulaError("VALUE_TOO_LARGE");
  if (exponent.isInteger() && exponent.gte(-2_147_483_648) && exponent.lte(2_147_483_647))
    return integerPowerDecimal(base, exponent.toNumber());
  if (base.isZero()) return exponent.isNegative() ? formulaError("NON_NUMERIC") : new FormulaDecimal(0);
  if (base.isNegative() && !exponent.isInteger()) return formulaError("NON_NUMERIC");
  // PostgreSQL exp_var bounds exp * ln(base) below 6000. Match that
  // operation bound before calculating a compact but unsupported result.
  const logarithm = new FormulaDecimal(base.abs()).ln().times(exponent);
  if (logarithm.toNumber() >= 6_000) return formulaError("VALUE_TOO_LARGE");
  if (logarithm.toNumber() <= -6_000) return new FormulaDecimal(0);
  const result = new FormulaDecimal(base).pow(exponent).toDecimalPlaces(1_000);
  return fitsNumericRange(result) ? result : formulaError("VALUE_TOO_LARGE");
};

/** Match PostgreSQL numeric_sqrt after removing presentation-only input scale. */
export const sqrtDecimal = (value: Decimal) => {
  if (!fitsNumericRange(value)) return formulaError("VALUE_TOO_LARGE");
  if (value.isNegative() && !value.isZero()) return formulaError("NON_NUMERIC");
  if (value.isZero()) return new FormulaDecimal(0);
  // numeric_sqrt chooses 16 - (base-10000 weight * 2 + 1), bounded
  // to 0..1000 decimal places and at least the normalized input scale.
  const scale = Math.min(1_000, Math.max(0, 15 - Math.floor(value.e / 4) * 2, value.decimalPlaces()));
  const precision = Math.floor(value.e / 2) + 1 + scale;
  const result =
    precision <= 0
      ? new TruncatedEstimateDecimal(value).sqrt().toDecimalPlaces(scale, Decimal.ROUND_HALF_UP)
      : new (Decimal.clone({ precision, rounding: Decimal.ROUND_HALF_UP }))(value).sqrt();
  return fitsNumericRange(result) ? result : formulaError("VALUE_TOO_LARGE");
};

/** PostgreSQL numeric division after trim_scale on both operands (see numericDivideSql). */
export const divideDecimals = (left: Decimal, right: Decimal) => {
  if (!fitsNumericRange(left) || !fitsNumericRange(right)) return formulaError("VALUE_TOO_LARGE");
  if (right.isZero()) return formulaError("DIV_ZERO");
  if (left.isZero()) return new FormulaDecimal(0);
  // PostgreSQL select_div_scale uses base-10000 weights and leading digits,
  // retaining at least 16 significant digits, with a display scale of 0–1000.
  // https://doxygen.postgresql.org/backend_2utils_2adt_2numeric_8c_source.html
  const leading = (value: Decimal) => {
    const weight = Math.floor(value.e / 4);
    const length = value.e - weight * 4 + 1;
    const digits = value.abs().toExponential().split("e")[0]!.replace(".", "");
    return { weight, digit: Number(digits.slice(0, length).padEnd(length, "0")) };
  };
  const a = leading(left);
  const b = leading(right);
  const weight = a.weight - b.weight - (a.digit <= b.digit ? 1 : 0);
  const scale = Math.min(1_000, Math.max(0, 16 - weight * 4, left.decimalPlaces(), right.decimalPlaces()));
  const estimate = new TruncatedEstimateDecimal(left).div(right);
  const precision = estimate.e + 1 + scale;
  // For sub-scale values, one truncated digit is sufficient to decide whether
  // the value is below or at/above half a unit. Otherwise round only once at
  // the exact significant-digit position corresponding to the result scale.
  const result =
    precision <= 0
      ? estimate.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP)
      : new (Decimal.clone({ precision, rounding: Decimal.ROUND_HALF_UP }))(left).div(right);
  return fitsNumericRange(result) ? result : formulaError("VALUE_TOO_LARGE");
};

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

type DecimalValue = {
  decimal: Decimal;
  exact: boolean;
};

export const isNullish = (v: unknown): boolean => v === null || v === undefined;

export const isExactShaped = (v: unknown): boolean => {
  if (typeof v === "string") return NUMERIC_STRING.test(v);
  if (typeof v === "object" && v !== null && "amount" in v) return isExactShaped((v as { amount?: unknown }).amount);
  return false;
};

export const toNumber = (v: unknown): number | null => {
  if (isNullish(v)) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object" && v !== null && "amount" in v) return toNumber((v as { amount?: unknown }).amount);
  return null;
};

export const toDecimalValue = (v: unknown): DecimalValue | null => {
  if (isNullish(v)) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return { decimal: new FormulaDecimal(String(v)), exact: false };
  }
  if (typeof v === "string") {
    if (!NUMERIC_STRING.test(v)) return null;
    try {
      const decimal = new FormulaDecimal(v);
      return decimal.isFinite() ? { decimal, exact: true } : null;
    } catch {
      return null;
    }
  }
  if (typeof v === "boolean") return { decimal: new FormulaDecimal(v ? 1 : 0), exact: false };
  if (typeof v === "object" && v !== null && "amount" in v) return toDecimalValue((v as { amount?: unknown }).amount);
  return null;
};

export const decimalToString = (d: Decimal): string => d.toFixed();

export const decimalStringToCanonical = (value: string): string | null => {
  try {
    const decimal = new FormulaDecimal(value);
    return decimal.isFinite() ? decimalToString(decimal) : null;
  } catch {
    return null;
  }
};

export const decimalResult = (d: Decimal, exact: boolean): string | number | ReturnType<typeof formulaError> => {
  if (!d.isFinite()) return formulaError("NON_NUMERIC");
  // Exponential values can be compact in Decimal but enormous as fixed text.
  // Check the shared numeric range before conversion, including non-exact results.
  if (!fitsNumericRange(d)) return formulaError("VALUE_TOO_LARGE");
  if (!exact) {
    const value = d.toNumber();
    // Keep ordinary numeric results ergonomic, but never discard decimal
    // digits at the transport boundary. The next operation must see the same
    // value that was calculated, including for literal-only expressions.
    if (Number.isFinite(value) && d.eq(String(value))) return value;
  }
  return decimalToString(d);
};
