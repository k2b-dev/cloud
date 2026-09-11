# Charts

Use `ui.chart(options)` for charts rendered by the host. Values must be finite
numbers. The host handles sizing and theme colors; do not generate SVG or HTML.

```js
export default () => {
  const chart = ui.chart({
    kind: "bar", title: "Tasks by status", showValues: true,
    data: [{ label: "Open", value: 4 }, { label: "Done", value: 7 }]
  });
  ui.button("Refresh", () => chart.set({
    kind: "bar", title: "Tasks by status", showValues: true,
    data: [{ label: "Open", value: 3 }, { label: "Done", value: 8 }]
  }), { id: "refresh" });
};
```

`chart.set(options)` replaces the complete chart configuration. Keep the handle
instead of creating a chart on every refresh. Charts do not use `upsert` or
`remove`; update their data through `set`.

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
`showValues` and `colorByBar`. Pie and donut charts accept `showLabels` and
`innerRadius` from 0 to 0.95. Stat `trend` is `up`, `down`, or `neutral`.

Use at most 1,000 values per array. Aggregate large datasets before rendering.
The schema is strict: omit unsupported options rather than copying options from
another chart library. Invalid configurations throw and appear in diagnostics.
