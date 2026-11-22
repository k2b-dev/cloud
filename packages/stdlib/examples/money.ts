import { money } from "../src/index";

// This example has no Bun or DOM dependencies: run in Bun, a browser or a worker.
export function moneyExample() {
  const input = money.parse("1.234,56", { locale: "de-DE", currency: "EUR" });
  const restored = money.fromMinor(JSON.parse(JSON.stringify(input)).amount, "EUR");
  const invoice = money.taxFromNet(restored, { percent: "19", rounding: "half-up" });
  const credit = money.allocate(money.fromMinor(-100, "EUR"), [1, 1, 1]);
  const payment = money.fromDecimal("1469.13", { currency: "EUR" });
  const difference = money.subtract(invoice.gross, payment);
  return {
    net: money.toDecimal(invoice.net),
    tax: money.toDecimal(invoice.tax),
    gross: money.toDecimal(invoice.gross),
    reconciled: money.compare(difference, money.fromMinor(0, "EUR")) === 0,
    credit: credit.map(value => value.amount),
    creditSum: money.sum(credit).amount,
    maximum: money.format(money.fromMinor(Number.MAX_SAFE_INTEGER, "EUR"), { locale: "de-DE" }),
    yen: money.toDecimal(money.parse("1,234", { locale: "en-US", currency: "JPY" })),
    dinar: money.toDecimal(money.parse("1.234,567", { locale: "de-DE", currency: "KWD" })),
    negativeHalf: money.multiply(money.fromMinor(-5, "EUR"), "0.5", { rounding: "half-even" }).amount,
  };
}
