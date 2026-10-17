# Charts

`cloud.chart(options)` returns chart markup in Cloud colors. Use it as
`innerHTML`, inside `cloud.html`, or in the HTML of `cloud.pdf.render`. It needs
no DOM, so it works the same in apps, scripts and PDFs. In an app, cartesian
charts redraw at their real width, so axes and labels fit phones. App charts show
tooltips by default on hover, keyboard focus and tap. Tab to a chart, use arrow
keys or Home/End to inspect values, and press Escape to close the tooltip;
tapping outside the chart also closes it.

For computed values in the chat, call `cloud.view.chart`, `cloud.view.group`,
`cloud.view.table`, `cloud.view.stats`, `cloud.view.details` or `cloud.view.explorer`
in the run, then `present({path})`; read [Views in the chat](views.md). The
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

`cloud.chart()` takes the same kinds and options as chat charts and draws them the
same way:

| Kind | Required options | Optional options |
| --- | --- | --- |
| `bar` | `data: [{label, value}]` | `yAxis`, `colorByBar`, `showValues`, `legend`, `references` |
| `line`, `scatter` | `series: [{label?, data: [{x, y}], role?}]` | `xAxis`, `yAxis`, `legend`, `references`; line also `area`, `smooth`, series `style` |
| `pie`, `donut` | `data: [{label, value}]` | `legend`, `showLabels`, `format` |
| `histogram` | `data: number[]` | `bins` (count or ascending edges), `references` |
| `gauge` | `value` | `min`, `max`, `label`, `unit`, `format`, `thresholds` |
| `sparkline` | `data: number[]` | `area` |
| `boxplot` | `data: [{label, values: number[]}]` | `yAxis`, `references` |
| `heatmap` | `data: [{x, y, value}]`, each pair once | `min`, `max`, `showValues`, `format` |
| `barGauge` | `data: [{label, value, min?, max?}]` | shared `min`, `max`, `unit`, `format`, `thresholds` |
| `stat` | `value` | `unit`, `format`, `delta`, `better: "up" | "down"`, `sparkline` |

All kinds accept `title` and `subtitle`; together they name the chart for screen
readers (an image in static markup, an interactive group in apps). An axis
takes `label`, `domain: [min, max]`, `ticks` (2..12), `scale: "linear" | "log"`
and declarative `format`. Number formats are
`{style?: "number" | "percent" | "currency", currency?, unit?, decimals?, compact?}`;
percent takes fractions. Currency requires an uppercase three-letter code
exactly when style is currency; decimals is 0..10, unit at most 12 characters.
Date x axes take `{date: "day" | "minute" | "second"}`. Function `format(value)`
still works on axes and values. Without a format, values use the viewer's locale.
With `showValues` on bars, y ticks use the value format. Pie and donut slices
show shares; a value format does not change them.

All kinds also accept `tooltip: {label?, format?}` as plain data. `label` names
the numeric value or y column in tooltips and the data table; `format` takes the
number format above, without date formats or functions. For example,
`tooltip: {label: "Umsatz", format: {style: "currency", currency: "EUR"}}`.
Counts, shares, x values and axis ticks keep their formats; a kind's `unit`
remains appended. Tooltips in apps use the same text as chat tooltips and data
tables. Give charts a meaningful title, series labels, axis labels and `tooltip`
field so readers can identify each value. Function formats also apply to tooltip
values when `tooltip.format` is absent: `format` takes precedence over
`yAxis.format`, and `xAxis.format` formats x values and histogram bounds.

x may be a number, `Date` or ISO date string. `YYYY`, `YYYY-MM`, `YYYY-MM-DD` and
date-times without an offset (`T` or a space, fractions dropped) stay the
wall-clock time as written. Dates and strings with an offset become the viewer's
wall-clock time. When every date is at midnight, the axis shows days. Labels
may be numbers. Date references become wall-clock date-time strings.
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

An app redraws with whatever its filters leave, so the data never makes
`cloud.chart()` throw by its size: empty data draws an empty chart, a one-point
line a single point, and `null`, `undefined` or non-finite values are left out.
The chat's limits on series, points, labels and phone-width fit apply only to
views and the `chart` tool. Still aggregate before drawing; thousands of points
make a slow and unreadable chart. Unknown kinds, wrong option types, a fixed
`domain` that does not contain every value, and values too close for their size
to label an axis (such as `1e17` and `1e17 + 16`) throw `error.code === "invalid"`
with a path such as `series[0].data[2].x`. Stdlib-only options outside the
contract are ignored.
There is no second y axis, group renderer, or grouped/stacked bar mode
([upstream issue](https://github.com/k2b-dev/stdlib/issues/5)); use
`cloud.view.group` for related computed measures in chat.
