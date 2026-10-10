# Exact amounts

Use `money` for amounts, taxes, and allocation. Money values are JSON-safe
`{ amount, currency }` objects: `amount` is a safe integer in the currency's
minor units, and `currency` is an uppercase code supported by `Intl`.

```js
export default () => {
  const net = cloud.money.fromDecimal("19.99", { currency: "EUR" });
  const total = cloud.money.taxFromNet(net, { percent: "19", rounding: "half-up" });
  const parts = cloud.money.allocate(total.gross, [1, 1, 1]);
  return {
    net: cloud.money.toDecimal(total.net),
    tax: cloud.money.toDecimal(total.tax),
    gross: cloud.money.toDecimal(total.gross),
    parts: parts.map(part => cloud.money.toDecimal(part))
  };
};
```

| Call | Purpose |
| --- | --- |
| `cloud.money.fromMinor(integer, currency)` | Validate an amount in minor units |
| `cloud.money.fromDecimal(text, { currency, rounding? })` | Parse canonical major units such as `"19.99"` |
| `cloud.money.parse(text, { currency, locale, rounding? })` | Parse a localized number such as `"1.234,56"` with `de-DE` |
| `cloud.money.toDecimal(value)` | Export exact decimal text without grouping |
| `cloud.money.format(value, { locale })` | Format a localized amount with currency |
| `cloud.money.currencyDigits(currency)` | Read the currency's number of fraction digits |
| `cloud.money.add(a, b)`, `cloud.money.subtract(a, b)` | Combine same-currency amounts |
| `cloud.money.sum(values, { currency }?)` | Sum amounts; explicit currency also supports an empty list |
| `cloud.money.compare(a, b)` | Return -1, 0, or 1 for same-currency amounts |
| `cloud.money.multiply(value, factorText, { rounding })` | Multiply by an exact decimal factor |
| `cloud.money.divide(value, divisorText, { rounding })` | Divide and round to minor units |
| `cloud.money.taxFromNet(value, { percent, rounding })` | Compute `{ net, tax, gross }` from net |
| `cloud.money.taxFromGross(value, { percent, rounding })` | Compute `{ net, tax, gross }` from gross |
| `cloud.money.allocate(value, weights)` | Split an amount while preserving the exact total |

Rounding is `half-up`, `half-even`, or `toward-zero`. Specify it for multiplication,
division, and tax. Parsing extra fraction digits also requires explicit rounding.
Decimal factors and percentages are strings, not JavaScript floating-point
calculations. Localized parsing accepts numbers without a currency symbol.

Currency mismatches, unsupported currencies, invalid decimal strings, division
by zero, and amounts outside the safe integer range throw. Validate user input
and show a useful error. Do not silently substitute zero. Store Money objects
as JSON; use `toDecimal` for CSV values and `format` for display. For a chart,
convert only the final display value to a number; keep calculations in `money`.

## Percentages

`multiply(amount, "10")` means ten times the amount, not ten percent. For a tip
or another percentage surcharge, use the percentage API directly:

```js
const bill = cloud.money.fromDecimal("80", { currency: "EUR" });
const { tax: tip, gross: total } = cloud.money.taxFromNet(bill, {
  percent: "10", rounding: "half-up"
});
// cloud.money.toDecimal(tip) === "8.00"; cloud.money.toDecimal(total) === "88.00"
```

Use canonical decimal strings for API percentages (for example `"7.5"`).

`allocate` takes a nonempty array of nonnegative weights with a positive sum.
Number weights must be safe integers; fractional weights use decimal strings,
for example `["0.25", "0.75"]`. It returns `Money[]` in input order, distributes
remaining minor units by largest remainder (ties use input order), and supports
negative totals. Arithmetic methods return `Money`; parsing returns `Money`,
formatting returns strings, and `currencyDigits` returns a number.
