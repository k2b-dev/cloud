import { describe, expect, test } from "bun:test";
import Big from "big.js";
import { money, moneyFromMinor, type MoneyRounding } from "./index";

const eur = (amount: number) => money.fromMinor(amount, "EUR");
const de = { locale: "de-DE", currency: "EUR" };
const rounding: MoneyRounding[] = ["half-up", "half-even", "toward-zero"];

describe("money input and output", () => {
  test.each([
    ["1.234,56", "de-DE", "EUR", 123456],
    ["-1.234,56", "de-DE", "EUR", -123456],
    [" +1234,56 ", "de-DE", "EUR", 123456],
    ["1,234.56", "en-US", "USD", 123456],
    ["1\u202f234,56", "fr-FR", "EUR", 123456],
    ["12,34,567.89", "en-IN", "INR", 123456789],
    ["١٬٢٣٤٫٥٦", "ar-EG", "EUR", 123456],
    ["؜-١٬٢٣٤٫٥٦", "ar-EG", "EUR", -123456],
    ["1,234", "en-US", "JPY", 1234],
    ["1.234,567", "de-DE", "KWD", 1234567],
    ["-0,01", "de-DE", "EUR", -1],
    ["0001,00", "de-DE", "EUR", 100],
  ])("parses %s (%s / %s)", (input, locale, currency, amount) => {
    expect(money.parse(input, { locale, currency })).toEqual({ amount, currency });
  });

  test.each(["", " ", "1,234.56", "12.34,56", "1.2345,00", "1..234", "1,", ",5", "1,2,3", "1 234,56", "1.234,56 €", "EUR 1", "1e2", "NaN", "Infinity", "--1", "1-", "(1)", "0x10", "1.234,000", "01.234,00"])("rejects %s", input => {
    expect(() => money.parse(input, de)).toThrow();
  });

  test("format context and currencies are explicit", () => {
    for (const currency of ["ZZZ", "eur", "", "BTC"]) expect(() => money.fromMinor(1, currency)).toThrow(RangeError);
    for (const locale of ["", "zz-ZZ", "not_a_locale"]) expect(() => money.parse("1", { currency: "EUR", locale })).toThrow();
    expect(() => money.parse("123.45", { currency: "EUR", locale: "ar-EG" })).toThrow();
    expect(() => money.parse("١2٣٫٤٥", { currency: "EUR", locale: "ar-EG" })).toThrow();
    expect(money.parse("1.234", de).amount).toBe(123400);
    expect(money.parse("1.234", { currency: "KWD", locale: "en-US" }).amount).toBe(1234);
  });

  test("precision and explicit parsing rounding", () => {
    expect(["JPY", "EUR", "KWD"].map(money.currencyDigits)).toEqual([0, 2, 3]);
    for (const [currency, input] of [["JPY", "1.0"], ["EUR", "1.000"], ["KWD", "1.0000"]]) {
      expect(() => money.fromDecimal(input!, { currency: currency! })).toThrow(RangeError);
    }
    expect(money.parse("1,005", { ...de, rounding: "half-up" })).toEqual(eur(101));
    expect(money.fromDecimal("-1.005", { currency: "EUR", rounding: "half-even" })).toEqual(eur(-100));
    expect(money.fromDecimal("1234.567", { currency: "KWD" }).amount).toBe(1234567);
  });

  test.each(["1e2", "1\n", "1\r", " 1", "1 ", "+1", ".5", "1.", "NaN", "Infinity", "0x10", "1,5"])("rejects noncanonical decimal %s", input => {
    expect(() => money.fromDecimal(input, { currency: "EUR" })).toThrow(TypeError);
  });

  test("safe bounds, exact formatting, negative zero and JSON", () => {
    for (const currency of ["JPY", "EUR", "KWD"]) {
      for (const amount of [0, 1, -1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
        const value = money.fromMinor(amount, currency);
        expect(money.fromDecimal(money.toDecimal(value), { currency })).toEqual(value);
        expect(JSON.parse(JSON.stringify(value))).toEqual(value);
        for (const locale of ["de-DE", "en-US", "en-IN", "ar-EG"]) {
          const formatted = money.format(value, { locale });
          const number = new Intl.NumberFormat(locale, { style: "currency", currency }).formatToParts(amount < 0 ? -1 : 1);
          expect(formatted).toContain(number.find(p => p.type === "currency")!.value);
        }
      }
    }
    expect(money.format(eur(Number.MAX_SAFE_INTEGER), { locale: "de-DE" })).toBe("90.071.992.547.409,91\u00a0€");
    expect(money.format(eur(-1), { locale: "de-DE" })).toBe("-0,01\u00a0€");
    expect(money.format(money.fromMinor(1234567, "KWD"), { locale: "en-US" })).toBe("KWD\u00a01,234.567");
    expect(money.format(money.fromMinor(1234, "JPY"), { locale: "en-US" })).toBe("¥1,234");
    expect(Object.is(eur(-0).amount, -0)).toBe(false);
    expect(moneyFromMinor(12, "EUR")).toEqual(eur(12));
    for (const amount of [NaN, Infinity, -Infinity, 0.1, 2 ** 53, -(2 ** 53)]) expect(() => eur(amount)).toThrow(RangeError);
    expect(() => money.parse("90.071.992.547.409,92", de)).toThrow(RangeError);
    expect(() => money.fromDecimal("90071992547409.915", { currency: "EUR", rounding: "half-up" })).toThrow(RangeError);
    expect(money.fromDecimal("90071992547409.914", { currency: "EUR", rounding: "half-up" }).amount).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("money arithmetic", () => {
  test("exact operations, cancellation, currencies and invalid JSON", () => {
    expect(money.add(eur(10), eur(20))).toEqual(eur(30));
    expect(money.subtract(eur(-10), eur(20))).toEqual(eur(-30));
    expect(money.sum([eur(Number.MAX_SAFE_INTEGER), eur(1), eur(-1)])).toEqual(eur(Number.MAX_SAFE_INTEGER));
    expect(money.sum([], { currency: "EUR" })).toEqual(eur(0));
    expect(() => money.sum([])).toThrow(RangeError);
    expect(money.compare(eur(-1), eur(1))).toBe(-1);
    expect(money.compare(eur(1), eur(-1))).toBe(1);
    expect(money.compare(eur(1), eur(1))).toBe(0);
    for (const operation of [money.add, money.subtract, money.compare]) {
      expect(() => operation(eur(1), money.fromMinor(1, "USD"))).toThrow(RangeError);
      expect(() => operation(eur(1), { amount: 0.1, currency: "EUR" })).toThrow(RangeError);
    }
    expect(() => money.sum([eur(1)], { currency: "USD" })).toThrow();
    expect(() => money.add(eur(Number.MAX_SAFE_INTEGER), eur(1))).toThrow(RangeError);
    expect(() => money.subtract(eur(-Number.MAX_SAFE_INTEGER), eur(1))).toThrow(RangeError);
    expect(() => money.multiply(eur(Number.MAX_SAFE_INTEGER), "2", { rounding: "half-up" })).toThrow(RangeError);
    expect(() => money.divide(eur(1), "0", { rounding: "half-up" })).toThrow(RangeError);
    expect(() => money.divide(eur(1), "-0", { rounding: "half-up" })).toThrow(RangeError);
  });

  test.each([
    ["half-up", 3, -3, 4, -4],
    ["half-even", 2, -2, 4, -4],
    ["toward-zero", 2, -2, 3, -3],
  ] as const)("%s rounds signed halves", (rounding, a, b, c, d) => {
    for (const [amount, expected] of [[5, a], [-5, b], [7, c], [-7, d]]) {
      expect(money.multiply(eur(amount!), "0.5", { rounding }).amount).toBe(expected!);
      expect(money.divide(eur(amount!), "2", { rounding }).amount).toBe(expected!);
    }
  });

  test("division rounds once; very close half and long inputs", () => {
    expect(money.divide(eur(1), "3", { rounding: "half-up" })).toEqual(eur(0));
    expect(money.divide(eur(5), "-2", { rounding: "half-up" })).toEqual(eur(-3));
    expect(money.divide(eur(1), "2.000000000000000000000000000001", { rounding: "half-up" })).toEqual(eur(0));
    expect(money.multiply(eur(1), "0.499999999999999999999999999999", { rounding: "half-up" })).toEqual(eur(0));
    const previous = { DP: Big.DP, RM: Big.RM };
    try {
      Big.DP = 1;
      Big.RM = 3;
      expect(money.divide(eur(5), "2", { rounding: "half-even" })).toEqual(eur(2));
      expect(money.allocate(eur(100), [1, 1, 1]).map(v => v.amount)).toEqual([34, 33, 33]);
    } finally { Big.DP = previous.DP; Big.RM = previous.RM; }
    // @ts-expect-error A rounding rule is mandatory.
    expect(() => money.multiply(eur(1), "1")).toThrow();
    // @ts-expect-error Runtime JS callers also receive validation.
    expect(() => money.divide(eur(1), "1", { rounding: "up" })).toThrow();
    // @ts-expect-error Decimal numbers must be strings.
    expect(() => money.multiply(eur(1), 1.19, { rounding: "half-up" })).toThrow();
  });
});

describe("money taxes and allocation", () => {
  test("net/gross and credit calculations preserve inputs and equality", () => {
    expect(money.taxFromNet(eur(10000), { percent: "19", rounding: "half-up" })).toEqual({ net: eur(10000), tax: eur(1900), gross: eur(11900) });
    expect(money.taxFromGross(eur(11900), { percent: "19", rounding: "half-up" })).toEqual({ net: eur(10000), tax: eur(1900), gross: eur(11900) });
    for (const mode of rounding) for (const percent of ["0", "7", "19", "5.5", "100"]) for (let amount = -120; amount <= 120; amount++) {
      for (const fn of [money.taxFromNet, money.taxFromGross]) {
        const result = fn(eur(amount), { percent, rounding: mode });
        expect(result.net.amount + result.tax.amount).toBe(result.gross.amount);
        expect(fn === money.taxFromNet ? result.net.amount : result.gross.amount).toBe(amount);
      }
    }
    expect(() => money.taxFromNet(eur(1), { percent: "-1", rounding: "half-up" })).toThrow();
    expect(() => money.taxFromGross(eur(1), { percent: "-100", rounding: "half-up" })).toThrow();
    expect(() => money.taxFromNet(eur(Number.MAX_SAFE_INTEGER), { percent: "19", rounding: "half-up" })).toThrow(RangeError);
    const options = { percent: "19", rounding: "half-up" } as const;
    expect(money.sum([eur(3), eur(3)].map(v => money.taxFromNet(v, options).tax)).amount).toBe(2);
    expect(money.taxFromNet(eur(6), options).tax.amount).toBe(1);
  });

  test("tax halves use the requested component and signed rounding rule", () => {
    for (const sign of [1, -1]) {
      for (const [rounding, expected] of [["half-up", 3], ["half-even", 2], ["toward-zero", 2]] as const) {
        const net = money.taxFromNet(eur(sign * 5), { percent: "50", rounding });
        expect(net.tax.amount).toBe(sign * expected);
        expect(net.net.amount).toBe(sign * 5);
        const gross = money.taxFromGross(eur(sign * 5), { percent: "100", rounding });
        expect(gross.net.amount).toBe(sign * expected);
        expect(gross.tax.amount).toBe(sign * (5 - expected));
      }
    }
    const maximal = money.taxFromGross(eur(Number.MAX_SAFE_INTEGER), { percent: "19", rounding: "half-up" });
    expect(maximal.net.amount + maximal.tax.amount).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("largest remainders, ties, zeros, negative totals and decimal weights", () => {
    expect(money.allocate(eur(100), [1, 1, 1]).map(v => v.amount)).toEqual([34, 33, 33]);
    expect(money.allocate(eur(-100), [1, 1, 1]).map(v => v.amount)).toEqual([-34, -33, -33]);
    expect(money.allocate(eur(2), [1, 1, 1]).map(v => v.amount)).toEqual([1, 1, 0]);
    expect(money.allocate(eur(7), [0, 1, 3]).map(v => v.amount)).toEqual([0, 2, 5]);
    expect(money.allocate(eur(100), ["0.1", "0.2", "0.3"]).map(v => v.amount)).toEqual([17, 33, 50]);
    expect(money.allocate(eur(1), ["1", "1.00000000000000000000000000000001"]).map(v => v.amount)).toEqual([0, 1]);
    for (const amount of [0, 1, -1, 100, -100, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
      for (const weights of [[1], [0, 1, 0], [1, 2, 3], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1]]) {
        const input = Object.freeze(eur(amount));
        const shares = money.allocate(input, Object.freeze(weights));
        expect(money.sum(shares)).toEqual(input);
        expect(shares.every(v => Number.isSafeInteger(v.amount))).toBe(true);
      }
    }
    for (const weights of [[], [0, 0], [-1, 2], [0.5, 1], [Infinity], [2 ** 53], ["NaN"], ["-0.1", "1"]]) {
      expect(() => money.allocate(eur(100), weights)).toThrow();
    }
  });
});
