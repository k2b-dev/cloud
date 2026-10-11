# Charts

`cloud.chart(options)` returns chart markup in Cloud colors. Use it as
`innerHTML`, inside `cloud.html`, or in the HTML of `cloud.pdf.render`. It needs
no DOM, so it works the same in apps, scripts and PDFs. In an app, cartesian
charts redraw at their real width, so axes and labels fit phones.

For computed values in the chat, call `cloud.view.chart`, `cloud.view.group` or
`cloud.view.table` in the run, then `present({path})`; read [Views in the chat](views.md). The
`chart` tool is for a few values that did not come from a run. Neither choice
needs an app. Views use plain data, without drawing functions.

```js
const chart = document.querySelector("#chart");
const draw = (data) => {
  chart.innerHTML = cloud.chart({ kind: "bar", title: "Orders by region", data });
};
draw([{ label: "North", value: 12 }, { label: "South", value: 8 }]);
document.querySelector("#refresh").addEventListener("click", () => draw([{ label: "North", value: 16 }, { label: "South", value: 10 }]));
```

`cloud.chart()` validates with the same chart contract and uses the same options
mapping as chat charts. The canonical payloads and options are:

| Kind | Required options | Optional options |
| --- | --- | --- |
| `bar` | `data: [{label, value}]` | `yAxis`, `colorByBar`, `showValues`, `legend`, `references` |
| `line`, `scatter` | `series: [{label?, data: [{x, y}], role?}]` | `xAxis`, `yAxis`, `legend`, `references`; line also `area`, `smooth`, series `style` |
| `pie`, `donut` | `data: [{label, value}]` | `legend`, `showLabels`, `format` |
| `histogram` | `data: number[]` | `bins` (count or ascending edges), `references` |
| `gauge` | `value` | `min`, `max`, `label`, `unit`, `format`, `thresholds` |
| `sparkline` | `data: number[]` | `area` |
| `boxplot` | `data: [{label, values: number[]}]` | `yAxis`, `references` |
| `heatmap` | `data: [{x, y, value}]`, text categories, each pair once | `min`, `max`, `showValues`, `format` |
| `barGauge` | 1..8 `data` items `{label, value, min?, max?}`; labels at most 10 characters | shared `min`, `max`, `unit`, `format`, `thresholds` |
| `stat` | `value` | `unit`, `format`, `delta`, `better: "up" | "down"`, `sparkline` |

All kinds accept `title` and `subtitle`; together they name the chart for screen
readers (`role="img"`). An axis takes `label`, `domain: [min, max]`, `ticks`
(2..12), `scale: "linear" | "log"` and declarative `format`. Number formats are
`{style?: "number" | "percent" | "currency", currency?, unit?, decimals?, compact?}`;
percent takes fractions. Currency requires an uppercase three-letter code
exactly when style is currency; decimals is 0..10, unit at most 12 characters.
Date x axes take `{date: "day" | "minute" | "second"}`. Function `format(value)`
still works on axes and values. Without a format, values use the viewer's locale.
With `showValues` on bars, y ticks use the value format. Pie and donut slices
show shares; a value format does not change them.

x may be a number, `Date` or ISO date string. Dates and ISO instants with an offset
become the viewer's wall-clock time; converted x values all at midnight become
`YYYY-MM-DD`. Date references become wall-clock date-time strings.
For references, thresholds and series `style`/`role`, read
[Views in the chat](views.md#chart-options). Line reference series default to
dashed unless style is set. Scatter reference points are hollow in chat;
`cloud.chart()` retains filled points. Stat `delta` is in the value's units;
`better` lets the host choose the change color.

`width` and `height` set the logical drawing size: default 480 × 280, sparkline
160 × 40. Stretched charts redraw at their measured width in apps when `width`
is omitted; pie, donut and gauge keep their aspect ratio. Long category names
remain complete; every n-th label shows when they do not fit. Add a table in
`<details>` below the chart when readers need exact values.

Values must be finite. The chart data limits match
[views](views.md#references-limits-and-errors): 8 series, 480 points per series
or ordinary list, 480 boxplot groups and 3,840 total input marks (or heatmap cells). Contract violations throw
`error.code === "invalid"`: field errors name paths such as
`series[0].data`, chart-wide checks explain the reason. More than 480 points
per series, mixed x types, out-of-domain values or undrawable charts fail.
Aggregate before drawing. Stdlib-only options outside the contract are ignored.
There is no second y axis, group renderer, or grouped/stacked bar mode
([upstream issue](https://github.com/k2b-dev/stdlib/issues/5)); use
`cloud.view.group` for related computed measures in chat.
