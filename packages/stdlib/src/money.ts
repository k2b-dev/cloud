import Big from "big.js";

/** JSON-safe money. amount is a signed safe integer in currency minor units. */
export type Money = { readonly amount: number; readonly currency: string };
export type MoneyRounding = "half-up" | "half-even" | "toward-zero";
export type MoneyRoundingOptions = { rounding: MoneyRounding };
export type MoneyDecimalOptions = { currency: string; rounding?: MoneyRounding };
export type MoneyParseOptions = MoneyDecimalOptions & { locale: string };
export type MoneyFormatOptions = { locale: string };
export type MoneyTaxOptions = MoneyRoundingOptions & { percent: string };
export type MoneyTax = { net: Money; tax: Money; gross: Money };

// Separate constructors keep application Big.DP/RM settings out of money math.
const Decimal = Big();
Decimal.DP = 0;
Decimal.RM = 0;
const roundingModes = { "half-up": 1, "half-even": 2, "toward-zero": 0 } as const;
let currencies: Set<string> | undefined;

function roundingMode(rounding: MoneyRounding): 0 | 1 | 2 {
  if (!Object.hasOwn(roundingModes, rounding)) throw new RangeError("Invalid money rounding mode");
  return roundingModes[rounding];
}

/** Currency precision from the runtime's Intl currency data; unknown codes fail. */
export function moneyCurrencyDigits(currency: string): number {
  currencies ??= new Set(Intl.supportedValuesOf("currency"));
  if (typeof currency !== "string" || !currencies.has(currency)) {
    throw new RangeError("Unsupported money currency; use an uppercase Intl currency code");
  }
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits!;
}

/** Validate a minor-unit amount, including values read from JSON. */
export function moneyFromMinor(amount: number, currency: string): Money {
  moneyCurrencyDigits(currency);
  if (!Number.isSafeInteger(amount)) throw new RangeError("Money amount must be a safe integer");
  return { amount: amount === 0 ? 0 : amount, currency };
}

function validate(value: Money): void {
  if (!value || typeof value !== "object") throw new TypeError("Expected a money value");
  moneyFromMinor(value.amount, value.currency);
}

function decimal(value: string): Big {
  if (typeof value !== "string" || value.trim() !== value || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new TypeError("Expected a decimal string without grouping, whitespace or exponent");
  }
  return new Decimal(value);
}

function finish(value: Big, currency: string): Money {
  if (!value.eq(value.round(0, 0)) || value.abs().gt(String(Number.MAX_SAFE_INTEGER))) {
    throw new RangeError("Money amount exceeds safe integer range");
  }
  return moneyFromMinor(Number(value.toFixed(0)), currency);
}

function quotient(value: Big, divisor: Big, rounding: MoneyRounding): Big {
  const mode = roundingMode(rounding);
  if (divisor.eq(0)) throw new RangeError("Cannot divide money by zero");
  // Divide once, directly to minor units. No finite-precision intermediate.
  const D = Big();
  D.DP = 0;
  D.RM = mode;
  return new D(value).div(divisor);
}

/** Parse canonical major units; excess fraction digits require explicit rounding. */
export function moneyFromDecimal(value: string, options: MoneyDecimalOptions): Money {
  const digits = moneyCurrencyDigits(options.currency);
  const parsed = decimal(value);
  const mode = options.rounding === undefined ? undefined : roundingMode(options.rounding);
  if ((value.split(".")[1]?.length ?? 0) > digits && mode === undefined) {
    throw new RangeError("Too many money fraction digits; specify rounding explicitly");
  }
  const scaled = parsed.times(new Decimal(10).pow(digits));
  return finish(mode === undefined ? scaled : scaled.round(0, mode), options.currency);
}

/** Exact fixed-decimal major units for CSV/export, without a Number conversion. */
export function moneyToDecimal(value: Money): string {
  validate(value);
  const digits = moneyCurrencyDigits(value.currency);
  const absolute = String(Math.abs(value.amount)).padStart(digits + 1, "0");
  const major = digits ? `${absolute.slice(0, -digits)}.${absolute.slice(-digits)}` : absolute;
  return value.amount < 0 ? `-${major}` : major;
}

