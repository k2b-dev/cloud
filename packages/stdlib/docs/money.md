# Exact money amounts

Use `money` for invoice calculations, credits, reconciliation, and CSV amounts.
Values are plain JSON objects with a signed safe integer in minor units:
`{ amount: 123456, currency: "EUR" }` means EUR 1,234.56.

```ts
import { money, type Money } from "@k2b/stdlib";

const net = money.parse("1.234,56", { locale: "de-DE", currency: "EUR" });
const invoice = money.taxFromNet(net, { percent: "19", rounding: "half-up" });
money.format(invoice.gross, { locale: "de-DE" }); // "1.469,13 €"
money.toDecimal(invoice.tax);                    // "234.57"
```

`money` works in Bun, modern browsers and Web Workers without DOM access.
It requires `BigInt` and `Intl.NumberFormat`, including `formatToParts` and
`Intl.supportedValuesOf`. Supported currencies and precision come from the
runtime's Intl data; use matching runtime data when reproducible historical
currency metadata matters. Unknown codes, lowercase codes and custom currencies
are rejected. JPY has zero fraction digits, EUR two, and KWD three.
There is no currency conversion or cash-increment rounding.

## Read and export amounts

```ts
money.fromMinor(123456, "EUR");                  // already in minor units
money.fromDecimal("1234.56", { currency: "EUR" }); // canonical CSV major units
money.toDecimal(net);                           // "1234.56", always a string
money.currencyDigits("KWD");                    // 3

const json = JSON.stringify(net);
const decoded = JSON.parse(json);
const restored = money.fromMinor(decoded.amount, decoded.currency);
```

All operations validate their money inputs, including objects read from JSON.
They return new plain objects without mutating inputs. Amounts must be within
`-Number.MAX_SAFE_INTEGER` through `Number.MAX_SAFE_INTEGER`. Negative zero is
normalized to zero. Arithmetic uses encapsulated `big.js`; callers neither pass
nor receive library objects. Its types are included because stdlib ships TypeScript
source. Decimal calculations do not pass through floating-point major units.

`fromDecimal` accepts a decimal string with an optional leading `-`, one or more
digits, and an optional dot followed by digits. It rejects exponents, grouping,
whitespace, `+`, `NaN` and `Infinity`. Factors, divisors, percentages, and string
weights use the same syntax. Numeric factors are rejected: pass `"1.19"`, not
`1.19`.

`parse` requires both a supported explicit locale and a currency. It accepts
numeric text, without currency symbols or codes. Outer whitespace and a leading
ASCII `+` or `-` are allowed; the locale's negative prefix is also accepted.
Digits, decimal separators and grouping must match the locale. Grouping is
optional, but if supplied it must match Intl's grouping, including its exact
space character. Ungrouped leading zeros are allowed.

```ts
money.parse("1.234,56", { locale: "de-DE", currency: "EUR" });
money.parse("1,234.56", { locale: "en-US", currency: "USD" });
money.parse("12,34,567.89", { locale: "en-IN", currency: "INR" });
money.parse("1,234", { locale: "en-US", currency: "JPY" });
money.parse("1.234,567", { locale: "de-DE", currency: "KWD" });
// Invalid for de-DE: "12.34,56", "1,234.56", "1.234,56 €".
```

There is no format guessing: `"1.234"` in `de-DE` means 1234 major units.
In `en-US` it has three fraction digits, which EUR parsing rejects.
`parse` is for numeric input; `format` adds currency symbols and may include
nonbreaking spaces or bidirectional marks, so its output is not parse input.
Formatting preserves every minor unit even at the safe integer limits.

Both parsers reject excess fraction digits, including trailing zeros. Supply
`rounding` to explicitly round those inputs:

```ts
money.fromDecimal("1.005", { currency: "EUR", rounding: "half-up" }); // 101 cents
money.parse("-1,005", { locale: "de-DE", currency: "EUR", rounding: "half-even" }); // -100 cents
```

## Calculate and reconcile invoices

```ts
const payment = money.fromDecimal("1469.13", { currency: "EUR" });
const outstanding = money.subtract(invoice.gross, payment);
const reconciled = money.compare(outstanding, money.fromMinor(0, "EUR")) === 0;

money.add(net, net);
money.sum([net, net]);
money.sum([], { currency: "EUR" }); // empty sums need a currency
money.multiply(net, "1.19", { rounding: "half-up" });
money.divide(net, "3", { rounding: "half-even" });
```

