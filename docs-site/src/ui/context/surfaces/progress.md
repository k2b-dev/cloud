# Progress

`ProgressBar` presents determinate progress from 0 to 100, or parts of a budget
with `segments` and `limit`. Its neutral track stays
visible against muted surfaces in both themes, so the full length remains clear.
`ProgressRing` presents the same value as a 1rem ring without a number, for
places too small for a bar, such as a toolbar or a chat composer.

## Use progress

Use the default tone for ordinary work, success for a positive completion state, warning when a limit is close, and danger when the progress itself represents a reached limit or failing state. `ProgressRing` also takes `accent` for progress that belongs to the app itself, such as the share of today's work done; it uses the app colour and carries no state.

Use the ring only next to a control or text that names the value, for example a button whose label says "Usage: 35%". In warning the ring adds a centre dot and in danger an exclamation mark, so the states differ without colour.

## Budgets

`BudgetList` shows budgets as rows: the label, "1.240 € von 1.500 €", a
segmented bar, and a hint. Booked spending (`used`) is solid, spending that is
expected on top (`expected`) is hatched, and what goes beyond the budget is red
with a mark at the limit. The sum is `used + expected`; over the budget is the
sum minus `limit`. From 80 % of the budget the hint turns amber ("knapp · noch
300 € frei"), beyond 100 % red ("200 € über dem Budget"); below 80 % it says
what is left. A legend names booked, expected (when any row has it) and over
the budget (when any row is over). On hover and keyboard focus a row's tooltip
lists booked, expected, budget and what is left or over; the bar's spoken value
says the same, so touch and screen readers lose nothing.

`budgetState(item)` returns the same figures (`total`, `over`, `free`,
`ratio`, `level: "ok" | "near" | "over"`) for hosts that add their own text.
For one bar, pass `segments` and `limit` to `ProgressBar` directly;
`progressBarParts(segments, limit)` returns the drawn widths.

Use `DotStrip` for a fixed window of outcomes, not for a percentage. Each dot
is one item in order; the tone says what happened: `accent` (the app colour)
for "it worked", `warning` for skipped, `danger` for failed, `ai` for an
outcome that came from AI, and `muted` for "nothing to do". Always show a
legend or counts next to it, because colour alone carries no meaning. Pass
`length` while the window is still filling: the remaining slots stay as empty
rings, so the strip keeps its size and nothing shifts. `waiting` shows every
slot as a quiet placeholder before anything was checked.

## Import

```tsx
import { BudgetList, DotStrip, ProgressBar, ProgressRing, budgetState } from "@k2b/ui";
```

## API reference

```ts
type ProgressBarTone = Extract<IntentTone, "info" | "success" | "warning" | "danger">;

type ProgressBarSegment = { value: number; pattern?: "solid" | "hatched" };

type ProgressBarProps = {
  value?: number; size?: "xs" | "sm" | "md"; tone?: ProgressBarTone; showValue?: boolean; label: string;
  segments?: readonly ProgressBarSegment[]; limit?: number; valueText?: string; class?: string;
};

type BudgetItem = { id?: string; label: string; used: number; expected?: number; limit: number };

type BudgetListProps = {
  items: readonly BudgetItem[]; currency: string; locale?: string; decimals?: number;
  empty?: string; legend?: boolean; class?: string;
};

type ProgressRingTone = Extract<IntentTone, "info" | "warning" | "danger"> | "accent";

type ProgressRingProps = {
  value: number; tone?: ProgressRingTone; label?: string; class?: string;
};

type DotStripTone = "accent" | "warning" | "danger" | "ai" | "muted";

type DotStripProps = {
  dots: readonly DotStripTone[]; length?: number; waiting?: boolean; selected?: number | null;
  size?: "md" | "lg"; columns?: number; label: string; class?: string;
};
```

`IntentTone` is defined in [shared API conventions](/en/ui/getting-started#icons-tones-and-navigation); each component accepts only the tones listed above. Defaults: `size="md"`, `tone="info"`, `showValue=false`. Finite values round to an integer and clamp to 0–100; non-finite values render 0. With `segments`, `value` is ignored: the share comes from the segments. Negative and non-finite parts count as 0, the track spans the larger of `limit` and the sum, and a `limit` of 0, below 0 or not finite is an empty budget, so any spending is over it. Without `limit` the segments fill the track. `aria-valuenow` stays within 0–100 and `aria-valuetext` says the real share ("120%") unless `valueText` replaces it. Sums within a billionth of the limit count as equal, so float residue never tips a budget over 100 % or under 80 %. In forced colours, expected spending is an outlined part and the overrun uses `Mark`. `BudgetList` formats money in the inherited locale with 0 decimals unless `decimals` says otherwise; `locale` overrides number format and words alike.

## Accessibility

Pass a task-specific `label`. Tone supplements the numeric value and must not carry meaning alone.

`DotStrip` is one image with the `label` as its name. Put the counts into the
label ("Last 50 mails: 17 matched, 6 skipped, 27 not"); single dots are not
announced. `selected` adds a ring around one dot for the item shown next to the
strip. `columns` wraps long windows into rows, for example 25 per row on a phone.

`ProgressRing` with a `label` is a named progressbar. Without one it is hidden from assistive technology; the surrounding control must then carry the name and the value.

## Runtime

`ProgressBar`, `ProgressRing` and `DotStrip` render on the server and need no browser code for their initial value.

## Example

```tsx
<ProgressBar value={72.4} label="Upload progress" tone="success" showValue />
<BudgetList
  currency="EUR"
  items={[
    { label: "Wareneinkauf", used: 9200, expected: 1800, limit: 15000 },
    { label: "Marketing", used: 1400, expected: 300, limit: 2000 },
    { label: "Reisen", used: 900, expected: 300, limit: 1000 },
  ]}
/>
<ProgressRing value={92} tone="warning" label="Storage used" />
<DotStrip dots={["accent", "muted", "warning", "accent"]} length={50} label="Last 50 mails: 2 matched, 1 skipped, 1 not, 46 open" />
```