function numberFormat(locale: string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  if (typeof locale !== "string" || !locale || Intl.NumberFormat.supportedLocalesOf([locale]).length === 0) {
    throw new RangeError("A supported explicit money locale is required");
  }
  return new Intl.NumberFormat(locale, options);
}

function localeDigits(locale: string): string[] {
  const formatter = numberFormat(locale, { useGrouping: false });
  return Array.from({ length: 10 }, (_, digit) => formatter.format(digit));
}

/** Parse a localized number (no currency symbol); grouped input must match Intl. */
export function moneyParse(value: string, options: MoneyParseOptions): Money {
  const formatter = numberFormat(options.locale, { maximumFractionDigits: 20 });
  if (typeof value !== "string") throw new TypeError("Expected a localized money string");
  const digits = localeDigits(options.locale);
  const toAscii = (text: string) => Array.from(text, char => {
    const index = digits.indexOf(char);
    return index < 0 ? char : String(index);
  }).join("");
  let input = value.trim();
  let sign = "";
  // Include locale literals such as the Arabic letter mark before the minus sign.
  const negative = formatter.formatToParts(-1);
  const firstInteger = negative.findIndex(part => part.type === "integer");
  const negativePrefix = negative.slice(0, firstInteger).map(part => part.value).join("");
  if (input.startsWith(negativePrefix)) {
    sign = "-";
    input = input.slice(negativePrefix.length);
  } else if (input.startsWith("-") || input.startsWith("+")) {
    sign = input[0] === "-" ? "-" : "";
    input = input.slice(1);
  }
  const parts = formatter.formatToParts(1234567.8);
  const separator = parts.find(part => part.type === "decimal")?.value;
  const group = parts.find(part => part.type === "group")?.value;
  const pieces = separator ? input.split(separator) : [input];
  if (pieces.length > 2) throw new TypeError("Invalid money decimal separators");
  const integer = pieces[0]!;
  const ungrouped = group ? integer.split(group).join("") : integer;
  const asciiInteger = toAscii(ungrouped);
  const fraction = pieces[1] === undefined ? undefined : toAscii(pieces[1]);
  if (!/^\d+$/.test(asciiInteger) || (fraction !== undefined && !/^\d+$/.test(fraction))) {
    throw new TypeError("Invalid localized money number");
  }
  // Reject ASCII digits in locales using other digits, including mixed scripts.
  const localize = (text: string) => text.replace(/\d/g, digit => digits[Number(digit)]!);
  if (localize(asciiInteger) !== ungrouped || (fraction !== undefined && localize(fraction) !== pieces[1])) {
    throw new TypeError("Money digits do not match the locale");
  }
  if (group && integer.includes(group)) {
    const canonical = formatter.formatToParts(BigInt(asciiInteger))
      .filter(part => part.type === "integer" || part.type === "group").map(part => part.value).join("");
    if (canonical !== integer) throw new TypeError("Invalid money grouping");
  }
  return moneyFromDecimal(`${sign}${asciiInteger}${fraction === undefined ? "" : `.${fraction}`}`, options);
}

/** Format exact minor units, including values near MAX_SAFE_INTEGER. */
export function moneyFormat(value: Money, options: MoneyFormatOptions): string {
  validate(value);
  const digits = moneyCurrencyDigits(value.currency);
  const fixed = moneyToDecimal(value).replace(/^-/, "");
  const [integer, fraction = ""] = fixed.split(".");
  const formatter = numberFormat(options.locale, {
    style: "currency", currency: value.currency,
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  const localizedDigits = localeDigits(options.locale);
  const localizedFraction = fraction.replace(/\d/g, digit => localizedDigits[Number(digit)]!);
  const major = BigInt(integer!);
  const signed = value.amount < 0 ? (major === 0n ? -0 : -major) : major;
  return formatter.formatToParts(signed).map(part => part.type === "fraction" ? localizedFraction : part.value).join("");
}

function sameCurrency(a: Money, b: Money): void {
  validate(a);
  validate(b);
  if (a.currency !== b.currency) throw new RangeError("Cannot mix money currencies");
}

export function moneyAdd(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return finish(new Decimal(a.amount).plus(b.amount), a.currency);
}

export function moneySubtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return finish(new Decimal(a.amount).minus(b.amount), a.currency);
}

/** Empty sums require a currency. Only the final exact sum must fit a safe integer. */
export function moneySum(values: readonly Money[], options?: { currency: string }): Money {
  const currency = options?.currency ?? values[0]?.currency;
  if (currency === undefined) throw new RangeError("Empty money sum requires a currency");
  const zero = moneyFromMinor(0, currency);
  let total = new Decimal(0);
  for (const value of values) {
    sameCurrency(zero, value);
    total = total.plus(value.amount);
  }
  return finish(total, currency);
}

export function moneyCompare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0;
}

