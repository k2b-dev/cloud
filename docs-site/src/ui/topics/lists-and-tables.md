---
thumbnail: table
---

# Lists and tables

Many things of one kind. Use a `List` when each entry reads as a line of text, a `Table` when people compare values across rows. Both open an entry by its address.

## A table to compare

Open invoices with a status row: the lead says how many, the figures follow, the filter sits at the end. Each row opens its invoice and has one deed. Switch the state: empty, loading and failed stand where the rows would stand, and nothing above them moves.

<Example recipe="table" height="440" default="Rows" />

## A list beside the open entry

Sources of Pulse: two-line rows, the open one tinted, its detail beside the list. The open entry is in the address, so reload and back show the same. On the phone the detail leaves and an entry opens as its own page.

<Example recipe="list-detail" height="560" default="Open" />

## List or table?

### List

- Each entry reads as one thing: a message, a source, a task.
- One to three lines per entry, a time, a few marks.
- A detail opens beside it (`Pane.Split`).

### Table

- People compare values down a column: amounts, dates, states.
- They sort by a column, select many rows or group them.
- On the phone it becomes two-line rows (`phone`).

## Parts

Each part in one line. Props are generated from the types of `@k2b/ui/v2`, so this list cannot fall behind the code.

### List

Many like things, one per line; `label` names it.

<Props of="List" />

### Row

One entry: one to three lines, a lead, a time, marks and one action; `current`, `unread` and `yours` mark it.

<Props of="Row" />

### Table

Columns of like things: fixed widths, cut text, dropped columns and two-line rows on the phone.

<Props of="Table Column" />

### StatusRow

Above the rows: the one statement, key figures and filters; a selection bar while rows are selected.

<Props of="StatusRow" />

### Pane.Split

The list beside the open entry; `Pane detail` holds the entry and leaves on the phone.

<Props of="Pane.Split Pane" />

### Empty · Loading · Failed

The states, in the place of the rows; their rules are in [States and notices](/en/ui/v2/states-and-notices).

<Props of="Empty Loading Failed" />

## Not in v2 yet

Reorder by dragging, and a tree. Until they ship, use the nearest part and write `// k2b-ui gap: …` at that place.

## Do and don't

### Do

- Open an entry by `href`; add `onNavigate` to open it in place.
- Give every wide table a `phone(row)`.
- Put the count and key figures in the `StatusRow`.
- Keep row text short; long text is cut with "…".

### Don't

- Draw your own lines between rows or around a table.
- Open entries with `onClick` when they have an address.
- Put "Erneut versuchen" anywhere but `Failed`.
- Shrink columns on the phone; `drop` them.

## Next

[Filter, sort, group](/en/ui/v2/filter-sort-group)
