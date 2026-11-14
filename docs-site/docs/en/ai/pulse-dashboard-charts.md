---
title: Pulse dashboard chart columns
navTitle: Pulse chart columns
section: AI
order: 1080
tags: [pulse, dashboards, charts, sql]
updated: 2026-11-09
description: Choose SQL output columns for Pulse dashboard charts.
---

# Pulse dashboard chart columns

Save a Pulse dashboard with SQL and an explicit list of output `columns`.
Choose a panel `kind` and the columns below. Add `ORDER BY` when observation
order matters; ranked lists and Pareto sort by value. Columns outside the saved
projection never reach the dashboard or its published link.

| Panel kind | SQL column mapping |
| --- | --- |
| `number` | One numeric value. Optional DateTime `x` adds a trend; String `unit`, `detail`, `detailTone` add presentation. |
| `line` | Date, DateTime or DateTime64 `x`, optional `series` group, remaining columns numeric values. |
| `bar` | Category `x`, optional `series` group, remaining columns numeric values. Retains flattened source labels and row order, including repeated category/series pairs. |
| `area`, `areaPercent` | Category `x`, optional `series` group, remaining columns nonnegative numeric values. Aligned stacked amounts or 100% shares. |
| `budget` | Category `x`, numeric `used` and `limit`, optional numeric `expected`; `unit` is an uppercase ISO 4217 currency such as `EUR`. |
| `balance` | One row with numeric `start`, `in`, `out`; no `x` or `series`. `unit` is the currency. |
| `funnel` | Ordered category `x` and one nonnegative numeric value. |
| `pie`, `donut` | Category `x` and one nonnegative numeric value. |
| `scatter` | Numeric `x`, optional `series` group, remaining columns numeric y values. |
| `histogram` | One numeric observation column, without `x` or `series`; bins are computed from the observations. |
| `boxplot` | Category `x` and one numeric observation column; repeat the category for each observation. |
| `heatmap` | Category `x`, row category in `series`, one numeric value. Aggregate each x/row pair once. |
| `gauge` | One aggregate numeric value from 0 to 100, without `x` or `series`. |
| `barGauge` | Category `x` and one nonnegative numeric value. |
| `sparkline` | One numeric observation column, without `x` or `series`, in SQL order. |
| `map` | ISO 3166-1 alpha-2 country `x` and one nonnegative numeric value; empty country codes stay off the map. |
| `table` | Any selected columns, in their saved order. |
| `barGrouped`, `barStacked`, `barPercent` | Category `x`, optional `series`, remaining values; grouped amounts, stacked amounts, or 100% shares. Stacks require nonnegative values. |
| `barCompare`, `pareto` | Category `x`, current and previous columns in that order, without `series`. Pareto values must be nonnegative and non-null. |
| `barRows`, `barList`, `funnelStages` | Category `x` and one value, without `series`: signed rows, nonnegative ranked shares, or ordered funnel stages. |
| `hbar` | Category `x`, optional `series`, remaining nonnegative values; aligned horizontal comparisons. |
| `dots` | Category `x`, repeated positive `total`, then nested count columns in descending subset order; optional `series`. Each complete category draws 100 dots including the remainder. |
| `waterfall` | Category `x`, one value: starting balance, signed changes, then a final null value naming the computed total. |
| `calendarHeatmap` | ISO day `x` (`YYYY-MM-DD`) and one value; each date appears once. |
| `sankey` | Exactly `source`, `target`, `value`, without `x` or `series`. Nonempty text endpoints and positive amounts form an acyclic graph. |
| `treemap` | Label `x`, group in `series`, one nonnegative value. |
| `bubble` | Numeric `x`, group in `series`, fixed aliases `label`, `y`, optional nonnegative `size`. |
| `radar` | Axis category `x`, repeated positive `max`, remaining numeric measurements; optional `series`. Every series fills every axis, between zero and max. |
| `lineForecast` | Date/DateTime `x`, `value`, `forecast` (0 history, 1 forecast), optional paired `low`/`high`; no `series`. Forecast flags form a contiguous suffix ordered by time. |

SQL numeric strings are accepted. A SQL `NULL` stays a missing observation;
it never becomes zero. Funnel stages and map values require numbers, and a
gauge requires one value. Line times read in the base timezone, including
local DateTime text. Viewers keep that timezone while formatting labels in
their own locale.

