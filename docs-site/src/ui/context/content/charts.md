# Chart

`Chart` renders typed chart data as responsive SVG. The caller owns the data, query, time range, labels, units, and surrounding explanation.

## Use Chart

Use it to show a trend, distribution, comparison, geographic series, or state history.

Use `StatCell` for one value. Use `DataTable` when readers need exact records rather than a visual summary.

## Import

```tsx
import {
  Chart,
  type ChartLabels,
  type ChartKind,
  type ChartProps,
  type ChartSelection,
  type ChartTooltip,
  type ChartTooltipFormatter,
  RangePicker,
  type RangeOption,
  type RangePickerProps,
  type StateTimelineChartOptions,
  type StateTimelineDomain,
  type StateTimelineInterval,
  type StateTimelineRow,
  type StateTimelineState,
} from "@k2b/ui";
```

## Chart kinds

`kind` selects the data and options accepted by the underlying chart:

- `line` and `scatter` for series, `sparkline` for a compact trend;
- `bar`, `pie`, and `donut` for category values;
- `histogram` and `boxplot` for distributions;
- `gauge`, `barGauge`, and `stat` for bounded values;
- `heatmap` and `map` for spatial values;
- `stateTimeline` for intervals with discrete states.

TypeScript narrows the remaining properties from `kind`. `width` and `height` are removed from the accepted chart options: CSS fits the server-rendered SVG to the component’s box.

## Props reference

Use the discriminated `ChartProps` union to type data builders without widening
`kind` to `string`:

```tsx
const options = {
  kind: "scatter",
  series: [{ label: "Cached", data: [{ x: 50, y: 30 }] }],
  interactive: true,
  style: { height: "14rem" },
} satisfies ChartProps;

<Chart {...options} />;

type ScatterProps = Extract<ChartProps, { kind: "scatter" }>;
```

All kinds accept these wrapper props:

| Prop | Type and behavior |
| --- | --- |
| `kind` | Required literal from the 14 kinds above. Determines the data payload and allowed options. |
| `class` | Optional class on the wrapper. |
| `style` | Solid `JSX.CSSProperties` or a CSS string on the wrapper. Set height here, not with a `height` prop. |
| `labels` | Optional `ChartLabels` overrides. Keys: `empty`, `series`, `interactiveMap`, `interactiveTimeline`, `interactiveLine`, `interactiveChart`, `zoomIn`, `zoomOut`, `resetMap`, `resetTimeline`. Omitted keys use the inherited UI messages. These do not rename tooltip fields; use `tooltip` for domain labels. |
| `interactive` | Boolean, default `false`. Enables inspection; additionally enables navigation on maps and timelines. |
| `tooltip` | Synchronous `(selection: ChartSelection) => ChartTooltip`. Used only with `interactive`. Omit for the built-in tooltip. Does not accept JSX, HTML, or a promise. |
| `onSelect` | Optional synchronous `(selection: ChartSelection) => void`. Click, tap, and Enter emit selection; hover and focus do not. No controlled selection prop is provided. |

Do not pass `width`, `height`, or stdlib's `inspect`: the wrapper owns them.
Do not invent `dataKey`, `xKey`, `yKey`, `onClick`, or `renderTooltip` props.
Convert application records into the payload for the selected kind.

Except for `sparkline` and `stateTimeline`, stdlib options also include
`className?: string` (on the SVG, distinct from wrapper `class`),
`title?: string`, `subtitle?: string`, and
`padding?: number | { top?: number; right?: number; bottom?: number; left?: number }`.
Padding is in logical SVG units; Cartesian defaults are top 16, right 16,
bottom 32, left 40. Support for header/padding layout varies with the renderer;
use surrounding HTML for a consistent card title.
`sparkline` supports `className` but has no title, axes, or padding prop.
The UI-owned `stateTimeline` contract supports only its options below plus the
wrapper props; it does not inherit the raw stdlib timeline options.

### Data and options by kind

All payloads below are arrays, not accessors. Pass `series={series()}` for a
Solid signal. Boolean options default to `false` unless stated otherwise.

