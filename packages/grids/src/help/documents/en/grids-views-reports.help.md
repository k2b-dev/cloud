---
id: grids-views-reports
title: Views & reports
icon: ti ti-filter
description: Save repeated ways to find, arrange, and summarize records.
order: 120
---
A view is a named way to use table data. It keeps a GQL query and display settings and does not copy the records. When you change a record in one view, the same record changes everywhere it appears.

Create a view when people often need the same subset, order, columns, card board, calendar, or grouped report. While you explore, use an unsaved table query. Save it when the result becomes part of regular work.

## Shape the records {icon="table"}

The visual controls and GQL describe the same result:

:::reference
- **Search:** Finds a term in all searchable displayed values.
- **Filter:** Keeps the records that match exact rules.
- **Sort:** Sets their order.
- **Computed:** Adds a calculated result column. It does not add a field to the table.
- **Group:** Turns records into one summary row for each category.
- **Aggregate:** Calculates values such as count, unique count, sum, average, median, earliest, latest, minimum, or maximum.
:::

Use search to explore. Use a filter when the rule must be exact and reusable. Examples: Status is Open, Amount is greater than 1,000, or Due date is before today.

Add a sort when the order has business meaning. If several records share the same value, Grids adds a stable tie-breaker for pagination. An explicit second sort can still make the order clearer to readers.

## Choose how the result appears {icon="layout-list"}

**Table** is the default for dense comparison and editing. Choose the visible columns and their order for the task.

A new field appears as the last table column, unless it is set to **Hide in table**. This also applies to a field that is created through the CLI or API. A field that you restore from the trash appears in the table again, too. If someone changed the table's columns in the meantime, for example in another tab, Grids reloads them and does not overwrite that change. Then repeat your change on the current columns.

To show a hidden field in the table again, open the table in **Edit mode** and choose **Add column**. If you show a field that is set to **Hide in table**, Grids also clears that setting. If a hidden field already uses the name of a new field, Grids offers to show that column instead.

**Cards** show each record as one item with a short title, selected fields, and an optional image.

**Calendar** places records by one date or date-time field. Use it for bookings, due dates, shifts, and scheduled work.

A grouped query or an aggregate-only query returns summary rows, not editable records. Use it for reports, charts, Grids Apps, documents, and exports.

## Save a useful view {icon="layout-list"}

:::steps
1. Open the source table.
2. Describe the result with **Query**, **Filter**, **Sort**, or **Computed**.
3. Check the result with representative data and with empty data.
4. Choose the display mode and only the columns that people need.
5. Choose **Save as view** and give the view a task name, such as **Open invoices**.
6. Share it only with the people who can see its result.
:::

People with **View** access to the Base can see a shared view. A personal view belongs to its owner. To publish a saved result without opening the Base, add it to the capability snapshot of a Grids App.

## Build reports and page through results {icon="point"}

Use grouping and aggregations for reports. For example, a monthly revenue report groups invoices by month and sums Total. Put filters that apply before the grouping first. Use `having` in GQL when the rule applies to an aggregate result.

In the visual controls, set the group order on the grouping itself, or sort groups by an aggregate value. The record sort stays separate and does not set the group order. Stored and federated tables follow the same rule.

You can page through the complete matching result of a view without an explicit `limit`. A `limit` deliberately caps the logical result across all pages. Each page is a live read, so a record that changes between page requests can move. Use a stable sort for predictable navigation.

## Decide whether to save a view {icon="route"}

Save a view when people with access to the Base return to it, or when several Grids Apps reuse it. If only one Grids App block uses a query, store the GQL directly in that block. This keeps one-use views out of the navigation.

:::note Use GQL for advanced queries
Use GQL for joins, precise grouping, `having`, deleted records, scoped search, or any query that is clearer as text than in several controls.
:::