Use `funnelStages` for the catalog funnel; saved `funnel` panels retain their
bar-gauge appearance. Saved `bar` panels keep one bar per row and value
column, with labels such as “Visit · first”. Choose `barGrouped`, `barStacked`
or `barPercent` to align series in the category order first encountered in
SQL, with absent or null observations left as gaps. These aligned kinds
require unique category/series pairs; aggregate duplicates in SQL. `barRows`
accepts negative amounts; `barList` ranks nonnegative shares by value. Comparison and Pareto
measure names come from the two selected
value-column names. Pareto ranks categories by the current amount, and its
accessible chart name is the panel title.

Calendar nulls leave empty days. Treemap and bubble rows with missing values
produce no point, while still consuming their input position. Radar, Pareto,
Sankey and waterfall reject missing values where their semantics require a
number. A missing nested count leaves that category's dot matrix empty.
Forecast values may be null gaps; when bounds are selected, each
forecast row needs finite `low`/`high` values containing its value. Historical
bound cells may be null. SQL times still read in the base's timezone.

For example, a flow query can select `shipping_method AS target`, the literal
`'Orders' AS source`, and `count() AS value`, grouped by shipping method.
Choose `kind: "sankey"`, `columns: ["source", "target", "value"]` and omit
`x` and `series`. For grouped bars use category `x` with two value columns;
`barCompare` interprets those columns as current and previous instead.

Panel widths are `third`, `half`, `twoThirds`, or `full` (2, 3, 4, or 6 desktop
columns). Phone panels stack at full width. Number panels keep their existing
section placement.

**Rolling back:** A dashboard saved with a new kind cannot be read by an
older Pulse version that does not recognize it. Strict stored-definition
validation then prevents that base's dashboard list from loading. Replace
or remove unsupported panels before rolling back. Existing dashboards need
no migration.

Area charts align each series to the category order first encountered in SQL.
A missing category/series pair stays a gap; duplicate pairs produce a panel
error. A missing observation interrupts the whole stack. `areaPercent` also
leaves zero-total categories empty. Use `ORDER BY` for chronological categories.

Budget columns are fixed SQL aliases: `used` is booked spending, `expected`
is additional planned spending, and `limit` is the budget. All three must be
nonnegative; zero limits show any spending as an overrun. Omit `expected` when
it is unavailable rather than returning `NULL`. For example:

```sql
SELECT category AS name, sum(booked) AS used, sum(planned) AS expected,
       sum(budget) AS limit
FROM costs
GROUP BY category
ORDER BY category
```

Choose `kind: "budget"`, `columns: ["name", "used", "expected", "limit"]`,
`x: "name"`, and `unit: "EUR"`. Balance panels use fixed aliases `start`, `in`,
and `out`. The starting balance may be signed; incoming and outgoing amounts
are nonnegative magnitudes. The displayed end is `start + in - out`. Each money
cell must contain a finite number; `NULL` produces an error.

For a heatmap, return one row per cell:

```sql
SELECT JSONExtractString(dimensions, 'path') AS page,
       JSONExtractString(dimensions, 'host') AS server, count() AS requests
FROM events
WHERE ts >= :from AND ts < :to
GROUP BY page, server
ORDER BY page, server
```

Select `columns: ["page", "server", "requests"]`, `x: "page"`,
`series: "server"`, and `kind: "heatmap"`. A missing cell is a gap. Duplicate
cells produce a panel error; aggregate them in SQL.

Each panel allows eight series, 480 points per series, and 3,840 produced
marks. A heatmap allows eight row categories and 480 column categories; a box
plot allows eight groups with 480 observations each. Marks are counted after
mapping to the shared chart renderer, so null observations consume point
positions but produce no mark. These are Pulse limits, independent of Chat's
input limits. Excessive, invalid, or truncated results show an error with
**Retry**. Aggregate the query rather than clipping rows.

The saved SQL panel remains the source of truth. Pulse adapts its result to
the same plain JSON chart description used by Chat and Notebooks; rendering
callbacks and interactions stay in the host. Money descriptions use the
`CloudMoneyDescription` type from `@k2b/cloud/ai`: `{block: "budget", currency,
items}` or `{block: "balance", currency, start, in, out}`. Hosts render them
with `BudgetList` and `BalanceSummary` from `@k2b/ui`. Existing dashboards need no
migration. See [Pulse](/en/apps/pulse#build-a-dashboard) for saving, ranges,
refresh and publication.
