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
| `cursor` | Optional `ChartCursor` from `createChartCursor()`. Connects line charts by numeric X value; other kinds ignore it. Hover is independent of `selected` and does not reload data or rebuild SVG. |
| `selected` | Optional `ChartDatumRef \| null`: `{ role, index, seriesIndex? }` using the current input snapshot. Highlights a datum without selecting it or opening a tooltip. Missing references paint nothing. Map stable application IDs to these indices after every data replacement. |
| `tooltip` | Synchronous `(selection: ChartSelection) => ChartTooltip`. Used only with `interactive`. Omit for the built-in tooltip. Does not accept JSX, HTML, or a promise. |
| `onSelect` | Optional synchronous `(selection: ChartSelection) => void`. Click, tap, and Enter emit selection; hover and focus do not. Use `selected` for a controlled highlight. |

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
| `bar` | `data: { label: string; value: number }[]` | `yAxis`, `references`, `colorByBar=false`, `showValues=false`, `legend=false` (used only with `colorByBar`). Negative values are supported; baseline includes zero. Items accept `colorIndex?: number` when `colorByBar` is enabled. No grouped/stacked bar mode or `xAxis` option. |
| `pie`, `donut` | `data: { label: string; value: number }[]` | `showLabels=false`, `legend=false`, `innerRadius?: number` (outer-radius fraction, clamped to 0–0.95; defaults: pie 0, donut 0.6). Items accept `colorIndex?: number`. Only positive finite values produce slices. Prefer a legend for many small slices. |
| `sparkline` | `data: number[]` or `Point[]` | `smooth=true`, `area=false`, `showLast=false`, `showMinMax=false`. Numeric arrays use the original array index as X; points sort by X. |
| `histogram` | `data: number[]` of observations | `bins?: number` (equal-width bin count) or `number[]` (ordered bin edges); omitted uses `ceil(log2(n)) + 1`. `xAxis`, `yAxis`, `references`. Supply at least two distinct finite edges. Bins exclude the upper boundary except for the last bin. |
| `boxplot` | `groups: { label: string; values: number[] }[]` | `yAxis`, `references`, `showOutliers=true`, `colorByBox=false`. Tukey boxes: quartiles, median, whiskers at observed values within 1.5×IQR fences, and optional outliers. |
| `gauge` | `value: number` | `min=0`, `max=100`, `label?: string`, `unit?: string`, `format`, `thresholds`, `showNeedle=false`. |
| `barGauge` | `data: { label: string; value: number; min?: number; max?: number; unit?: string }[]` | Shared `min=0`, `max=100`, `unit`, `format`, `thresholds`. Item min/max/unit override shared values. |
| `stat` | `label: string`, `value: number \| string` | `unit`, `format`, `delta?: number \| string`, `deltaFormat?: (number) => string`, `trend?: "up" / "down" / "neutral"`, `sparkline?: number[] \| Point[]`. Trend derives from numeric delta; otherwise defaults to neutral. String values/deltas remain text; numeric delta gets a leading `+` when positive. |
| `heatmap` | `data: { x: string; y: string; value: number }[]` | `xLabels?: string[]`, `yLabels?: string[]` control category order; otherwise first appearance. `min`/`max` default to the observed domain; `format`, `showValues=false`. Missing cells have no inspected datum; the last entry for a repeated X/Y pair wins. |
| `map` | `series: { label?: string; data: { latitude: number; longitude: number; label?: string; size?: number }[] }[]` | `viewport?: { latitude: number; longitude: number; zoom: number }`, `sizeRange?: [number, number]` (default `[3, 12]` when sizes are present), `legend=false`. Use decimal degrees; zoom is normalized to 0–5. Omit viewport for the world view. `zoomFocus?: { latitude: number; longitude: number }` defaults to Europe (`{ latitude: 50, longitude: 10 }`) and sets the center only when zooming in from zoom 0. Coordinates are clamped to the bounds of the new zoom level. Further zooming preserves the current center, including after panning. Use `{ latitude: 0, longitude: 0 }` for a neutral target. Reset still restores `viewport` or the world view. No custom projection or map-layer prop. |
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
(default linear), `minorTicks?: boolean` (default false), and optional exact
`domain?: [number, number]` comparison bounds. See the snapshot section for domain validation.
For line and scatter charts, log axes exclude non-positive coordinates. `references` is an array of
`{ value: number; axis?: "x" | "y"; label?: string }`; the default axis is Y.
Categorical bars ignore X references. Use the
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

