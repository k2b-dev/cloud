# Money

`FlowAmount` shows money that moves: what comes in, what goes out. The
direction is the message, so the amount carries no sign. An arrow and a color
say which way the money goes, and screen readers hear it as a word.

Use `Format.Currency` for a stand, a price, or a balance, which has no
direction; its `signDisplay="exceptZero"` writes a change as `+1.234,50 €`.
See [Locale and formatting](/en/ui/content/intl).

## Use FlowAmount

- Bookings, transfers, and cash flow in tables, lists, and key figures.
- Totals of a period that are clearly in or out ("In in October").
- Do not use it for a balance or a net result: a negative balance is a stand,
  not an outgoing payment.

## Import

```tsx
import { FlowAmount, flowDirection, type FlowAmountProps } from "@k2b/ui";
```

## Properties

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `value` | `number` | required | Signed amount: positive comes in, negative goes out, zero moves nothing. |
| `currency` | `string` | required | ISO 4217 code such as `"EUR"`. |
| `locale` | `string` | inherited | Overrides the inherited render locale. |
| `decimals` | `number` | the currency's digits | Fixed fraction digits. |
| `labels` | `{ in?: string; out?: string }` | "incoming", "outgoing" | The words screen readers hear, such as "Income" and "Expense". |
| `size` | `"md" \| "lg"` | `"md"` | `lg` is the key figure size (24 px, bold). In a `StatGrid` tile it shrinks with the tile (down to 12 px on a 320 px phone) so the amount stays whole; give tile amounts `decimals={0}`. |

`flowDirection(value)` returns `"in"`, `"out"`, or `"none"` with the same
rule, for hosts that tint a row or pick a chart color. `-0` moves nothing.
`NaN` and infinite values are no amount: they show "—" and are spoken as
"amount unknown", never as a believable zero. `locale` sets the number format
and the spoken words alike.

## Look

| Direction | Arrow | Color | Surface |
| --- | --- | --- | --- |
| In | down-left | `--k2b-flow-in-text` (turquoise) | `--k2b-flow-in-surface` pill with a 1 px `--k2b-flow-in-ring` |
| Out | up-right | `--k2b-flow-out-text` (violet) | none; the arrow sits on `--k2b-flow-out-surface` |
| Zero | `=` | muted text | none |

`--k2b-flow-in-mark` and `--k2b-flow-out-mark` color bars, areas, and dots of
money in charts. All tokens exist in light and dark, in the full stylesheet and in the classless `@k2b/ui/base.css`, so charts drawn in a page with only the base stylesheet use the same colors; text keeps at least 4.5:1
on its surface. Turquoise and violet only mean in and out: plum is reserved
for AI, green and red for status.

## Accessibility

The arrow is decorative. Each amount ends with a visually hidden word
(", incoming", ", outgoing", ", no amount") and has the same word as `title`,
so color is never the only signal. In forced colors the incoming pill keeps a
border.

## Runtime

`FlowAmount` renders on the server and needs no browser code. Formatting uses
`Intl.NumberFormat` with the inherited locale, so the first server frame and
the browser show the same text.

## Example

```tsx
<FlowAmount value={31240.5} currency="EUR" />       {/* ↙ 31.240,50 € , incoming */}
<FlowAmount value={-30500} currency="EUR" />        {/* ↗ 30.500,00 € , outgoing */}
<FlowAmount value={0} currency="EUR" />             {/* = 0,00 € */}
<StatCell label="In in October" value={<FlowAmount value={31240} currency="EUR" decimals={0} size="lg" />} />
```
