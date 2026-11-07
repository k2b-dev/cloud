# Stats

`StatGrid` presents a row of comparable key figures. Each `StatCell` is a
framed tile of its own: an optional icon and the label at the top, the figure
with its change below, and one support line with the comparison, a note, and
the trend.

The application owns the values, their scope, and the links used to investigate them.

## Use stats

Use `StatGrid` for key figures on dashboards and operational summaries.

Use `DataPanel` for records. Use ordinary prose for one isolated value that does not need comparison.

Assistant stats views compose a read-only `StatGrid` of 1..6 `StatCell`s for
comparable figures above charts. Shared formatters supply values, scope text,
sparklines and deltas; the host maps better/worse/neutral tones to colors.
Chat places change badges below their figures so a formatted amount and its
change do not compete for width when a saved view finishes loading.
The Assistant's card tool shows one figure as a single-cell grid with a
neutral trend accent and `wrap`, so a long value or caption stays whole.

For an existing measure whose change is an amount or count, use
`delta={{value: 12, unit: "absolute", format: {style: "currency", currency: "EUR"}}}`.
The badge retains that unit. Assistant stats use this mode for saved numeric
deltas; new ratio and points deltas use the same badge and comparison line.

## Import

```tsx
import {
  StatCell,
  StatGrid,
  type StatCellAccent,
  type StatCellCompare,
  type StatCellDelta,
} from "@k2b/ui";
```

## Properties

### StatGrid

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `children` | `JSX.Element` | required | Contains `StatCell` elements. |
| `title` | `string` | none | Adds a compact heading above the tiles and names the group. |
| `action` | `{ label: string; href: string }` | none | Adds a link beside the title when `title` is present. |
| `columns` | `1 \| 2 \| 3 \| 4 \| 5 \| 6` | `4` | Tiles per row on a wide container. |
| `size` | `"lg" \| "md" \| "sm"` | `"md"` | Sets the density inherited by the tiles. |
| `surface` | `"white" \| "muted"` | `"white"` | Gives the tiles the page or the muted surface. |
| `class` | `string` | none | Adds sizing or layout classes to the outer element. |

The grid is a container, so the row follows the space it gets, not the
viewport: `columns` tiles per row, five or six take three per row at 900 px or
less, and every grid with two or more columns shows two tiles per row at 600 px
or less (one at 280 px or less). Tiles in a row share one height. Tiles keep
16 px apart, 10 px at 600 px or less.

### StatCell

| Property | Type | Purpose |
| --- | --- | --- |
| `label` | `string` | Names the measurement. |
| `value` | `string \| number \| JSX.Element \| null` | Displays the figure. `null` shows a dash; say why in `sub`. |
| `icon` | `string` | Shows a Tabler icon in a chip before the label. |
| `tone` | `"zinc" \| "blue" \| "emerald" \| "amber" \| "red" \| "in" \| "out"` | Colors the icon chip. Defaults to zinc. `in` and `out` are the money colors of `FlowAmount` for tiles such as "In in October"; pass a `FlowAmount` as `value` there. |
| `delta` | `StatCellDelta` | Shows the change as a badge beside the figure. |
| `deltaPlacement` | `"below"` | Reserves a separate row for the change, including while loading. Omit it for the default responsive placement. |
| `compare` | `StatCellCompare` | Names the comparison value in the support line, such as "Last month 44,560". |
| `sub` | `string` | Qualifies the value with scope, unit, or time range. |
| `href` | `string` | Makes the complete tile a link. |
| `accent` | `StatCellAccent` | Adds a semantic icon or short status pill to the support line. |
| `valueClass` | `string` | Overrides the value color. |
| `title` | `string` | Adds a native title to the value, such as its unrounded form. |
| `trend` | `readonly number[]` | Adds a sparkline at the end of the support line, from oldest to newest, with tooltips and keyboard inspection. |
| `trendTooltip` | `ChartTooltipFormatter` | Customizes the trend tooltip, for example with a period title or a unit. |
| `size` | `"lg" \| "md" \| "sm"` | Overrides the inherited size for one tile. |
| `wrap` | `boolean` | Wraps label, `sub` and accent instead of truncating them (the value always wraps rather than being cut). |
| `status` | `"loading" \| "error"` | Shows placeholders, or "Not loaded", in the tile's place. |
| `onRetry` | `() => void` | Offers "Try again" after an error and "Reload" beside `stale`. |
| `stale` | `string` | Replaces the support line with a warning such as "As of 09:12 · not current". |

`size="lg"` is the dashboard tile: a 28 px figure in a tile of at least 136 px.
When the grid is 600 px wide or less, the change badge moves under the figure
in every size, and the `lg` tile grows to at least 164 px.

