---
id: spaces-views
title: Use views and filters
icon: ti ti-filter
description: Choose between list, table, Kanban, and calendar, filter the items, and plan in the day and month views.
order: 110
---

Views show the same items in the shape that fits the current job. A good view reduces scanning effort and does not hide important complexity.

## Choose a view {icon="layout-list"}

:::reference
- **List:** Best for quick triage, personal work queues, and short operational lists.
- **Table:** Best when people compare assignees, deadlines, status, priority, and tags across many items.
- **Kanban:** Best when the status flow matters and people need to see work move from left to right.
- **Calendar:** Best for events, deadlines, planning windows, and work that is mainly time-based.
:::

## Work with overdue and undated tasks in the day view {icon="calendar-due"}

:::reference
- **What it shows:** In the **Day** view of the calendar, a row below the day shows two kinds of open tasks. First, tasks whose deadline passed before today, most recent first. Second, tasks assigned to you without a deadline, most urgent first. Each part shows up to five tasks. **Show all** opens the list with all of them.
- **Work with it:** Select a task to open it. If you can edit the Space, you can also check the task off; the confirmation offers **Undo**. A task that open tasks still block shows a lock instead of a checkbox.
- **Layout:** The row keeps its place and size whatever it holds, so the day above never moves. While another day or filter loads, the row stays empty until its tasks are in. When more tasks exist than fit, the row scrolls sideways. A screen reader and **Tab** reach the row right after the day, as on screen. When you check a task off with the keyboard, focus moves to the next task in the row.
- **Filters:** The scope, priority, status, and tag filters of the calendar apply to the row. When a filter leaves the row empty, the row says so. While the scope shows only events, the row is hidden.
- **Old links:** Spaces no longer has a calendar timeline. A saved link to the timeline opens the month that contains its day.
:::

## Filter with intent {icon="search"}

:::reference
- **Search:** Use search when you remember a word in the title, the notes, or the visible item details.
- **Chips:** Use filter chips for explicit state such as type, status, activity, assignee, priority, deadline, tags, Kanban column, sort, or grouping.
- **Inactive work:** The activity filter finds open tasks whose latest activity is at least 30 days old. Comments and checklist changes count as activity. Spaces never moves or closes the task automatically.
- **URL state:** Search and filters live in the URL, so shared links and reloads keep the same view.
:::

## Work on the Kanban board {icon="layout-kanban"}

:::reference
- **Filters:** The toolbar above the board searches and filters every column by assignment, priority, deadline, activity, and tags. **Assigned to me** shows only your work. While a filter is active, each column shows how many of its items match, for example **2/7**. A new task that does not match the filter only raises the count of its column until you clear the filter. Filters stay in the URL, as in the list. They never change the board for anyone else.
- **Fold a column:** Use the fold button in a column header to shrink a column that you do not need now. The column becomes a narrow strip with its name and count. Select the strip to open the column again. You can still drop a card on a folded column; the card lands at the top. This browser remembers folded columns for this Space and only for you.
- **Keyboard shortcuts:** The keyboard button at the end of the toolbar opens a list of the shortcuts of the board.
- **Blocked and Overdue columns:** With **Edit** access, you can turn on two automatic columns in the Space settings under **Statuses**. **Blocked** gathers open tasks that wait for unfinished tasks. **Overdue** gathers open tasks whose deadline was before today. Such a task appears only there, with its status as a small badge. The count of its status column leaves it out. A task that is blocked and overdue stays under **Blocked** and shows an **Overdue** badge. Both columns are off for a new or existing Space.
- **Work in an automatic column:** You cannot drop a card into **Blocked** or **Overdue**; they fill themselves. Drag a card out of one to change its status. Completing it moves it to the done column. Any other status keeps it in place with the new status badge, until it is no longer blocked or overdue. When you drag a card from a done column back to an open status, it returns to **Blocked** or **Overdue** if it is still blocked or overdue. Arrow keys, **M**, and **D** work there as in every column.
- **Reorder columns:** With **Edit** access, drag a column header to a new position with a mouse or pen. Or use the **⋯** menu in the header to move the column left or right. On a touch screen, a swipe over a header scrolls the board, so use the **⋯** menu there. The order changes for everyone in the Space and includes the automatic columns. The list under **Statuses** in the settings shows the same order.
:::

## Plan in the month view {icon="calendar-month"}

:::reference
- **Toolbar:** In every calendar view, the filters **Scope**, **Priority**, **Status**, and **Tags** and the number of shown entries sit right after the month name. When the calendar is narrower, the filters show only their icons or move to a row of their own.
- **Select days:** Choose a day to select it. This never leaves the month. To select several days, drag across them with a mouse, or hold **Shift** while you choose days or use the arrow keys. On a phone, touching a day selects that one day. The arrow keys move the selection, **Page Up** and **Page Down** change the month, and **Esc** clears the selection.
- **Create on the selection:** After you choose a day with the mouse, a small **New entry** form waits beside the day. It does not take the keyboard: start typing, or press **Tab** to fill it in. After a drag across days, a double-click, **Enter**, or **N**, the form opens ready for the title. On a phone, touch the selected day a second time to open it. Choose **Event**, **All day**, or **Task**; the line beside it says when. **Enter** creates the entry, and **With details** opens the full form. Press **Esc** or choose a place outside the form to cancel. A drag over several days, or **New event** in the menu of several days, creates one all-day event over all of them. **New event** in the toolbar opens the full form for the selected days.
- **Menu:** Right-click, long-press on a phone, or press **Shift+F10** on a day or on the selected days. The menu offers **New event**, **New all-day event**, and **New task with deadline** for those days, then **Open day** and **Open week**.
- **Open a day or a week:** Select a day and choose **Day** or **Week** in the view switcher. Or use **Open day** in the menu or in the day list. Or choose a week number.
- **Long events:** An event over several days is one bar per week row, with its title. Where a week row cuts the event off, its end is torn. When there is room, the bar says where the event continues, for example **until 13** or **from 7**. The next row continues the event. When you point at one part, the other parts are highlighted.
- **Full days:** Each day shows as many entries as fit its height. **+N more** counts the rest and opens the whole day. **Space** on a selected day does the same.
:::

## Choose the calendar colors {icon="palette"}

:::reference
- **Color by tag:** By default, an event and a task both take the color of their first tag. An item without a tag takes the color of its status. An item whose status has no color stays a calm gray. Further tags show as small dots after the title where there is room.
- **Events and tasks:** An event is a tinted band. A task with a due date is a checkbox in its color in front of the title, without a band. Urgent and high priority add a small red flag, whatever the colors show.
- **Choose what the color shows:** Open **Scope** and choose **Tag**, **Status**, **Priority**, or **Person** under **Color by**. **Status** uses the status colors, and **Priority** uses the priority colors. **Person** uses the avatar color of the first assignee and shows further assignees as dots. Items without that value stay gray.
- **Kept in the link:** The choice lives in the URL like the filters, so a reload or a shared link shows the same colors. It changes only how the calendar looks for you, never the items. An open item stays open. **Reset** in **Scope** resets the filters and keeps the color.
:::

## Find items with global search {icon="search"}

**Find task work**

```text
#task launch checklist
```

**Find events**

```text
#event planning
```

**Find urgent tasks**

```text
#todo urgent
```