Cartesian plots fill the available width and height while labels and markers retain their size. At zoom zero, maps fit the complete world without cropping or distortion; shallow containers leave space on either side. Each zoom level doubles the geographic scale from that fitted world view, without changing the fitting mode. Zoomed content can use the full plot width and is clipped only at its edges. Titles and legends stay outside the geographic crop. Pies, donuts, and gauges preserve their aspect ratio. Load `@k2b/ui/styles.css` in the page head so this layout applies to the first frame.

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

## Explore data with ChartExplorer

`ChartExplorer` presents one chart, a sortable table, copy action and selection
Paper. `createChartExplorer` owns loading and shared selection for **one or more**
charts. `ChartExplorerControls` adds the optional dimension slider, series filter
and reference actions. All three work in Solid applications; they are not a
Vanilla-JS widget that attaches itself to arbitrary HTML.

Use the ordinary `Chart` for a small reactive plot or local map/timeline pan and
zoom. Explorer snapshots support inspection and selection for every chart kind;
their map/timeline viewports remain snapshot-owned.

### Prepare geometry and identify records

`prepareChartSnapshot(options: ChartRenderOptions, inspection)` returns a
`ChartSnapshot`. This function runs in the server or browser runtime. An SSR app
calls it on the server and sends only the result to its island. A client dashboard
can call it locally. Its options are the renderer's `kind` and data/options, not
component props: `style`, `class`, `labels`, `selected`, `onSelect`, `tooltip` and
`interactive` are deliberately excluded. Inspection is always enabled.

| Inspection option | Contract |
| --- | --- |
| `key(selection)` | Required unique, nonempty mark key. Indices locate source inputs but are not durable keys. |
| `rowKey(selection)` | Optional nonempty row key; defaults to `key(selection)` for one-to-one data. Multiple marks may share a row key. |
| `tooltip(selection)` | Required synchronous `ChartTooltip` formatter. Return meaningful labels, units and formatted strings. |
| `reference(selection)` | Optional boolean; renders reference scatter points and bars hollow in their series color. Does not calculate or pair comparison values. |

```ts
type ChartSnapshot = {
  kind: ChartKind;
  svg: string;
  width: number;
  height: number;
  stretch: boolean;
  marks: readonly {
    key: string;
    rowKey: string;
    datum: ChartDatum;
    tooltip: ChartTooltip;
    reference?: boolean;
  }[];
};
type ChartExplorerRow = { key: string };
type ChartExplorerData<T extends ChartExplorerRow = ChartExplorerRow> = {
  chart: ChartSnapshot;
  rows: readonly T[];
};
type ChartExplorerCharts = Readonly<Record<string, ChartExplorerData>>;
type ChartExplorerRequest = {
  step?: string;
  visibleKeys?: readonly string[];
  referenceStep?: string;
};
type ChartExplorerSnapshot<C extends ChartExplorerCharts> = {
  request: ChartExplorerRequest;
  charts: C;
};
```

Each row describes one selectable entity. Its key is unique within its chart.
Each mark key is also unique within its chart, and every `mark.rowKey` must resolve
to a row. A row may have no mark, for example a missing observation. Selection
highlights **all** marks of that row; tooltips still describe the individual mark.
The same row key in different charts links the same entity, not equal values or a
causal relationship. Different charts retain their own inferred row types.

For comparison, use one row such as
`{ key: "cached:40", current: 30, reference: 24 }`. Give its two marks distinct keys
`cached:40:current` and `cached:40:reference`, both with `rowKey: "cached:40"`.
The table and copy output contain one row, independent of mark order. There is no
implicit deduplication or aggregation in the explorer.