| Kind | Required payload | Additional options and defaults |
| --- | --- | --- |
| `line` | `series: Series[]` | `xAxis`, `yAxis`, `references`, `legend`; `smooth=true`, `area=false`, `step?: "before" / "after" / "middle"` (overrides smoothing), `autoVariant=false`, `errorBand=false`. |
| `scatter` | `series: Series[]` | `xAxis`, `yAxis`, `references`, `legend`, `autoVariant=false`, `trendline=false`; `sizeRange?: [number, number]`, default `[3, 12]`, applies only if a point has finite `size`. No `pointRadius` prop. UI markers have a fixed visual enlargement independent of plot width. |
| `bar` | `data: { label: string; value: number }[]` | `yAxis`, `references`, `colorByBar=false`, `showValues=false`, `legend=false` (used only with `colorByBar`). Negative values are supported; baseline includes zero. No grouped/stacked bar mode or `xAxis` option. |
| `pie`, `donut` | `data: { label: string; value: number }[]` | `showLabels=false`, `legend=false`, `innerRadius?: number` (outer-radius fraction, clamped to 0–0.95; defaults: pie 0, donut 0.6). Only positive finite values produce slices. Prefer a legend for many small slices. |
| `sparkline` | `data: number[]` or `Point[]` | `smooth=true`, `area=false`, `showLast=false`, `showMinMax=false`. Numeric arrays use the original array index as X; points sort by X. |
| `histogram` | `data: number[]` of observations | `bins?: number` (equal-width bin count) or `number[]` (ordered bin edges); omitted uses `ceil(log2(n)) + 1`. `xAxis`, `yAxis`, `references`. Supply at least two distinct finite edges. Bins exclude the upper boundary except for the last bin. |
| `boxplot` | `groups: { label: string; values: number[] }[]` | `yAxis`, `references`, `showOutliers=true`, `colorByBox=false`. Tukey boxes: quartiles, median, whiskers at observed values within 1.5×IQR fences, and optional outliers. |
| `gauge` | `value: number` | `min=0`, `max=100`, `label?: string`, `unit?: string`, `format`, `thresholds`, `showNeedle=false`. |
| `barGauge` | `data: { label: string; value: number; min?: number; max?: number; unit?: string }[]` | Shared `min=0`, `max=100`, `unit`, `format`, `thresholds`. Item min/max/unit override shared values. |
| `stat` | `label: string`, `value: number \| string` | `unit`, `format`, `delta?: number \| string`, `deltaFormat?: (number) => string`, `trend?: "up" / "down" / "neutral"`, `sparkline?: number[] \| Point[]`. Trend derives from numeric delta; otherwise defaults to neutral. String values/deltas remain text; numeric delta gets a leading `+` when positive. |
| `heatmap` | `data: { x: string; y: string; value: number }[]` | `xLabels?: string[]`, `yLabels?: string[]` control category order; otherwise first appearance. `min`/`max` default to the observed domain; `format`, `showValues=false`. Missing cells have no inspected datum; the last entry for a repeated X/Y pair wins. |
| `map` | `series: { label?: string; data: { latitude: number; longitude: number; label?: string; size?: number }[] }[]` | `viewport?: { latitude: number; longitude: number; zoom: number }`, `sizeRange?: [number, number]` (default `[3, 12]` when sizes are present), `legend=false`. Use decimal degrees; zoom is normalized to 0–5. Omit viewport for the world view. No custom projection or map-layer prop. |
| `stateTimeline` | `rows: StateTimelineRow[]` | `states?: StateTimelineState[]`, `domain?: readonly [number, number]`, `xAxis?: { format?: (number) => string; label?: string }`, `legend=true`. Height defaults to `max(160, 38 + 24 * rows.length + 28 + (legend ? 24 : 0))` pixels. |

`Series` is `{ label?: string; data: Point[]; marker?: MarkerShape; lineStyle?: LineStyle }`.
`Point` requires numeric `x` and `y`. Optional fields are `size`, `errX`,
`errY`, `errXLow`, `errXHigh`, `errYLow`, and `errYHigh` (all numbers).
Error fields are relative magnitudes, not absolute bounds; asymmetric fields
override the symmetric error. `size` affects scatter markers only.
Marker shapes are `circle`, `square`, `triangle`, `diamond`, `plus`, `cross`.
Line styles are `solid`, `dashed`, `dotted`, `dashdot`. Per-series overrides win
over `autoVariant`. Non-finite coordinates are skipped.

