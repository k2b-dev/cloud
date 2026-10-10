---
id: grids-build-base
title: Build a Base
icon: ti ti-route
description: Turn a real process into a small, useful Grids Base.
order: 106
---
Start from the work that people must complete, not from a list of every Grids feature. A good first Base makes one process easier with a few clear tables and views.

## Describe the work first {icon="square-plus"}

Write down the main items that people work with and the questions they ask about them. For equipment loans, the items can be equipment, people, and loans. The questions can be “What is available?”, “Who has this item?”, and “Which loans are overdue?”

Each kind of item usually becomes a table. Each fact that answers those questions becomes a field. Repeated connections between kinds of items become relations.

## Build the first useful version {icon="square-plus"}

:::steps
1. **Create the main table.** Give it a concrete plural name, such as Items, Invoices, or Requests.
2. **Add identity and working fields.** Start with a readable name, a status, and an owner. Add the dates or numbers that the process needs.
3. **Choose a record label.** Pick the short field that people must recognize in relations and pickers.
4. **Enter representative records.** Include ordinary, incomplete, and unusual cases. Correct confusing field names now.
5. **Create one operational view.** Filter and sort the records for a repeated task, such as Open requests or Overdue loans.
6. **Set access before you invite people.** Give people only the resources and actions that they need.
:::

Do not add a Grids App that only repeats the table. Do not add a workflow for a process that people do not understand yet. Add the next resource when its purpose is concrete:

| Need | Add |
| --- | --- |
| Focused data entry | A form |
| A reusable subset, report, card board, or calendar | A view |
| A role-specific operating page | A Grids App |
| A printable or shareable PDF | A document template |
| A repeatable multi-step action | A workflow |
| One governed read-only table across Bases | A Combined table |

## Configure the Base for the work {icon="settings"}

Open **Base settings** in **Edit mode** for settings that apply to the whole Base:

:::reference
- **General:** Keep the Base name and description clear in the Grids overview.
- **Documents:** Store the business identity, address, contact, payment, and footer values. PDF and email templates use them.
- **Access:** Control who can use the complete raw Base workspace.
- **Trash:** List the deleted tables, fields, and forms that you can still restore.
- **Danger zone:** Move the complete Base out of active use. An administrator can restore it.
:::

Use a Grids App when people need a narrower operating page than direct access to the complete Base.

## Example: equipment loans {icon="point"}

Create the tables **Items**, **Loans**, and **Loan positions**. Each position links one item to one loan. It records the issue, the return, and the condition. Keep the borrower on the loan. [Build a business app](/app/grids/help/grids-build-business-app) shows the checks that prevent a double issue and a return through an old loan.

Then create:

- an **Available items** view for daily lookup;
- an **Open loans** view, sorted by due date;
- a **Request loan** form for guided input;
- an **Inventory overview** Grids App for staff;
- a **Loan agreement** document template;
- a **Return item** scanner workflow, when the return rules are stable.

The result stays clear because each feature has one job and all features use the same records.

## Test the Base before you expand it {icon="point"}

Use the Base for real work. Check that people recognize records, understand status values, find the right view, and know what they can change. If the model is unclear with a small sample, more automation only hides the problem.

:::note Use a template as a starting point
A Grids template can create a complete example Base. Treat it as an editable working example: rename its resources, inspect the sample records, and remove what your process does not need.
:::
