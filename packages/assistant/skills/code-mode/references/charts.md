# Charts

See [Analytics UI](analytics.md) for formats, selection, and Chart Explorer.

Use `ui.chart({data:{options}})` for charts rendered by the host. Values must be finite
numbers. The host handles sizing and theme colors; do not generate SVG or HTML.

```js
export default () => {
  const chart = ui.chart({data:{options:{
    kind:"bar", data:[{label:"North",value:12},{label:"South",value:8}]
  }}});
  ui.button({label:"Refresh", onClick: () => chart.setData({options:{
    kind:"bar", data:[{label:"North",value:16},{label:"South",value:10}]
  }})});
};
```

`chart.setData({options})` replaces the complete chart configuration. Keep the handle
instead of creating a chart on every refresh. Charts do not use `upsert` or
`remove`; update their data through `setData`.

| Kind | Required data |
| --- | --- |
| `bar`, `pie`, `donut` | `data: [{ label, value }]` |
| `line`, `scatter` | `series: [{ label?, data: [{ x, y }] }]` |
| `sparkline` | `data: number[]` or `data: [{ x, y }]` |
| `histogram` | `data: number[]`; optional `bins` count or boundaries |
| `boxplot` | `groups: [{ label, values: number[] }]` |
| `gauge` | `value`; optional `min`, `max`, `label`, `unit` |
| `barGauge` | `data: [{ label, value, min?, max?, unit? }]` |
| `stat` | `label`, `value` (number or text); optional `unit`, `delta`, `trend` |
| `heatmap` | `data: [{ x: string, y: string, value: number }]` |

All listed charts except sparkline accept `title` and `subtitle`. Line charts
accept `smooth`, `area`, `legend`, and `interactive` booleans. Bar charts accept
`legend`, `showValues` and `colorByBar`. Pie and donut charts accept `showLabels` and
`innerRadius` from 0 to 0.95. Stat `trend` is `up`, `down`, or `neutral`.

Use at most 1,000 values per array. Aggregate large datasets before rendering.
The schema is strict: omit unsupported options rather than copying options from
another chart library. Invalid configurations throw and appear in diagnostics.

`map` accepts `series: [{label?,data:[{latitude,longitude,label?,size?}]}]`, optional `viewport:{latitude,longitude,zoom}`, `sizeRange`, `legend`, and `interactive`.
`stateTimeline` accepts `rows:[{label,intervals:[{from,to,state,label?}]}]`, optional `states:[{state,label?,color?}]`, `xAxis:{label?}`, and `legend`. Time coordinates are numbers in one explicitly chosen unit.
Axes support increasing `domain:[min,max]` to keep comparison bounds fixed.
The 1,000-entry budget also applies to the total across nested arrays.

## Additional accepted options

These options apply unless the presentation supplies a
format or selection behavior. Omit properties that are not listed for the kind.

- Cartesian axes (`line`, `scatter`, `histogram`) accept `xAxis` and `yAxis`;
  `bar` and `boxplot` accept `yAxis`. Each axis supports `label`, `ticks` (1–100),
  `scale: "linear" | "log"`, `minorTicks`, and increasing `domain: [min,max]`.
  Use positive domains and coordinates for logarithmic scales.
- `references: [{value,axis?:"x"|"y",label?}]` is accepted by line, scatter,
  histogram, bar, and boxplot. The default axis is Y.
- Series can set `marker: "circle" | "square" | "triangle" | "diamond" |
  "plus" | "cross"` and `lineStyle: "solid" | "dashed" | "dotted" | "dashdot"`.
  Points accept `size`, `errX`, `errY`, `errXLow`, `errXHigh`, `errYLow`, and
  `errYHigh`. Errors are distances from the value, not absolute endpoints.
- Line additionally accepts `step: "before" | "after" | "middle"`,
  `autoVariant`, and `errorBand`. Scatter accepts `legend`, `autoVariant`,
  `trendline`, and `sizeRange: [min,max]` for positive marker sizes.
- Sparkline accepts `smooth`, `area`, `showLast`, and `showMinMax`.
  Boxplot accepts `showOutliers` and `colorByBox`.
- Gauge and bar gauge accept `thresholds: [{value,label?,color?}]`.
  Gauge also accepts `showNeedle`. Bar gauge accepts common `min`, `max`, and
  `unit`, overridden by each row's values.
- Stat accepts `sparkline: number[] | {x,y}[]` in addition to its value/delta.
  Heatmap accepts `xLabels`, `yLabels`, `min`, `max`, and `showValues`.
- All kinds except sparkline accept `title`, `subtitle`, and bounded `padding`
  (a number or `{top?,right?,bottom?,left?}`, each 0–200). Prefer surrounding UI
  sections for consistently placed titles. Host layout owns width and height.

The UI uses `data.formats` instead of transporting formatting functions.
Use explicit mark tooltips for domain labels or derived values. An Explorer
with field mappings derives tooltip labels and formats from its columns.


## Mark identifiers for selection

Use these identities in `data.marks`; `index` and `seriesIndex` are zero-based
indices in the original input, not screen positions or sorted order. Omit
`seriesIndex` where the table says none.

| Chart | `role` | `index` / `seriesIndex` |
| --- | --- | --- |
| bar, pie, donut, barGauge | `item` | data item / none |
| line, scatter, map | `point` | point within series / series |
| sparkline | `point` | data point / none |
| histogram | `bin` | computed bin / none |
| boxplot | `box` | group / none |
| boxplot outlier | `outlier` | value within original group / group |
| gauge, stat summary | `value` | 0 / none |
| stat sparkline | `point` | sparkline point / none |
| heatmap | `cell` | data item / none |
| stateTimeline | `interval` | interval within row / row |

For histogram mappings, provide explicit increasing bin boundaries so the bin
indices and corresponding summary rows are known. Use field-mapped Explorers
for ordinary bar/pie/donut/line/scatter views to avoid manual mark construction.
