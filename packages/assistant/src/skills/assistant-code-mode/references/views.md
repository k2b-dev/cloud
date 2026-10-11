# Views in the chat

Numbers computed in `code_run` stay in the run. Call `await cloud.view.chart(spec)`,
`await cloud.view.group(spec)` or `await cloud.view.table(spec)` there, then call
the **tool** `present({path})` for each returned view the person should see. Never retype run values into
`chart` arguments, `data.js` or Markdown; a chat app's `data.js` is the module
the run wrote, copied unchanged ([Chat apps](chat.md)). Return only the key figures mentioned
in the answer. If a view is missing, rerun the script with `cloud.view.*`.
A few values that did not come from a run use the `chart` tool.

## Chart forms

Every chart needs `kind`, `title` and optionally `subtitle` (unit, period or
source). Without `rows`, use these payloads:

| Kind | Payload |
| --- | --- |
| `bar`, `pie`, `donut` | `data: [{label, value}]` |
| `line`, `scatter` | `series: [{label?, data: [{x, y}], role?}]` |
| `histogram`, `sparkline` | `data: number[]` |
| `boxplot` | `data: [{label, values: number[]}]` |
| `heatmap` | `data: [{x, y, value}]`, text categories, each pair once; at most 17 rows (y), column labels that fit a phone |
| `barGauge` | 1..8 `data` items `{label, value, min?, max?}`; labels at most 10 characters |
| `gauge`, `stat` | `value` |

Canonical x values are finite numbers or `YYYY-MM-DD[THH:mm[:ss]]`, wall-clock
time without an offset. All series use the same x type. No markup, functions,
`width` or `height` belong in a view.

With `rows` (objects keyed by column name):

- `bar`, `pie`, `donut`, `barGauge`: `x: "labelColumn", y: "valueColumn"`. A label is
  text, a finite number or a `Date`; a `Date` becomes its wall-clock date in
  the run's time zone (`YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm:ss` when it has a
  time). A missing label is an error.
- `line`, `scatter`: `x: "xColumn", y: "valueColumn"` or `y: ["a", "b"]`.
  Each y column becomes a named series. For long format use one y column and
  `series: "groupColumn"`; groups keep first-seen order, and every group cell
  needs a label like a bar's. x may be a number,
  an ISO wall-clock date string, or a `Date`, converted to the run's time zone.
  Converted Date x values that are all at midnight become `YYYY-MM-DD`.
- `boxplot`: `x: "categoryColumn", y: "valueColumn"`; groups observations by
  label in first-seen order.
- `heatmap`: `x: "columnCategory", y: "rowCategory", value: "valueColumn"`;
  aggregate repeated category pairs first.
- `sparkline`: `y: "valueColumn"`.
- `histogram`: `value: "valueColumn"`, optionally `bins` (1..480 or ascending
  edges covering every observation). The default is Sturges' count, capped at
  480, with nice equal-width edges. All observations enter the bins; only their
  counts are stored as a bar of ranges. Bins are half-open; the last includes
  its upper edge. Equal values produce one bin. Use this form for a distribution
  over all rows, rather than sampling 480 observations.

Null or missing y/value cells are skipped; missing labels for retained cells
are errors. Other options keep their normal meaning. The barGauge rows form
creates label/value items; use canonical data for per-item min/max. Gauge and
stat take no rows; give the computed value directly. The histogram rows form
stores a bar of bin counts, so its references are y references to counts.

## Chart options

Axes (`xAxis` on line/scatter, `yAxis` on bar/line/scatter/boxplot) take `label`,
`domain: [min, max]`, `ticks` (2..12), `scale: "linear" | "log"` and `format`.
A log axis needs positive values; an explicit domain must contain the data.
`xAxis.format` and `yAxis.format` take a number format as described under Tables;
a date x axis takes `{date: "day" | "minute" | "second"}` instead.
Pie, donut, gauge, barGauge, stat and heatmap take a root number `format`.
With `showValues` on bars, y ticks use the value format. Pie and donut slices
show shares; their `format` applies to the values in tooltips and the table.

