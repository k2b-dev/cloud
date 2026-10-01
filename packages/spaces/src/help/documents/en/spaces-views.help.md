---
id: spaces-views
title: Views & Filters
icon: ti ti-filter
description: List, table, Kanban, calendar, search, and filter state.
order: 110
---

Views let the same work appear in the shape that fits the current job. The view should reduce scanning effort, not hide important complexity.

## View modes {icon="layout-list"}

:::reference
- **List:** Best for quick triage, personal work queues, and short operational lists.
- **Table:** Best when people compare assignees, deadlines, status, priority, and tags across many items.
- **Kanban:** Best when status flow matters and people need to see work moving from left to right.
- **Calendar:** Best for events, deadlines, planning windows, and work that is primarily time-based.
:::

## Filter with intent {icon="search"}

:::reference
- **Search:** Use search when you remember a word in the title, notes, or visible item metadata.
- **Chips:** Use filter chips for explicit state such as type, status, activity, assignee, priority, deadline, tags, Kanban column, sort, or grouping.
- **Inactive work:** The activity filter finds open tasks whose latest activity is at least 30 days old. Comments and checklist changes count as activity; Spaces never moves or closes the task automatically.
- **URL state:** Search and filters live in the URL, so shared links and reloads keep the same view.
:::

## Kanban board {icon="layout-kanban"}

:::reference
- **Filters:** The toolbar above the board searches and filters every column by assignment, priority, deadline, activity, and tags. **Assigned to me** shows only your work. While a filter is active, each column shows how many of its items match, for example **2/7**. A new task that does not match the filter only raises its column's count until you clear the filter. Filters stay in the URL like the list's; they never change the board for anyone else.
- **Fold a column:** Use the fold button in a column header to shrink a column you do not need right now to a narrow strip with its name and count. Select the strip to open it again. You can still drop a card on a folded column; it lands at the top. Folded columns are remembered in this browser for this Space and only for you.
- **Keyboard shortcuts:** The keyboard button at the end of the toolbar opens a list of the board's shortcuts.
- **Blocked and Overdue columns:** People with write access can turn on two automatic columns in the Space settings under **Statuses**. **Blocked** gathers open tasks that wait for unfinished tasks; **Overdue** gathers open tasks whose deadline was before today. Such a task appears only there, with its status as a small badge, and the counts of its status column leave it out. A task that is blocked and overdue stays under **Blocked** and shows an **Overdue** badge. Both columns are off for a new or existing Space.
- **Work in an automatic column:** You cannot drop a card into **Blocked** or **Overdue**; they fill themselves. Drag a card out of one to change its status: completing it moves it to the done column, and any other status keeps it in place with the new status badge until it is no longer blocked or overdue. A card you drag from a done column back to an open status returns to **Blocked** or **Overdue** if it is still blocked or overdue. Arrow keys, **M**, and **D** work there as in every column.
- **Reorder columns:** People with write access drag a column header to a new position with a mouse or pen, or use the **⋯** menu in the header to move it left or right. On a touch screen, swiping over a header scrolls the board; use the **⋯** menu there. The order changes for everyone in the Space and includes the automatic columns; the settings list under **Statuses** shows the same order.
:::

## Global search examples {icon="search"}

**Find task work**

```text
#task launch checklist
```

**Find events**

```text
#event planning
```

**Find urgent todos**

```text
#todo urgent
```
