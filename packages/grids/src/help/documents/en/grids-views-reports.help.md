---
id: grids-views-reports
title: Views & reports
icon: ti ti-filter
description: Save repeated ways of finding, arranging, and summarizing records.
order: 120
---
A view is a named way to use table data. It keeps a GQL query and display settings without copying the records. Change a record in one view and the same record changes everywhere it appears.

Create a view when people repeatedly need the same subset, order, columns, card board, calendar, or grouped report. Use an unsaved table query while exploring; save it when the result becomes part of regular work.

## Shape the records {icon="table"}

The visual controls and GQL describe the same result:

- **Search** finds a term across searchable displayed values.
- **Filter** keeps records that match exact rules.
- **Sort** defines their order.
- **Computed** adds a calculated result column without adding a field to the table.
- **Group** turns records into one summary row per category.
- **Aggregate** calculates values such as count, unique count, sum, average, median, earliest, latest, minimum, or maximum.

Search is useful for exploration. Use a filter when the rule must be reusable and exact, such as Status is Open, Amount is greater than 1,000, or Due date is before today.

Add a sort whenever order has business meaning. If several records share the same value, Grids adds a stable tie-breaker for pagination; an explicit second sort can still make the order clearer to readers.

## Choose how the result is displayed {icon="layout-list"}

**Table** is the default for dense comparison and editing. Choose visible columns and their order for the task.

**Cards** are useful when each record should read as one item with a short title, selected fields, and an optional image.

**Calendar** places records by one date or date-time field. Use it for bookings, due dates, shifts, and scheduled work.

A grouped or aggregate-only query returns summary rows rather than editable records. It is suitable for reports, charts, Grids Apps, documents, and exports.

## Save a useful view {icon="layout-list"}

:::steps
1. Open the source table and use Query, Filter, Sort, or Computed to describe the result.
2. Check the result with representative and empty data.
3. Choose the display mode and only the columns people need.
4. Save the current setup as a view and give it a task-oriented name, such as **Open invoices**.
5. Share it only with the people who should see its included result.
:::

A shared View is visible to Base readers. A personal View belongs to its owner. To publish a saved result without opening the Base, include it in a Grids App capability snapshot.

## Reports and pagination {icon="point"}

Use grouping and aggregations for reports. A monthly revenue report, for example, groups invoices by month and sums Total. Put pre-group filters before the grouping; use `having` in GQL when the rule applies to an aggregate result.

Views without an explicit `limit` can be paged through the complete matching result. A `limit` deliberately caps the logical result across pages. Pages are live reads, so records changed between page requests can move; use a stable sort for predictable navigation.

## Reuse or keep local {icon="route"}

Save a View when Base users revisit it or several Grids Apps reuse it. For a query used by only one Grids App block, store GQL directly in that block instead of filling navigation with one-use Views.

:::note Open the GQL topic for advanced shapes
Use GQL for joins, precise grouping, `having`, deleted records, scoped search, or any query that is clearer in text than in several controls.
:::
