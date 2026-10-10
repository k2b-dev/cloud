---
id: grids-core-model
title: Understand the core model
icon: ti ti-stack-2
description: Learn how Bases, tables, records, fields, and resources fit together.
order: 105
---
Grids separates saved facts from the ways people enter, inspect, present, and act on them. This separation prevents duplicate data and makes access easier to follow.

## Follow the model from a Base to a value {icon="point"}

A **Base** is the boundary around one area of work. It contains tables and the resources built on them. Use separate Bases when subjects have different owners, different access, or different operating rules.

A **table** stores one kind of thing. Customers and invoices belong in different tables because they have different fields and lifecycles. A table is not a page layout: several views and Grids Apps can show the same table.

A **record** is one saved thing in a table. In a Customers table, each customer is a record. You can change a record, move it to the trash, restore it, and inspect its history.

A **field** stores one fact on every record in its table. Name, status, amount, due date, attachment, and owner are fields. The field type controls how people enter, validate, search, filter, display, and export a value.

## Connect records instead of copying text {icon="table"}

A **relation** links a record to records in another table. An invoice can link to one customer. A loan can link to several items. The linked table chooses a short **record label**, so people see “Studio camera” instead of an internal ID.

Use a relation when the linked thing has its own details or lifecycle. Use a normal field when the value belongs only to the current record. A lookup shows a value from a related record without copying it. A rollup summarizes related values.

## Choose the resource for each job {icon="point"}

The navigation around tables contains resources that use the saved data:

- A **view** keeps a query and a display mode for repeated work.
- A **form** creates records through a guided set of inputs.
- A **Grids App** arranges data and actions for a role or a process.
- A **document template** defines a family of generated PDFs for the records of one table.
- A **workflow** defines repeatable actions and how inputs move through them.

Access to a Base opens the complete raw workspace. A published Grids App is a separate, finer boundary. It shows only its compiled data and actions and gives no access to the raw Base.

## Decide where something belongs {icon="route"}

Ask these questions:

- Is it a fact about one record? Add a field.
- Is it another thing with its own fields? Add a table and a relation.
- Is it the same records, shown for one task? Add a view.
- Is it a focused way to create records? Add a form.
- Is it a working page for a role? Add a Grids App.
- Is it printed output? Add a document template.
- Is it a repeatable operation? Add a workflow.

:::note Keep one source of truth
Store business facts in tables. Views, forms, Grids Apps, documents, and workflows use those facts and must not keep competing copies.
:::
