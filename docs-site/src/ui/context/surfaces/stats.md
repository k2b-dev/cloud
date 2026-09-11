# Stats

`StatGrid` presents a small group of comparable values. `StatCell` supplies each label, value, and optional supporting detail.

The application owns the values, their scope, and the links used to investigate them.

## Use stats

Use `StatGrid` for operational summaries and compact dashboard statistics.

Use `DataPanel` for records. Use ordinary prose for one isolated value that does not need comparison.

## Import

```tsx
import {
  StatCell,
  StatGrid,
  type StatCellAccent,
} from "@k2b/ui";
```

## Properties

### StatGrid

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `children` | `JSX.Element` | required | Contains `StatCell` elements. |
| `title` | `string` | none | Adds a compact heading above the cells. |
| `action` | `{ label: string; href: string }` | none | Adds a header link when `title` is present. |
| `columns` | `1 \| 2 \| 3 \| 4 \| 5 \| 6` | responsive ladder | Selects one to six responsive columns. |
| `size` | `"md" \| "sm"` | `"md"` | Sets the density inherited by cells. |
| `surface` | `"white" \| "muted"` | `"white"` | Matches the cell backgrounds to a page or muted parent surface. |
| `class` | `string` | none | Adds sizing or layout classes to the outer surface. |

Pass `columns` when the cell count is known. Omitting it uses the six-column
ladder: two columns initially, three
from 40rem, and six from 48rem. Three cells move from one to three columns at
40rem; four cells move from two to four at 48rem; five cells use two, then
three, then five. One- and two-column grids remain fixed.

### StatCell

| Property | Type | Purpose |
| --- | --- | --- |
| `label` | `string` | Names the measurement. |
| `value` | `string \| number \| JSX.Element` | Displays the primary value. |
| `sub` | `string` | Qualifies the value with scope, unit, or time range. |
| `href` | `string` | Makes the complete cell a link. |
| `accent` | `StatCellAccent` | Adds a semantic icon or short status pill. |
| `valueClass` | `string` | Overrides the value color. |
| `title` | `string` | Adds a native title to a truncated value. |
| `trend` | `readonly number[]` | Adds a compact sparkline from oldest to newest. |
| `size` | `"md" \| "sm"` | Overrides the inherited size for one cell. |

An accent has a `tone`, Tabler `icon`, and optional `text`. Text creates a pill. Without text, only the icon is shown. Use the cell `href` when the measurement needs a link.

## Composition

- Keep cells in one comparable scope and time range.
- Put a unit in the label, value, or `sub` when it is not obvious.
- Use `sub` to qualify the value, not repeat the label.
- Link operational values to the filtered page that explains them.
- Use `surface="muted"` inside gray dialog or settings sections.
- Do not use a sparkline as the only representation of a change.

`StatCellAccent` is `{ tone: "zinc" | "blue" | "emerald" | "amber" | "red"; icon: string; text?: string }`.
The icon uses a complete Tabler class. `StatCell.label` and `value` are required;
other cell props are optional.

## Accessibility

Every value needs a visible label. A linked cell is a native, independently
focusable link. Keep its combined text useful at the destination.

Accent icons and sparklines supplement the text; they do not replace a status
label or numeric value. Truncated values can expose their complete wording
through `title`.

## Runtime

`StatGrid` and `StatCell` render on the server. Static links work without hydration. Trend sparklines are rendered by the shared `Chart` component within the cell.

## Example

```tsx
<StatGrid
  title="Requests"
  action={{ label: "View telemetry", href: "/admin/observability/telemetry" }}
>
  <StatCell
    label="Server errors"
    value="4,913"
    sub="5xx · 24h"
    valueClass="app-stat-critical"
    accent={{
      tone: "red",
      icon: "ti ti-alert-circle",
      text: "Inspect",
    }}
    href="/admin/observability/telemetry?range=24h&errors=1"
  />
  <StatCell
    label="Rate limited"
    value="6,071"
    sub="429 · 24h"
    href="/admin/observability/telemetry?range=24h&status=429"
  />
  <StatCell label="All requests" value="273,911" sub="24h" />
</StatGrid>
```