Treat snapshots as immutable trusted renderer output. Never accept arbitrary
user-supplied SVG for `chart.svg`. Across SSR/JSON boundaries, row data must also be
serializable; TypeScript row types alone do not enforce JSON serialization. Layout
uses a fixed logical width of 480 and height of 280, except row-derived timeline
height. CSS sizes the SVG before hydration without measuring/rebuilding it.

### One controller for local and remote data

```tsx
import { createChartExplorer, ChartExplorer, ChartExplorerControls,
  prepareChartSnapshot, type ChartExplorerRequest } from "@k2b/ui";

const initialRequest = { visibleKeys: ["imports", "exports"] };
function buildSnapshot(request: ChartExplorerRequest) {
  const source = [{ key: "imports", label: "Imports", jobs: 42 },
    { key: "exports", label: "Exports", jobs: 28 }];
  const rows = source.filter(row => !request.visibleKeys || request.visibleKeys.includes(row.key));
  const chart = prepareChartSnapshot({ kind: "bar", colorByBar: true,
    data: rows.map(row => ({ label: row.label, value: row.jobs,
      colorIndex: source.findIndex(item => item.key === row.key) })),
    yAxis: { domain: [0, 60] },
  }, {
    key: ({ datum }) => rows[datum.index]!.key,
    tooltip: ({ datum }) => ({ title: rows[datum.index]!.label,
      rows: [{ label: "Jobs", value: String(rows[datum.index]!.jobs) }] }),
  });
  return { request, charts: { queues: { chart, rows } } };
}

export function QueueDashboard() {
  const initial = buildSnapshot(initialRequest);
  const explorer = createChartExplorer({ snapshot: () => initial,
    load: buildSnapshot,
  });
  return <>
    <ChartExplorerControls explorer={explorer} title="Queue dashboard"
      series={[{ key: "imports", label: "Imports", color: "var(--stdlib-chart-c1)" },
        { key: "exports", label: "Exports", color: "var(--stdlib-chart-c2)" }]} />
    <ChartExplorer title="Completed jobs" data={explorer.snapshot().charts.queues}
      selectedKey={explorer.selectedKey()} onSelectedKeyChange={explorer.select}
      columns={[{ id: "queue", label: "Queue", value: row => row.label },
        { id: "jobs", label: "Jobs", value: row => String(row.jobs), sortValue: row => row.jobs }]} />
  </>;
}
```

The initial object and every loaded response must contain exactly the configured
chart IDs. Types preserve those names and each chart's row type; do not widen the
initial charts to `Record<string, …>` if their names are known. Rows/marks are
validated before adopting a response. All charts update together.

`ChartExplorerOptions<C>` requires `snapshot: () => ChartExplorerSnapshot<C>` and
`load: (request, signal) => ChartExplorerSnapshot<C> | Promise<ChartExplorerSnapshot<C>>`.
Create the controller in a Solid owner. The initial snapshot is displayed without
a fetch. Replacing the snapshot accessor's result cancels pending work, clears the
error and adopts the replacement. Chart IDs cannot change during its lifetime.

Optional `request: () => ChartExplorerRequest` enables controlled filters and
requires `onRequestChange(request)`. `setRequest` then emits a proposal; loading
starts when the owner updates that accessor. Without controlled filters,
`setRequest` starts loading and optionally notifies `onRequestChange`. A controlled
request differing from the supplied snapshot is loaded after mounting. Keep them
equal for coherent initial SSR output. Replacements reapply controlled filters.

Optional `selectedKey: () => string | null` enables controlled selection and
requires `onSelectedKeyChange(key)`. Without it, selection is internal and starts
at `null`. Unknown keys are ignored. Internal selection clears when its row is
absent from every chart; controlled selection is not overwritten, but absent rows
are not highlighted. The owner decides when to clear a controlled key.