`AxisOptions` supports `label?: string`, `format?: (value: number) => string`,
`ticks?: number` (suggested count, default 5), `scale?: "linear" | "log"`
(default linear), and `minorTicks?: boolean` (default false).
For line and scatter charts, log axes exclude non-positive coordinates. `references` is an array of
`{ value: number; axis?: "x" | "y"; label?: string }`; the default axis is Y.
Categorical bars ignore X references. There is no axis-domain prop; use the
specific `domain`, `min`, or `max` options only where listed.

Gauge, bar-gauge, stat, and heatmap `format` callbacks take a number and return
text. Gauge/bar-gauge/stat `unit` is appended verbatim after formatting, so use
`unit=" ms"` with a leading space and do not repeat the unit in `format`.
Gauge and bar-gauge normalize reversed bounds, widen equal bounds by one,
and clamp the visual indicator while retaining the finite actual value.

`thresholds` is `{ value: number; label?: string; color?: string }[]`.
Finite thresholds sort ascending. Bar-gauge bands and inspection threshold
metadata use the first inclusive upper bound containing the clamped value,
or the last threshold when no upper bound matches. Gauge coloring additionally interpolates
between color stops at threshold values; it is not a discrete alarm-state API.
Omitted colors use the series palette. Compute application alarm status from
your own domain rules rather than inferring it from a painted color.

Timeline rows are `{ label, href?, tooltip?, intervals }`; each interval is
`{ from: number; to: number; state: string; label?: string; href?: string; tooltip?: string }`.
States are `{ state: string; label?: string; color?: string }`.
Use a consistent numeric unit for from/to/domain (hours, seconds, or epoch
milliseconds); dates are not parsed automatically. Format ticks and tooltip
values in the same unit. Only local absolute-path links beginning with `/`
are rendered; `//host`, external URLs, and script URLs are not accepted.
Row links navigate from the row label; interval links navigate from the region.

## Data and sizing

Set the chart height explicitly with `style={{ height: "14rem" }}` or an application class. The exception is `stateTimeline`, which derives its height from the row count. Axes inherit `currentColor`; series use the shared chart color variables.

Empty series render a visible **No data** state. Keep loading and query errors outside the component so they are not confused with an empty result.

`labels` localizes package-owned text such as the empty state, series fallback,
interactive region names, zoom controls, and reset controls. Pass labels from
the host when the application is localized; the component never reads the
browser locale during SSR.

`interactive` enables inspection for all 14 chart kinds. Hover or tap a datum
to show its values; click or tap pins the tooltip and calls the optional
`onSelect` callback. Hover and focus never emit selection events. Escape,
focus leaving the chart, an outside tap, scrolling, resizing, and a data update
clear the inspection. Map and timeline dragging does not select data.

Line inspection groups the actual values at the nearest X coordinate across
series. Scatter plots and maps inspect individual points. Histograms expose
the rendered bin boundaries and counts; the final bin includes its upper edge.
Box plots expose quartiles, whiskers, sample counts, and individual outliers.
Pie and donut percentages use the sum of the rendered positive values. Gauges
report the actual value even when the visual indicator is clamped to its range.

`onSelect` receives a `ChartSelection` containing `kind` and a renderer-owned
`datum`: its role, source `index`, optional `seriesIndex`, label, anchor, and
raw value fields. Histogram indices identify computed bins; box-plot outliers
identify observations within their source group. References belong to the
current data snapshot. Retain application IDs in your source records when an
action must survive sorting or replacement of that snapshot.

Use `tooltip` to return a `ChartTooltip` with a title and labeled text rows.
The default tooltip uses axis/value formatters and the inherited UI locale.
Custom tooltip output is rendered as text, never interpreted as HTML. Each live chart example supplies domain-specific labels and units. The code example includes its tooltip formatter. Use these labels to explain what a value measures instead of showing raw X/Y coordinates.

```tsx
<Chart
  kind="bar"
  data={[{ label: "Imports", value: 42 }, { label: "Exports", value: 28 }]}
  style={{ height: "14rem" }}
  interactive
  onSelect={({ datum }) => setSelectedQueueIndex(datum.index)}
  tooltip={({ datum }) => ({
    title: datum.label,
    rows: datum.values.map((field) => ({
      label: "Jobs",
      value: String(field.value),
    })),
  })}
/>
```