The figure is never cut off. In a grid it shrinks with its tile's width within
fixed bounds (`lg` 18–28 px, `md` 16–20 px, `sm` 14–16 px); a text value that
still does not fit wraps at its spaces and the tile grows, instead of ending in
an ellipsis. Where the badge moves under the figure, every size reserves the
room of both in every state, so loading, error and data keep one height; only a
text value long enough to wrap makes its tile taller. Below 200 px of tile width an `lg` tile drops its trend. These
adjustments follow the grid; a `StatCell` on its own keeps its sizes and wraps.
`md` and `sm` tiles take the height of their content.

### Change and comparison

```ts
type StatCellDelta = { value: number; unit?: "ratio" | "points" | "absolute"; format?: ChartNumberFormat; better?: "up" | "down" };
type StatCellCompare = { label: string; value: string | number };
```

- `unit: "ratio"` (default) reads `0.082` as `+8.2 %`. `"points"` is the
  difference of two shares in ratio units: `0.031` reads `+3.1 pts`.
- The badge shows an arrow and the signed change. Only with `better` does it
  carry a tone: green when the change goes the better way, red otherwise.
  Without `better`, or for no change, it stays grey and unrated.
- Its spoken label names the change, the comparison, and, with `better`, the
  rating: "+8.2 % compared with Last month, better".
- A number in `compare.value` is formatted in the inherited locale; pass a
  string for currencies and percentages.

## States

Every tile keeps its three rows in every state, so nothing moves when data
arrives or fails:

- **Loading** (`status="loading"`): placeholders for the figure and the
  support line; the tile is `aria-busy` and not a link.
- **Error** (`status="error"`): "Not loaded" in place of the figure, and
  "Try again" when `onRetry` is set.
- **Empty** (`value={null}`): a dash and the reason in `sub`.
- **Stale** (`stale`): the figure stays; the support line shows the warning
  and "Reload" when `onRetry` is set.

## Composition

- Keep tiles in one comparable scope and time range.
- Put related figures in one `StatGrid`; do not wrap the grid or a tile in another `Paper` or frame.
- Write labels in sentence case. The label is shown as written, and the value stays the visual anchor.
- Put a unit in the label, value, or `sub` when it is not obvious.
- Use `sub` to qualify the value, not repeat the label.
- Link operational values to the filtered page that explains them.
- Use `surface="muted"` inside gray dialog or settings sections.
- Do not use a sparkline as the only representation of a change.

`StatCellAccent` is `{ tone: "zinc" | "blue" | "emerald" | "amber" | "red"; icon: string; text?: string }`.
The icon uses a complete Tabler class. Text creates a pill; without text, only
the icon is shown. `StatCell.label` and `value` are required; other props are
optional.

## Accessibility

Every value needs a visible label. A linked tile is a native, independently
focusable link. Keep its combined text useful at the destination.

Icons, the change arrow, and sparklines supplement the text; they do not
replace a status label or numeric value. The change badge has its own spoken
label. Labels and support lines may end in an ellipsis; the value is never cut.

A trend sparkline uses the tile's label as its accessible name. Its tooltip
names each value after the tile label and formats it in the inherited locale.
`trendTooltip` replaces that tooltip and runs in browser code;
`selection.datum.index` is the source index into `trend`. Keep `href` and
`trend` on separate tiles: a linked tile should not contain an inspectable
sparkline, which would nest interactive content.

## Runtime

`StatGrid` and `StatCell` render on the server. Static links work without browser code. Trend sparklines are rendered by the shared `Chart` component within the tile. Render a tile with `trend` or `onRetry` inside an island.

## Example

```tsx
<StatGrid size="lg" columns={4}>
  <StatCell
    label="Subscribers"
    icon="ti ti-users"
    tone="blue"
    value="48,210"
    delta={{ value: 0.082, better: "up" }}
    compare={{ label: "Last month", value: 44560 }}
    trend={[38900, 40500, 42200, 43300, 44000, 44560, 48210]}
  />
  <StatCell
    label="Open rate"
    icon="ti ti-mail-opened"
    tone="emerald"
    value="49.2 %"
    delta={{ value: 0.031, unit: "points", better: "up" }}
    compare={{ label: "Last month", value: "46.1 %" }}
  />
  <StatCell
    label="Unsubscribes"
    icon="ti ti-user-minus"
    value={182}
    delta={{ value: -0.125, better: "down" }}
    compare={{ label: "Last month", value: 208 }}
  />
  <StatCell label="Bounces" icon="ti ti-mail-off" value={null} sub="Nothing counted in this period" />
</StatGrid>
```