`compare` returns `-1`, `0` or `1`. Addition, subtraction, comparison, and sums
reject mixed currencies. An explicit `sum` currency also checks every input.
All returned amounts must fit a safe integer. A sum uses exact intermediate
arithmetic, so canceling terms may temporarily exceed that range.

Multiplication and division always require `rounding`, even for an exact result.
Division by zero fails. Each operation rounds directly to whole minor units.
Choose the policy for your application:

| Rule | Meaning | +2.5 | -2.5 | +3.5 | -3.5 |
|---|---|---:|---:|---:|---:|
| `half-up` | Nearest; ties away from zero | 3 | -3 | 4 | -4 |
| `half-even` | Nearest; ties to the even integer | 2 | -2 | 4 | -4 |
| `toward-zero` | Discard the fractional part | 2 | -2 | 3 | -3 |

The table is in minor units. For example, five cents multiplied by `"0.5"`
produces three cents with `half-up` and two with `half-even`.

## Calculate tax from net or gross

```ts
const taxOptions = { percent: "19", rounding: "half-up" } as const;
money.taxFromNet(money.fromMinor(10000, "EUR"), taxOptions);
// { net: { amount: 10000, currency: "EUR" },
//   tax: { amount: 1900, currency: "EUR" },
//   gross: { amount: 11900, currency: "EUR" } }

money.taxFromGross(money.fromMinor(11900, "EUR"), taxOptions);
// Same result.
money.taxFromGross(money.fromMinor(-11900, "EUR"), taxOptions);
// Credit: net -10000, tax -1900, gross -11900.
```

Pass a nonnegative percentage string: `"19"` means 19%, and `"5.5"` means 5.5%.
Zero and rates above 100% are accepted. The API does not determine legal rates.
Use a negative amount for a credit, rather than a negative rate.

`taxFromNet` rounds `net × percent / 100`, preserves net and adds tax to obtain
gross. `taxFromGross` rounds `gross × 100 / (100 + percent)`, preserves gross and
subtracts net to obtain tax. Thus, `net.amount + tax.amount === gross.amount`
always holds. With `half-even`, rounding net can yield a different tax than
rounding tax independently; the derived component is always the remainder.

Choose whether to round per line or on the invoice total:

```ts
const lines = [money.fromMinor(3, "EUR"), money.fromMinor(3, "EUR")];
const perLineTax = money.sum(lines.map(line => money.taxFromNet(line, taxOptions).tax));
// 1 + 1 = 2 cents of tax; gross total 8 cents.
const totalTax = money.taxFromNet(money.sum(lines), taxOptions).tax;
// 6 × 19% = 1.14 -> 1 cent of tax; gross total 7 cents.
```

Both preserve their own sums. The caller chooses and consistently applies the
required invoice policy.

## Allocate every minor unit

```ts
money.allocate(money.fromMinor(100, "EUR"), [1, 1, 1]);
// Amounts: [34, 33, 33].
money.allocate(money.fromMinor(-100, "EUR"), [1, 1, 1]);
// Amounts: [-34, -33, -33].
money.allocate(money.fromMinor(100, "EUR"), ["0.1", "0.2", "0.3"]);
// Amounts: [17, 33, 50].
```

Weights are nonnegative safe integers, or decimal strings for fractional or
larger exact weights. At least one weight must be positive; empty and all-zero
lists fail. Zero weights receive zero. Results keep the input order and currency.

Allocation first truncates absolute proportional shares, then assigns remaining
units to the largest fractional remainders. Ties use input order. Negative totals
use the same allocation with reversed signs. The returned amounts always sum to
the original total; allocation has no separate rounding option.

## Handle invalid inputs

Like stdlib's other low-level validators, money functions throw. Invalid string
syntax or input types produce `TypeError`; unsupported currencies/locales, unsafe
amounts, invalid rounding policies, mixed currencies, invalid weights and division
by zero produce `RangeError`. No partial result is returned when a calculation
fails. Validate imported JSON with `fromMinor`, and catch parsing errors at the
input boundary to show a field error.

The runnable [invoice example](../examples/money.ts) covers reconciliation,
credit allocation, currency precision and exact formatting.