Interactive line charts expose the nearest point through pointer and keyboard
inspection. Interactive maps use the supplied viewport as their reset point
and keep pan and zoom within geographic bounds.

State timelines use `StateTimelineRow` values containing bounded
`StateTimelineInterval` ranges. `domain` fixes the complete data range;
otherwise the chart derives it from the intervals. State definitions provide
visible labels and semantic colors. Row and interval `href` values remain
native links.

`StateTimelineChartOptions`, `StateTimelineDomain`,
`StateTimelineInterval`, `StateTimelineRow`, and `StateTimelineState` expose
the complete timeline contract for shared data builders.

## Tooltip and selection data

```ts
type ChartSelection = { kind: ChartKind; datum: ChartDatum };
type ChartTooltip = {
  title?: string;
  rows: readonly { label: string; value: string }[];
};
type ChartTooltipFormatter = (selection: ChartSelection) => ChartTooltip;
```

`ChartDatum` is exported by `@k2b/stdlib`; `ChartSelection` and the tooltip
types are exported by `@k2b/ui`. Its shape is:

```ts
type ChartDatum = {
  index: number;
  seriesIndex?: number;
  role: "point" | "item" | "bin" | "box" | "outlier" | "value" | "cell" | "interval";
  label?: string;
  anchor: [number, number];
  grid?: [number, number];
  values: { key: string; value: string | number; formatted?: string }[];
};
```

`values` is an array of named fields, not `datum.x` or `datum.y`. Find by key,
not array position. Optional fields may be absent. `formatted` preserves a
renderer formatter when available; raw `value` is for calculations and custom
units. Coordinates are not automatically timestamps or percentages.

| Kind / role | Index meaning | Value keys |
| --- | --- | --- |
| line/scatter `point` | `seriesIndex` → source series, `index` → source point | `x`, `y`; optional `size`, `errX`, `errY`, `errXLow`, `errXHigh`, `errYLow`, `errYHigh` |
| sparkline `point` | Original data index before filtering/sorting | `x`, `y`, optional point fields as above |
| bar `item` | Original item index | `value` |
| pie/donut `item` | Original slice index, including gaps from rejected slices | `value`, `percent` (0–100), `total` (sum of rendered positive values) |
| histogram `bin` | Computed bin index | `from`, `to`, `count`, `upperInclusive` (string `"true"` or `"false"`) |
| boxplot `box` | Source group index | `count`, `q1`, `q2` (median), `q3`, `whiskerLow`, `whiskerHigh` |
| boxplot `outlier` | `seriesIndex` → source group, `index` → original observation | `value` |
| gauge `value` | 0 | `value`, `min`, `max`, optional `threshold` (label or numeric bound) |
| barGauge `item` | Original item index | `value`, `min`, `max`, optional `threshold` |
| stat `value` | 0 | `value`, optional `delta` |
| stat `point` | Original history index | `x`, `y`, optional point fields |
| heatmap `cell` | Source data index of the last matching cell | `x`, `y` (category strings), `value` |
| map `point` | `seriesIndex` → source series, `index` → source point | `latitude`, `longitude`, optional `size` |
| stateTimeline `interval` | `seriesIndex` → source row, `index` → source interval | `state` (raw state key; visible name in `formatted`), `from`, `to`, `duration`; optional `detail` from interval tooltip or label |

`anchor` is in the containing SVG coordinate system, not CSS or viewport
pixels. `grid` is optional navigation metadata, not an application identifier.
Do not use either to look up source records. Indices are zero-based and refer
to the current input snapshot. Sorting/filtering performed by the renderer
does not renumber source indices. Bin indices describe derived data.

For a multi-series line, the tooltip formatter runs once per series point at
the inspected X; their outputs are grouped. It does not receive a combined
array. `onSelect` still emits one `ChartSelection`. A native timeline link
keeps navigation behavior instead of emitting an additional selection callback.

A domain-specific scatter tooltip can use raw values directly:

