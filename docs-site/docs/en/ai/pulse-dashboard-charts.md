---
title: Pulse dashboard chart columns
navTitle: Pulse chart columns
section: AI
order: 1080
tags: [pulse, dashboards, charts, sql]
updated: 2026-11-07
description: Choose SQL output columns for Pulse dashboard charts.
---

# Pulse dashboard chart columns

Save a Pulse dashboard with SQL and an explicit list of output `columns`.
Choose a panel `kind` and the columns below. The order returned by SQL is the
order shown; add `ORDER BY` when order matters. Columns outside the saved
projection never reach the dashboard or its published link.

| Panel kind | SQL column mapping |
| --- | --- |
| `number` | One numeric value. Optional DateTime `x` adds a trend; String `unit`, `detail`, `detailTone` add presentation. |
| `line` | Date, DateTime or DateTime64 `x`, optional `series` group, remaining columns numeric values. |
| `bar` | Category `x`, optional `series` group, remaining columns numeric values. Existing labels combine category, group and value-column name. |
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

SQL numeric strings are accepted. A SQL `NULL` stays a missing observation;
it never becomes zero. Funnel stages and map values require numbers, and a
gauge requires one value. Line times read in the base timezone, including
local DateTime text. Viewers keep that timezone while formatting labels in
their own locale.

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
callbacks and interactions stay in the host. Existing dashboards need no
migration. See [Pulse](/en/apps/pulse#build-a-dashboard) for saving, ranges,
refresh and publication.
