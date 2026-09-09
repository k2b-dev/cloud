---
id: grids-overview
title: Overview
icon: ti ti-layout-grid
description: Understand what Grids does and where to begin.
order: 100
---
Grids helps a team keep structured information and the work around it in one place. You can track inventory, invoices, projects, requests, customers, contracts, or another process where every item follows a consistent shape.

You do not need database experience to start. Think of a **base** as the workspace for one subject. Inside it, a **table** lists one kind of item, a **record** is one item in that list, and a **field** stores one fact about the item.

For example, an inventory base might contain separate tables for Items, Locations, Loans, and People. One Items record could contain a name, asset number, status, location, and relation to the current loan.

## What you can build {icon="square-plus"}

Once the records are useful, the same saved data can support different jobs:

- **Views** show the records people need for a task, such as available items or overdue loans.
- **Forms** give people a focused way to add records without opening the full table.
- **Grids Apps** combine numbers, charts, record lists, forms, instructions, links, and workflow actions.
- **Grids Apps** publish focused, server-enforced pages for authenticated or public audiences without opening the raw Base workspace.
- **Documents** turn records into PDFs such as invoices, labels, agreements, and reports.
- **Workflows** carry out repeatable steps manually, from a scanner or selection, on a schedule, or after a record changes.
- **Combined tables** publish one governed, read-only dataset from tables in several bases.

These features do not create separate copies of the business data. Tables remain the source of truth.

## Start with one useful process {icon="square-plus"}

Choose a small process that already has clear items, such as equipment loans or incoming requests. Then:

:::steps
1. Create one table for the main kind of item.
2. Add only the fields needed to recognize and work with each record.
3. Enter a few real records and correct unclear names or field types.
4. Create a view for one repeated task.
5. Add a form, Grids App, document, or workflow only when it removes a real manual step.
:::

This order keeps mistakes inexpensive. A clear table and a few representative records make every later choice easier.

## Find your work in a base {icon="layout-dashboard"}

Use **New** in Edit mode to create a table, view, form, document template, workflow, or App. The menu only offers actions you may use. For table-based resources, select a table; the current table is preselected when eligible. **View** opens the query editor, where you configure and save the view.

**Documents** is always expandable: open **All documents** or select a template to see its generated documents. Base admins manage workflow email templates under **Settings → Email templates**.

Open **Overview** to see shared shortcut groups and search all resources by name or type. Tables, views, forms, document templates, workflows, and Apps keep their existing behavior; opening a form still opens its form dialog.

Base admins can open **Settings → Navigation** to create named groups. Add resources with the searchable picker, change their order with the arrow buttons, then save your changes. Removing a shortcut or group does not delete any resource. A resource can appear in several groups.

Groups are shared, but readers only see resources they can access. Empty groups are hidden. Without visible groups the sidebar keeps its other resource lists open; with groups those lists become expandable. They still contain all accessible resources, including grouped ones. This browser remembers which branches you expand; opening a direct link reveals the active resource.

If another admin saved first, your save is rejected rather than overwriting their changes. **Reload navigation** loads the current configuration after asking before discarding your edits.

## Where to continue {icon="arrow-right"}

- Read **Core model** if bases, tables, records, and relations are new to you.
- Follow **Build a base** for a practical first build.
- Use **Tables & fields** when choosing how a value should be stored.
- Open the topic for a feature when you are ready to add it.

:::note Edit mode
Normal mode is for using a base. Turn on **Edit mode** when you need to change its structure, resources, or settings. What you can see and change still depends on your access.
:::