```tsx
<Chart
  kind="scatter"
  style={{ height: "14rem" }}
  series={[{ label: "Cached", data: [{ x: 50, y: 30 }] }]}
  interactive
  tooltip={({ datum }) => ({
    title: datum.label ?? "Response latency",
    rows: datum.values.flatMap(({ key, value }) =>
      key === "x" ? [{ label: "Payload size", value: `${value} KB` }]
      : key === "y" ? [{ label: "Response time", value: `${value} ms` }]
      : []),
  })}
/>
```

Formatter and selection callbacks run in the hydrated component. In an islands
app, define them inside the island; do not serialize functions through server
props. Pass serializable source data into the island. The SVG remains fully
server-rendered. Keep callbacks synchronous and free of render-time effects;
perform fetching or navigation in `onSelect`, not in the tooltip formatter.

## URL-owned ranges

`RangePicker` renders a small set of native range links. Each `RangeOption`
contains `value`, `href`, and an optional label. The selected value receives
`aria-current="true"`. `RangePickerProps<T extends string>` requires `value: T` and `options: readonly RangeOption<T>[]`. Optional props are `class`, `label?: string | null` (inherited “Window” caption; `null` hides it), and `ariaLabel?: string` (defaults to the caption or inherited range label). There is no `onChange`: each link navigates to its supplied `href`. Preserve unrelated URL parameters when building those links.

Use it beside a chart when the server owns the query window:

```tsx
<RangePicker
  value="24h"
  options={[
    { value: "1h", href: "?window=1h" },
    { value: "24h", href: "?window=24h" },
  ]}
/>
```

## Accessibility

Each interactive chart has one keyboard entry point. Arrow keys inspect data;
Home and End reach the first and last datum. Heatmaps navigate by row and
column, skipping absent cells. Enter selects the inspected datum; Escape closes
the tooltip. Native timeline links retain their link behavior.

Maps and timelines keep their existing arrow-key pan and `+`, `-`, and `0` reset
controls. Hold Alt with arrow keys, Home, or End to inspect their data instead.
Their named zoom and reset buttons remain separately reachable. Other chart
kinds expose inspection without adding pan or zoom.

Tooltip values are associated with the focused chart through `aria-describedby`.
SVG titles provide a text fallback without the enhanced tooltip. Touch scrolling
remains native on ordinary plots; maps and timelines retain their explicit drag
navigation.

Always provide the same conclusion in text. Do not make color, pointer hover, or the chart itself the only source of a status or exact value.

## Runtime

The complete SVG renders on the server and fits its container before JavaScript loads. Hydration and resizing keep the same chart geometry, so range navigation does not briefly show a smaller chart.

Cartesian plots fill the available width and height while labels and markers retain their size. Maps, pies, donuts, and gauges preserve their aspect ratio. Load `@k2b/ui/styles.css` in the page head so this layout applies to the first frame.

Hover, focus, and selection only change inspection paint and the out-of-flow
tooltip. Renderer-owned anchors are transformed through the actual SVG matrix,
including logarithmic axes, nested map viewports, and responsive sizing.

Reactive data rebuilds the complete SVG. This suits dashboard polling and normal realtime updates, not frame-by-frame animation.

Interactive charts require hydration. Static charts remain readable in the server response.

## Example

```tsx
<Chart
  kind="line"
  style={{ height: "14rem" }}
  series={[
    {
      label: "Requests",
      data: [
        { x: 1, y: 42 },
        { x: 2, y: 51 },
        { x: 3, y: 47 },
      ],
    },
  ]}
  xAxis={{ format: (value) => `${value}h` }}
  yAxis={{ format: (value) => `${value} req/s` }}
  legend
  smooth
  interactive
/>
```

```tsx
<Chart
  kind="map"
  style={{ height: "16rem" }}
  series={[
    {
      label: "Requests",
      data: [
        { latitude: 52.52, longitude: 13.405, label: "Berlin" },
      ],
    },
  ]}
  interactive
/>

<Chart
  kind="stateTimeline"
  rows={[
    {
      label: "Worker",
      intervals: [
        { from: 0, to: 4, state: "ok", tooltip: "Succeeded" },
      ],
    },
  ]}
  states={[{ state: "ok", label: "Healthy", color: "#10b981" }]}
  domain={[0, 10]}
  interactive
/>
```