Bar takes `colorByBar`, `showValues`, `legend`; line/scatter take `legend`;
line also takes `area`, `smooth` and series `style: "solid" | "dashed" | "dotted"`.
Line/scatter series may have `role: "reference"` for a comparison period:
line defaults to dashed unless style is set, scatter uses hollow points in chat.
Pie/donut take `legend`, `showLabels`; sparkline takes `area`.
Heatmap takes `min`, `max`, `showValues`. Gauge/barGauge take `min`, `max`,
`unit`; gauge also takes `label`. Stat takes `unit`, `delta` in the value's
units, `better: "up" | "down"` and optional `sparkline: number[]`. The host
chooses the change color from `better`; no direction or zero change is neutral.

Bar, line, scatter, histogram and boxplot take up to 8
`references: [{value, axis?, label?}]`. Axis defaults to y; x is allowed only
on line/scatter and canonical histogram. Values match the axis type; Date
references become wall-clock date-time strings. Automatic domains extend to
include references; explicit domains must contain them.
Gauge/barGauge take 1..8 `thresholds: [{value, label?}]`, strictly ascending
within every effective min..max range (defaults 0..100). Colors come from the
palette; supply bounds and labels, not colors.

## Groups

`await cloud.view.group({title, subtitle?, charts, linkX?, layout?})` saves 2..6
complete chart specs as one `{view: "group", ...}` file. Each chart can use
canonical data or the rows form. Chart errors identify `charts[i]`; row and
field errors add their paths. Six charts bound the measured phone rendering cost as well as the shared
mark budget below.

