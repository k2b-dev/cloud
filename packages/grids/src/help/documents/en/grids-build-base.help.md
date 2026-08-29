---
id: grids-build-base
title: Build a base
icon: ti ti-route
description: Turn a real process into a small, useful Grids base.
order: 106
---
Start from the work people need to complete, not from a list of every feature Grids offers. A good first base makes one process easier with a small number of clear tables and views.

## Describe the work first {icon="square-plus"}

Write down the main items people handle and the questions they ask about them. For equipment loans, the items might be equipment, people, and loans. The questions might be “What is available?”, “Who has this item?”, and “Which loans are overdue?”

Each kind of item usually becomes a table. Each fact needed to answer those questions becomes a field. Repeated connections between kinds of items become relations.

## Build the first useful version {icon="square-plus"}

:::steps
1. **Create the main table.** Give it a concrete plural name such as Items, Invoices, or Requests.
2. **Add identity and working fields.** Start with a readable name, status, owner, and the dates or numbers needed for the process.
3. **Choose a record label.** Pick the short field people should recognize in relations and pickers.
4. **Enter representative records.** Include ordinary, incomplete, and unusual cases. Correct confusing field names now.
5. **Create one operational view.** Filter and sort the records for a repeated task, such as Open requests or Overdue loans.
6. **Set access before inviting users.** Give people only the resources and actions they need.
:::

Do not add a Grids App merely to repeat the table, or a workflow for a process people do not yet understand. Add the next resource when its purpose is concrete:

| Need | Add |
| --- | --- |
| Focused data entry | A form |
| A reusable subset, report, card board, or calendar | A view |
| A role-specific operating page | A Grids App |
| A printable or shareable PDF | A document template |
| A repeatable multi-step action | A workflow |
| One governed read-only table across bases | A Combined table |

## Configure the base around the work {icon="settings"}

Open **Base settings** in Edit mode for settings that apply across the base:

- **General** keeps the base name and description understandable in the Grids overview.
- **Documents** stores the business identity, address, contact, payment, and footer values available to PDF and email templates.
- **Access** controls who can use the complete raw Base workspace. Use a Grids App for a narrower audience.
- **Trash** lists deleted tables, fields, and forms that can still be restored.
- **Danger zone** moves the complete Base out of active use while keeping it restorable by an administrator.

Use a Grids App when readers need a narrower operating surface than direct access to the complete Base.

## Example: equipment loans {icon="point"}

Create **Items**, **People**, and **Loans** tables. A Loans record can relate to one person and several items, and store loaned-at, due-at, returned-at, and status fields.

Then create:

- an **Available items** view for daily lookup;
- an **Open loans** view sorted by due date;
- a **Request loan** form for guided input;
- an **Inventory overview** Grids App for staff;
- a **Loan agreement** document template;
- a **Return item** scanner workflow after the return rules are stable.

The result remains understandable because each feature has one job and all of them use the same records.

## Before expanding {icon="point"}

Use the base with real work. Check whether users can recognize records, understand status values, find the right view, and know what they are allowed to change. If the model is unclear in a small sample, more automation will only hide the problem.

:::note Templates as a starting point
A Grids template can create a complete example base. Treat it as an editable working example: rename its resources, inspect the sample records, and remove what your process does not need.
:::
