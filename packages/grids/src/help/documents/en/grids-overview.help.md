---
id: grids-overview
title: Overview
icon: ti ti-layout-grid
description: Understand what Grids does and where to begin.
order: 100
---
Grids helps a team keep structured information and the work around it in one place. You can track inventory, invoices, projects, requests, customers, contracts, or any process where every item has the same shape.

You do not need database experience to start. A **Base** is the workspace for one subject. Inside it, a **table** lists one kind of item. A **record** is one item in that list. A **field** stores one fact about the item.

For example, an inventory Base can contain separate tables for Items, Locations, Loans, and People. One record in Items can contain a name, an asset number, a status, a location, and a relation to the current loan.

## See what you can build {icon="square-plus"}

When the records are useful, the same saved data supports different jobs:

- **Views** show the records that people need for a task, such as available items or overdue loans.
- **Forms** let people add records without opening the full table.
- **Grids Apps** combine numbers, charts, record lists, forms, instructions, links, and workflow actions on pages that the server protects. They serve signed-in or public audiences and do not open the raw Base workspace.
- **Documents** keep generated PDF, CSV, JSON, XML, SEPA, and DATEV files together with their captured source data.
- **Workflows** run repeatable steps: manually, from a scanner or a selection, on a schedule, or after a record changes.
- **Combined tables** publish one governed, read-only dataset from tables in several Bases.

These features do not create separate copies of the business data. The tables stay the source of truth.

## Start with one useful process {icon="square-plus"}

Choose a small process that already has clear items, such as equipment loans or incoming requests. Then:

:::steps
1. Create one table for the main kind of item.
2. Add only the fields that people need to recognize and work with each record.
3. Enter a few real records. Correct unclear names or field types.
4. Create a view for one repeated task.
5. Add a form, Grids App, document, or workflow only when it removes a real manual step.
:::

This order keeps mistakes cheap. A clear table and a few representative records make every later choice easier.

## All topics {icon="list"}

- [Bases, tables, records, and relations](/app/grids/help/grids-core-model)
- [Build a Base and configure its settings](/app/grids/help/grids-build-base)
- [Templates and real workflows: Billing, expenses, inventory](/app/grids/help/grids-build-business-app)
- [Table options, indexing, history, finalization, and Four-eyes](/app/grids/help/grids-tables-fields)
- [Every field type, ID strategy, option, and default](/app/grids/help/grids-field-configuration)
- [Imports, external identities, and CSV/JSON exports](/app/grids/help/grids-data-exchange)
- [Views, charts, cards, calendars, and reports](/app/grids/help/grids-views-reports)
- [Read-only datasets shared across Bases](/app/grids/help/grids-combined-tables)
- [GQL syntax, joins, summary joins, and document metadata](/app/grids/help/grids-gql)
- [Formula functions, types, exact decimals, and diagnostics](/app/grids/help/grids-formulas)
- [Forms, compact layout, defaults, inline creation, and summaries](/app/grids/help/grids-forms)
- [What a Grids App is](/app/grids/help/grids-custom-apps)
- [Build a focused app](/app/grids/help/grids-build-custom-app)
- [Pages, parameters, blocks, queries, and navigation](/app/grids/help/grids-custom-app-pages-blocks)
- [Complete app API and configuration contract](/app/grids/help/grids-custom-app-api)
- [YAML validation, planning, apply, and restore](/app/grids/help/grids-custom-app-yaml-cli)
- [Publish safely and test each audience](/app/grids/help/grids-publish-custom-app)
- [Templates, PDFs and E-Invoices, generated files, and source records](/app/grids/help/grids-documents-pdfs)
- [Actions, triggers, launchers, file outputs, approvals, and retries](/app/grids/help/grids-workflows)
- [Financial format inputs, limits, and validation](/app/grids/help/grids-financial-formats)
- [Base access, app audiences, and anonymous forms](/app/grids/help/grids-permissions)
- [Retention, holds, trash, and destruction](/app/grids/help/grids-retention-preservation)
- [Evidence exports and integrity verification](/app/grids/help/grids-evidence-exports)
- [Recover from errors, conflicts, and interrupted runs](/app/grids/help/grids-operations-troubleshooting)

## Find your work in a Base {icon="layout-dashboard"}

When you open Grids from the navigation, Grids returns to the Base page that you looked at last in this browser, even in another tab. If you can no longer open that Base, the overview opens instead.

Use **New** in **Edit mode** to create a table, view, form, document template, workflow, or app. The menu offers only actions that you can use. For a resource that is based on a table, select a table. Grids preselects the current table when it fits. **View** opens the query editor, where you configure and save the view.

You can always expand **Documents**. Open **All documents**, or select a template to see its generated documents. Workflow email templates are in **Settings → Email templates**. Viewing, creating, editing, and deleting them require **Manage** access to the Base.

In **Overview**, switch between **Groups** for shared shortcuts and **All resources** to search by name or type. The selected tab is part of the URL, so links, reloads, and browser history keep it. By default, a Base with groups opens on **Groups**, and a Base without groups opens on **All resources**. Opening a form still opens its form dialog.

## Organize the navigation into groups {icon="layout-dashboard"}

You need **Manage** access to the Base.

:::steps
1. Open **Settings → Navigation**.
2. Create a named group.
3. Add resources with the searchable picker.
4. Change their order with the arrow buttons.
5. Save your changes.
:::

Removing a shortcut or a group does not delete any resource. A resource can appear in several groups.

Groups are shared, but each person sees only the resources that they can access. Grids hides empty groups. Without visible groups, the sidebar keeps its other resource lists open. With groups, those lists become expandable. They still contain all accessible resources, including grouped ones. This browser remembers which branches you expand. A direct link reveals the active resource.

If another person saved first, Grids rejects your save and does not overwrite their changes. **Reload navigation** loads the current configuration. It asks before it discards your edits.

## Continue with the next topic {icon="arrow-right"}

- Read [Understand the core model](/app/grids/help/grids-core-model) if Bases, tables, records, and relations are new to you.
- Follow [Build a Base](/app/grids/help/grids-build-base) for a practical first build.
- Use [Tables & fields](/app/grids/help/grids-tables-fields) when you choose how to store a value.
- Open the topic for a feature when you are ready to add it.

:::note Use Edit mode to change structure
Normal mode is for using a Base. Turn on **Edit mode** when you need to change its structure, resources, or settings. What you can see and change still depends on your access.
:::