Layout defaults to `"stack"`; `"grid"` shows two columns once the chat column
is at least 42rem wide, one on phones. `linkX: true` needs line charts with the
same kind of x (all numbers or all dates); hover, arrow keys and tap move one
cursor across them. A phone tap pins it; a drag scrolls the page. Use a group
for related measures, especially different units; there is no second y axis.
Grouped and stacked bars are unsupported
([upstream issue](https://github.com/k2b-dev/stdlib/issues/5)).

## Tables

`table({title, subtitle?, rows, columns?, footer?, sort?})` keeps the listed
columns. A column is a name or `{id, label?, type?, format?}`. Without columns,
keys appear in first-seen order. An omitted type becomes `number` when all
non-null cells, footer included, are numbers, `datetime` when all are Dates,
otherwise `text`; a column without any value is `text`.
Explicit types are `text`, `number`, `date` and `datetime`. Dates are
`YYYY-MM-DD`; datetimes are `YYYY-MM-DDTHH:mm` or `YYYY-MM-DDTHH:mm:ss`, without
an offset. Dates supplied as `Date` become wall-clock strings in `cloud.timeZone`.
Missing and undefined cells become null; objects, booleans and non-finite
numbers must be converted to text or numbers. The optional footer uses the
same columns. `sort: {column: "id", direction: "asc" | "desc"}` sets the initial
order; the reader can sort again.

Only number columns have `format`: `{style?: "number" | "percent" | "currency",
currency?, unit?, decimals?, compact?}`. Currency requires an uppercase
three-letter code exactly when style is currency. Percent takes a fraction
(0.31 → 31 %). Decimals (0..10) fixes fraction digits, compact shortens large
numbers, and unit is a plain suffix of at most 12 characters. Otherwise numbers
retain up to 15 significant digits. Labels and text render as text nodes.

## Choose and label

Sort bars of counts or totals by value unless the categories have their own
order; a pie or donut fits only two to four shares of one whole. Use a histogram
for continuous values, and give color a meaning (series, threshold, a category
the legend names): do not use `colorByBar` to decorate bars the axis already names. Name the measure as computed in the title or subtitle,
such as "Sum of price × stock" or "Number of orders". The answer text gives findings and
caveats, not the values the view shows.

## CSV result

Select the CSV path with `code_run.inputPaths` and read it in the script;
`read_file` shows at most its first block to learn the columns. This script
groups status counts with a histogram over every price, compares prices by
category with a boxplot, and keeps monthly sums in a table with a footer:

```js
export default async (_input, { files }) => {
  const [input] = files;
  if (!input) throw new Error("Select a CSV with status, price, category and date columns.");
  const rows = await cloud.sheet.parseCsv(await input.file());
  const statuses = new Map();
  const months = new Map();
  let total = 0;
  for (const row of rows) {
    if (typeof row.price !== "number" || !Number.isFinite(row.price))
      throw new Error("Every price must be a finite number.");
    if (typeof row.status !== "string" || typeof row.category !== "string" ||
        typeof row.date !== "string") throw new Error("Check status, category and date columns.");
    const status = row.status;
    const month = String(row.date).slice(0, 7);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    months.set(month, (months.get(month) ?? 0) + row.price);
    total += row.price;
  }
  await cloud.view.group({
    title: "Orders and prices", subtitle: "Selected CSV", layout: "grid",
    charts: [
      { kind: "bar", title: "Orders by status", subtitle: "Number of orders",
        rows: [...statuses].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
        x: "status", y: "count" },
      { kind: "histogram", title: "Price distribution", subtitle: "EUR · all rows",
        rows, value: "price" },
    ],
  });
  await cloud.view.chart({
    kind: "boxplot", title: "Price by category", subtitle: "EUR · all rows",
    rows, x: "category", y: "price", yAxis: { format: { style: "currency", currency: "EUR" } },
  });
  await cloud.view.table({
    title: "Monthly totals", subtitle: "Sum of price · selected CSV · EUR",
    columns: ["month", { id: "amount", label: "Sum of prices", type: "number",
      format: { style: "currency", currency: "EUR", decimals: 2 } }],
    rows: [...months].map(([month, amount]) => ({ month, amount })),
    footer: { month: "Total", amount: total }, sort: { column: "month", direction: "asc" },
  });
  return { orders: rows.length, total };
};
```

## References, limits and errors

Each call returns a `ViewRef`:

- chart: `{path, view: "chart", kind, title, subtitle?}`;
- group: `{path, view: "group", title, subtitle?, linkX, layout, charts}`,
  where `charts` lists `{kind, title, subtitle?}`, without data;
- table: `{path, view: "table", title, subtitle?, rows, columns, footer}`,
  where rows/columns are counts and footer is a boolean.

The run snapshot's `views` contains these references, **no values**. Present each
path directly; there is no export step. Summaries reserve every chart's frame
while loading: ordinary charts 18rem, sparkline 8rem, stat 10rem, barGauge 12rem.
Series legends wrap below the chart inside that height. One undrawable chart
shows unavailable in its own group frame. The CLI prints one table per chart.

Limits: 8 series, 480 points per series or ordinary data list, 480 boxplot
groups, 3,840 heatmap cells, and 2..6 charts per group. Every chart and group
shares a 3,840-mark budget: input observations count for boxplots and canonical
histograms, and a stat counts its value plus sparkline points. The histogram
rows form bins all observations before storage. Tables allow 3,840 rows and
100 columns; each view is at most 1 MiB. Views and captured downloads share
64 outputs per run. Aggregate first when a bound is exceeded. Server rejection
uses `error.code === "invalid"`; field errors name their path, chart-wide
checks explain the issue, and group chart errors identify `charts[i]`.
Fix the script using that message.

Files live under `/views/<title-slug>-<hash8>.view.json`, appear in the chat's
file list and can be downloaded. Model write tools cannot write below `/views`.
Every reader validates again; a missing or invalid file shows unavailable.
HTML apps cannot call `cloud.view.*`; draw with `cloud.chart()` inside an app.