| Controller member | Behavior |
| --- | --- |
| `snapshot()` | Last successful complete snapshot. |
| `desired()` | Filters currently being requested; may differ from displayed filters. |
| `loading()` | Whether a request is pending. |
| `error()` | Original `Error` or `null`; non-Error rejections are wrapped with `cause`. |
| `selectedKey()`, `select(key)` | Read/propose entity selection, or clear with `null`. Selection does not filter or fetch. |
| `setRequest(next)` | Replace requested filters; returns `void`. Equal displayed filters reuse existing data. |
| `refresh()` | Force a fresh load of the desired filters, even when unchanged. Returns `Promise<void>`. |
| `retry()` | Force another attempt for desired filters; same return contract as refresh. |
| `pinReference()` | Set reference to the displayed step; no-op without a step. |
| `clearReference()` | Remove the reference while retaining other desired filters. |

Omit `step` when there is no dimension. Omit `visibleKeys` for no series filter;
`[]` explicitly hides all series. Keys must be nonempty and unique. A reference
requires a current step. Filters compare series as sets. `setRequest` replaces the
whole request, so spread `explorer.desired()` when changing only one field.
Additional domain filters, permissions, source queries and aggregation remain
application-owned; change those dependencies and call `refresh()` as needed.

Every new load aborts superseded work; stale responses are ignored even when the
loader ignores the signal. Forward the signal to `fetch`. Invalid responses and
loader errors retain every previous chart and set `error()`. Request promises
settle after handling failures; they do not rethrow loader errors. Read `error()`
for the outcome. Invalid caller-supplied request keys are programming errors and
throw. Disposal aborts work; refresh after disposal does not load.

### Chart presentation and controls

| `ChartExplorerProps<T>` | Contract |
| --- | --- |
| `title`, `data`, `columns` | Required heading, `ChartExplorerData<T>`, and nonempty columns with unique nonempty IDs. |
| `selectedKey`, `onSelectedKeyChange` | Optional controlled row selection. Omit key for local selection. A missing local row never clears a sibling's controlled selection. |
| `view`, `onViewChange` | Optional controlled `"chart" \| "table"`. Otherwise, `defaultView` initializes local view; default `"chart"`. |
| `sort`, `onSortChange` | Optional controlled `DataTableSort \| null`. Otherwise `defaultSort` initializes local sort; default `null`. |
| `renderDetails` | Optional row renderer replacing the DescriptionList inside the selection Paper. `false` hides the whole local detail area, for a parent-owned shared Paper. |
| `description`, `class` | Optional JSX below the heading and extra root class. |
| `cursor` | Optional shared `ChartCursor` for a line snapshot. Same matching and lifecycle as `Chart.cursor`; table mode does not participate. |
| `height` | CSS viewport height; default `"18rem"`, shared by chart and scrollable table. |

```ts
type ChartExplorerColumn<T> = {
  id: string;
  label: string;
  value: (row: T) => string;
  render?: (row: T) => JSX.Element;
  sortValue?: (row: T) => string | number | null;
  align?: "left" | "center" | "right";
};
```

`value` is plain text for copy and default details. `render` optionally customizes
the table cell, such as a current value with a muted reference and change below.
Include the same reference information in `value` so copying remains complete.
`sortValue` opts into sorting: finite numbers compare numerically, strings use the
inherited locale, and nulls stay last in both directions. Default click order is
ascending, then descending. Sort and view changes never load data. Controlled props
stay owner-owned until the corresponding value is updated. Sorting only rearranges
the supplied rows; copy includes all rows in that order, not just the scroll window,
as escaped tab-separated text with column headings. Clipboard failures appear inline.

`ChartExplorerControlsProps<C>` requires `explorer` and `title`; optional `steps`
are ordered `{ key, label }` entries, optional `series` entries are
`{ key, label, color }`, and `dimensionLabel` defaults to the inherited range label.
Option keys must be nonempty and unique within each list.
The slider is omitted without steps and disabled with fewer than two. Reference
buttons appear only with configured steps and a displayed step. A multi-select
series menu supports an empty selection; Reset restores all configured series.
Series colors must match the renderer palette. During loading, a reserved spinner
before the reference buttons appears after 200 ms; buttons do not shift. The
accessible status names the old displayed step. Failures expose Retry. Pinning is
disabled while loading, on failure, or when the displayed step is already pinned.

