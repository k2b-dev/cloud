# Views in the chat

Numbers computed in `code_run` stay in the run. Call `await cloud.view.chart(spec)`
or `await cloud.view.table(spec)` there, then call the **tool** `present({path})`
for each returned view the person should see. Never retype run values into
`chart` arguments, `data.js` or Markdown. Return only the key figures mentioned
in the answer. If a view is missing, rerun the script with `cloud.view.*`.
A few values that did not come from a run use the `chart` tool.

## Chart forms

Every chart needs `kind`, `title` and optionally `subtitle` (unit, period or
source). With no `rows`, pass the canonical chart options: `data` for bar, pie,
donut, histogram or sparkline; `series: [{label?, data: [{x, y}]}]` for line or
scatter; `value` and optional `min`, `max`, `label`, `unit` for gauge. Canonical
x values are finite numbers or ISO wall-clock dates without an offset.
No markup, functions, `width` or `height` belong in a view.

With `rows` (objects keyed by column name):

- `bar`, `pie`, `donut`: `x: "labelColumn", y: "valueColumn"`. A label is
  text, a finite number or a `Date`; a `Date` becomes its wall-clock date in
  the run's time zone (`YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm:ss` when it has a
  time). A missing label is an error.
- `line`, `scatter`: `x: "xColumn", y: "valueColumn"` or `y: ["a", "b"]`.
  Each y column becomes a named series. For long format use one y column and
  `series: "groupColumn"`; groups keep first-seen order, and every group cell
  needs a label like a bar's. x may be a number,
  an ISO date string, or a `Date`, converted to the run's time zone.
- `sparkline`: `y: "valueColumn"`.
- `histogram`: `value: "valueColumn"`, optionally `bins` (1..480 or ascending
  edges covering every observation). The default is Sturges' count, capped at
  480, with nice equal-width edges. All observations enter the bins; only their
  counts are stored as a bar of ranges. Bins are half-open; the last includes
  its upper edge. Equal values produce one bin. Use this form for a distribution
  over all rows, rather than sampling 480 observations.

Null or missing y/value cells are skipped. Other chart options keep their
normal meaning: axes, legend, colorByBar, showValues, area, smooth, showLabels.
A gauge cannot take rows; give it the computed value directly.

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
for continuous values, and give color a meaning: `colorByBar` highlights one
bar. Name the measure as computed in the title or subtitle, such as "Sum of
price × stock" or "Number of orders". The answer text gives findings and
caveats, not the values the view shows.

## CSV result

Select the CSV path with `code_run.inputPaths` and read it in the script;
`read_file` shows at most its first block to learn the columns. This script
creates a status chart, a distribution over every price, and monthly totals
with a footer:

```js
export default async (_input, { files }) => {
  const [input] = files;
  if (!input) throw new Error("Select a CSV with status, price and date columns.");
  const rows = await cloud.sheet.parseCsv(await input.file());
  const statuses = new Map();
  const months = new Map();
  let total = 0;
  for (const row of rows) {
    if (typeof row.price !== "number" || !Number.isFinite(row.price))
      throw new Error("Every price must be a finite number.");
    const status = String(row.status);
    const month = String(row.date).slice(0, 7);
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    months.set(month, (months.get(month) ?? 0) + row.price);
    total += row.price;
  }
  await cloud.view.chart({
    kind: "bar", title: "Orders by status", subtitle: "Number of orders · selected CSV",
    rows: [...statuses].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
    x: "status", y: "count",
  });
  await cloud.view.chart({
    kind: "histogram", title: "Price distribution", subtitle: "Selected CSV · EUR · all rows",
    rows, value: "price",
  });
  await cloud.view.table({
    title: "Monthly totals", subtitle: "Sum of price · selected CSV · EUR",
    columns: ["month", { id: "amount", label: "Revenue", type: "number",
      format: { style: "currency", currency: "EUR", decimals: 2 } }],
    rows: [...months].map(([month, amount]) => ({ month, amount })),
    footer: { month: "Total", amount: total }, sort: { column: "month", direction: "asc" },
  });
  return { orders: rows.length, total };
};
```

## References, limits and errors

Each call returns a `ViewRef`: `{path, view: "chart", kind, title, subtitle?}`
or `{path, view: "table", title, subtitle?, rows, columns, footer}`. The run snapshot's
`views` contains these references, **no values**. Present each path directly;
there is no export step for views.

Limits: 8 series, 480 values per list, 3,840 table rows, 100 columns and 1 MiB
per view. Views and captured downloads share 64 outputs per run. Aggregate
first when a view exceeds a bound. Server validation rejects invalid views with
`error.code === "invalid"` and the exact issue, including its path and limit.
Fix the script using that message.

Files live under `/views/<title-slug>-<hash8>.view.json`, appear in the chat's
file list and can be downloaded. Model write tools cannot write below `/views`.
Every reader validates again; a missing or invalid file shows unavailable.
HTML apps cannot call `cloud.view.*`; draw with `cloud.chart()` inside an app.