export function moneyMultiply(value: Money, factor: string, options: MoneyRoundingOptions): Money {
  validate(value);
  return finish(new Decimal(value.amount).times(decimal(factor)).round(0, roundingMode(options.rounding)), value.currency);
}

export function moneyDivide(value: Money, divisor: string, options: MoneyRoundingOptions): Money {
  validate(value);
  return finish(quotient(new Decimal(value.amount), decimal(divisor), options.rounding), value.currency);
}

function taxRate(options: MoneyTaxOptions): Big {
  roundingMode(options.rounding);
  const rate = decimal(options.percent);
  if (rate.lt(0)) throw new RangeError("Money tax percent must be nonnegative");
  return rate;
}

/** Round tax, preserve net, and derive gross by exact addition. */
export function moneyTaxFromNet(net: Money, options: MoneyTaxOptions): MoneyTax {
  validate(net);
  const tax = finish(quotient(new Decimal(net.amount).times(taxRate(options)), new Decimal(100), options.rounding), net.currency);
  return { net: moneyFromMinor(net.amount, net.currency), tax, gross: moneyAdd(net, tax) };
}

/** Round net, preserve gross, and derive tax by exact subtraction. */
export function moneyTaxFromGross(gross: Money, options: MoneyTaxOptions): MoneyTax {
  validate(gross);
  const net = finish(quotient(new Decimal(gross.amount).times(100), taxRate(options).plus(100), options.rounding), gross.currency);
  return { net, tax: moneySubtract(gross, net), gross: moneyFromMinor(gross.amount, gross.currency) };
}

/** Largest remainders win; ties use input order. Negative totals mirror positives. */
export function moneyAllocate(total: Money, weights: readonly (number | string)[]): Money[] {
  validate(total);
  if (weights.length === 0) throw new RangeError("Money allocation needs weights");
  const parsed = Array.from(weights, weight => {
    if (typeof weight === "number" && (!Number.isSafeInteger(weight) || weight < 0)) {
      throw new RangeError("Numeric weights must be nonnegative safe integers; use strings for decimals");
    }
    const result = decimal(typeof weight === "number" ? String(weight) : weight);
    if (result.lt(0)) throw new RangeError("Money weights must be nonnegative");
    return result;
  });
  const denominator = parsed.reduce((sum, weight) => sum.plus(weight), new Decimal(0));
  if (denominator.eq(0)) throw new RangeError("Money weights must have a positive sum");
  const magnitude = new Decimal(total.amount).abs();
  const shares = parsed.map((weight, index) => {
    const numerator = magnitude.times(weight);
    const base = numerator.div(denominator);
    return { index, base, remainder: numerator.minus(base.times(denominator)) };
  });
  const remaining = Number(magnitude.minus(shares.reduce((sum, share) => sum.plus(share.base), new Decimal(0))).toFixed(0));
  const ranked = [...shares].sort((a, b) => b.remainder.cmp(a.remainder) || a.index - b.index);
  for (let index = 0; index < remaining; index++) ranked[index]!.base = ranked[index]!.base.plus(1);
  return shares.map(share => finish(total.amount < 0 ? share.base.neg() : share.base, total.currency));
}

export const money = {
  fromMinor: moneyFromMinor,
  fromDecimal: moneyFromDecimal,
  toDecimal: moneyToDecimal,
  currencyDigits: moneyCurrencyDigits,
  parse: moneyParse,
  format: moneyFormat,
  add: moneyAdd,
  subtract: moneySubtract,
  sum: moneySum,
  compare: moneyCompare,
  multiply: moneyMultiply,
  divide: moneyDivide,
  taxFromNet: moneyTaxFromNet,
  taxFromGross: moneyTaxFromGross,
  allocate: moneyAllocate,
};