For a shared Paper, set `renderDetails={false}` on the chart components and read
`explorer.selectedKey()` and the matching rows in `explorer.snapshot().charts` in
the parent. Use a single shared selection action, with clearly named metrics.

### Synchronized inspection

Create one cursor per group in the Solid component owner and pass it to each
`Chart` or `ChartExplorer`. Do not create it inside a reactive expression or pass
it through an SSR JSON boundary. The server still renders complete SVGs; the
client cursor only coordinates inspection. Independent groups use separate cursors.

```tsx
import { Chart, createChartCursor } from "@k2b/ui";

const cursor = createChartCursor({
  formatX: (timestamp) => new Date(timestamp).toISOString(),
});

<Chart kind="line" series={latency} cursor={cursor} interactive />
<Chart kind="line" series={requests} cursor={cursor} interactive />
// Existing server-prepared explorer data works with the same cursor:
<ChartExplorer title="Errors" data={errors} columns={columns} cursor={cursor} />
```

`createChartCursor({ formatX? })` returns a controller to pass as `cursor`.
`formatX` optionally formats the shared numeric X value as each tooltip's heading.
Use the same X units in the group, for example, Unix milliseconds. Chart sizes,
Y domains and Y units may differ. Existing `tooltip` formatters and snapshot
`marks[].tooltip` provide the rows; return only the metric rows when `formatX`
already supplies the time heading. Series colors are taken from the chart.

The active plot snaps to its nearest sample. Other charts match that exact X;
there is no interpolation or nearest-value substitution across gaps. Missing
series values appear as `—`. A chart with no matching sample hides its tooltip
and guide rather than showing a value from another time. Entirely absent series
have no metadata and are omitted. Use aligned samples for a continuous shared
cursor, as the monitoring showcase does.

Each participating chart shows a vertical guide at its own matching data point.
A horizontal guide follows the pointer only in the active plot. Pointer movement
is restricted to the plot, excluding axes and legends. Arrow keys also share the
inspected X value; Escape or leaving the active chart dismisses inspection.
Existing click/tap selection and tooltip pinning remain separate from transient
hover. Updating or unmounting the active chart clears the shared cursor; updating
a follower rechecks the current X against its new data. Hover never changes
selection, reference, sorting, filters, or URL state.

### Three integration paths

- **Client dashboard:** build the initial snapshot from local data and let `load`
  synchronously rebuild it. The second live example maps two synthetic delivery routes over thirteen time steps and
  no data endpoint. A fully client-rendered Solid entry can render the same
  component; its initial builder runs in the browser.
- **SSR app:** build initial snapshots on the server and pass serializable data
  into an island. Define `load` and UI callbacks inside that island. Its loader
  fetches an application-owned endpoint that validates filters, enforces access
  and calls the same server builder. The first example parses filters from the
  URL before SSR; controlled filters preserve them through history and reload.
  View and sort props can similarly be bound to an application's router.
- **Static report:** prepare a deliberately bounded set of snapshots at build
  time. `load` finds the matching embedded snapshot without fetching or rendering.
  The third example contains 224 states: seven times, eight reference choices
  (including none), and four series subsets. Precomputing arbitrary combinations
  grows exponentially; use local computation or a server loader beyond such a
  small explicit domain.

The explorer does not provide a router, HTTP endpoint, database, automatic polling,
or table pagination. It is intended for bounded chart datasets. Keep datasets and
updates bounded for both SVG rendering and local table processing; use the
application's data access layer for larger collections.

### Comparison semantics

Use identical units and explicit axis domains containing both periods. Retain
series slots for line/scatter/map and explicit `colorIndex` for colored bar items
so filtering does not recolor entities. For bars, place current/reference marks
adjacently. For line comparisons, use separate series with `lineStyle: "dashed"`;
the reference callback does not restyle line paths.

Missing observations stay missing. A zero reference permits an absolute difference
but no percentage change. The SSR example intentionally includes missing data at
11:00 and zero requests for cached 10 KB at 08:00. Bar value labels make those
zeros visible instead of looking like missing bars. Comparison arithmetic and
formatted change text belong to the data builder, not the generic controller.
