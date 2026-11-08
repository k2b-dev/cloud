# Charts

`cloud.chart(options)` returns chart markup in Cloud colors. Use it as
`innerHTML`, inside `cloud.html`, or in the HTML of `cloud.pdf.render`. It needs
no DOM in scripts and PDFs. In an app, cartesian
charts redraw at their real width, so axes and labels fit phones. App charts show
tooltips by default on hover, keyboard focus and tap. Tab to a chart, use arrow
keys or Home/End to inspect values, and press Escape to close the tooltip;
tapping outside the chart also closes it. Printed pages and PDFs show every
`cloud.chart()` with a table of its values below it, hidden on screen, in the
same text as the tooltips. The markup carries every value for the tooltips
and for that table, so a dense chart is large: 8 series × 480 points is about
3.1 MB. Aggregate dense data before charting it.
Draw dense charts in the app that shows them instead of returning their markup
from an action or storing it in KV.

`cloud.chart()` remains synchronous. In HTML apps, ordinary line, bar, pie, donut,
stat and sparkline draw immediately. Other kinds initially return a loading
placeholder; insert the markup into the document and the frame fills it at the
same size. Their renderer ships with the frame and loads without any network
request, including offline first use. A load failure shows **Try again**.
A line with forecast annotations uses the same loading path. A rendering error (including a throwing format callback) shows its message
without retry and is reported to the host.
Formats, tooltips and print value tables work after loading. Frame readiness,
snapshots and `cloud.pdf.render({html})` wait for pending chart rendering; do
not extract SVG from the initial placeholder yourself. Scripts and PDF markup
created in script runs still draw every kind synchronously.

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
same way. [Chart kinds](chart-kinds.md) lists every kind with when to use it,
its options and one small valid description.

### Nested dot matrices

Use a nested dot matrix for counts inside one capacity, such as clicks inside
opens. Each category is two dots wide; later series must be subsets of earlier
ones, and unused capacity stays grey. Counts must be nonnegative and at most
`total` (default: the largest observed count, at least one). A missing count
leaves that category as a gap. Exact values remain in the tooltip and table;
dots round visually. Each dot counts toward the chart's mark limit. Aggregate
categories or use fewer dots if they would be too small on a phone.

```js
const engagement = cloud.chart({
  kind: "bar", title: "Campaign engagement", marks: "dots", layout: "nested",
  total: 100, dots: 20, x: ["May", "Jun"],
  series: [{ label: "Opened", data: [80, 90] }, { label: "Clicked", data: [30, 40] }],
});
```

Dot matrices load their drawing when inserted into an HTML app, including
offline first use. Scripts draw them synchronously. For percentage data, use
fractions with `format: {style: "percent"}` and `total: 1`; the legend shows
the latest category or the category at the cursor, never a sum of percentages.
Comparison, normalization and logarithmic scales do not apply to nested dots.

### Forecast lines

Use `forecast: {from, band?}` to show an outlook after observed values. `from`
matches an x in the first series. Its line is dashed from that point. Optional
`band` is one `[lower, upper]` pair per first-series point from `from`, sorted
by x; bounds are finite and lower cannot exceed upper. The band follows the
line's smooth, straight or `step: "before" | "after" | "middle"` interpolation.

`marker: {at, label}` identifies Today; `threshold: {value, label}` adds a warning
line. `zero: true` includes zero and tints the negative region. These options
enable legend values at the cursor; `legendValues: true` enables those alone.
The resting legend uses the marker's x when present, otherwise the latest x.
For these opted-in lines, `y: null` is a gap. Ordinary lines and scatter keep
numeric y. Use a table when the reader needs every exact value.

```js
const outlook = {
  "kind": "line", "title": "Cash outlook", "legend": true,
  "series": [{"label": "Cash", "data": [{"x": 1, "y": 100}, {"x": 2, "y": 120}, {"x": 3, "y": 110}]}],
  "forecast": {"from": 2, "band": [[100, 140], [90, 130]]},
  "marker": {"at": 2, "label": "Today"}, "threshold": {"value": 95, "label": "Reserve"}, "zero": true,
  "yAxis": {"format": {"style": "currency", "currency": "EUR"}}
};
document.querySelector("#chart").innerHTML = cloud.chart(outlook);
// For computed chat output in a run: await cloud.view.chart(outlook), then present its path.
```

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
`<details>` below the chart when readers need exact values on screen.

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
There is no second y axis or group renderer; use `cloud.view.group` for
related computed measures in chat. Bars take several series side by side
(`layout: "grouped"`) or stacked (`layout: "stacked"`); see
[Chart kinds](chart-kinds.md).
