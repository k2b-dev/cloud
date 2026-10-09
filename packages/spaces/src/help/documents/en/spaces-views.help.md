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

## Overdue and undated tasks in the day view {icon="calendar-due"}

:::reference
- **What it shows:** In the calendar's **Day** view, a row below the day shows open tasks whose deadline passed before today, most recent first, and open tasks assigned to you that have no deadline, most urgent first. Each part shows up to five tasks; **Show all** opens the list with every one of them.
- **Work with it:** Select a task to open it, or check it off if you may edit the Space; the confirmation offers **Undo**. A task that open tasks still block shows a lock instead of a checkbox.
- **Layout:** The row keeps its place and size whatever it holds, also while a day loads, so the day above never moves. More tasks than fit scroll sideways. A screen reader and **Tab** reach it right after the day, as on screen. When you check a task off with the keyboard, focus moves to the next task in the row.
- **Filters:** The scope, priority, status, and tag filters of the calendar apply to the row; when a filter leaves it empty, it says so. While the scope shows only events, the row is hidden.
- **Old links:** Spaces no longer has a calendar timeline. A saved link to the timeline opens the month that holds its day.
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

## Calendar colors {icon="palette"}

:::reference
- **Color by tag:** By default, an event and a task both take the color of their first tag. An item without a tag takes the color of its status, and an item whose status has no color stays a calm gray. Further tags show as small dots after the title where there is room.
- **Events and tasks:** An event is a tinted band. A task with a due date is a checkbox in its color in front of the title, without a band. Urgent and high priority add a small red flag, whatever the colors show.
- **Choose what the color shows:** Open **Scope** and choose **Tag**, **Status**, **Priority**, or **Person** under **Color by**. **Status** uses the status colors, **Priority** the priority colors, and **Person** the avatar color of the first assignee, with further assignees as dots; items without that value stay gray.
- **Kept in the link:** The choice lives in the URL like the filters, so a reload or a shared link shows the same colors. It changes only how the calendar looks for you, never the items, and an open item stays open. **Reset** in **Scope** resets the filters and keeps the color.
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
