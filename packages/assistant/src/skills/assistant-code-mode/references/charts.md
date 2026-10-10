# Charts

`cloud.chart(options)` returns chart markup in Cloud colors. Use it as
`innerHTML`, inside `cloud.html`, or in the HTML of `cloud.pdf.render`. It needs
no DOM, so it works the same in apps, scripts and PDFs. In an app, cartesian
charts redraw at their real width, so axes and labels fit phones.

To only show a chart in the chat, pass the same options as plain data to the
`chart` tool instead of writing an app: no `width`, `height` or `format`
functions, at most 8 series and 480 values per list.

```js
const chart = document.querySelector("#chart");
const draw = (data) => {
  chart.innerHTML = cloud.chart({ kind: "bar", title: "Orders by region", data });
};
draw([{ label: "North", value: 12 }, { label: "South", value: 8 }]);
document.querySelector("#refresh").addEventListener("click", () => draw([{ label: "North", value: 16 }, { label: "South", value: 10 }]));
```

| Kind | Required options |
| --- | --- |
| `bar`, `pie`, `donut` | `data: [{ label, value }]` |
| `line`, `scatter` | `series: [{ label?, data: [{ x, y }] }]`; `x` may be a number, `Date` or ISO date |
| `histogram` | `data: number[]`; optional `bins` |
| `gauge` | `value`; optional `min`, `max`, `label`, `unit` |
| `sparkline` | `data: number[]`; optional `area` |

All kinds accept `title` and `subtitle`; together they name the chart for
screen readers (`role="img"`). Bar charts accept `yAxis`, `colorByBar`,
`showValues` and `legend`; line and scatter accept `xAxis`, `yAxis` and
`legend`, line also `area` and `smooth`; pie and donut accept `legend` and
`showLabels`. An axis takes `label`, `format(value)`, `domain: [min, max]`,
`ticks` and `scale: "linear" | "log"`. Numbers and dates on the axes use the
viewer's format unless you pass `format`.

`width` and `height` set the logical drawing size. Cartesian charts stretch to
the width of their container while text keeps its pixel size; pie, donut and
gauge keep their aspect ratio. Values must be finite numbers. Aggregate large
data before charting; a chart is no place for thousands of points.

When long category names do not fit, the chart shows every n-th label in full
instead of cutting all of them. If readers need exact values, add a table in a
`<details>` element below the chart.
