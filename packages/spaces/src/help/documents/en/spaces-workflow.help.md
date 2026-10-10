---
id: spaces-workflow
title: Plan and track work
icon: ti ti-arrow-bounce
description: Create items, start from templates, structure tasks, and keep active work and handoffs readable.
order: 120
---

Spaces works best when each item has a clear next action. Keep item titles short, and put context in the notes. Use status or dates to make queues obvious. Use events when the work is mainly planned in the calendar.

## Create an item {icon="square-plus"}

When you create an item, Spaces first selects a task or an event, based on the current view. You can switch the type at the top of the dialog. The compact form asks for a title and a description. Events also need their schedule.

Choose **More options** to see all task or event fields. You keep what you already entered. A task gets the status where you started to create it, or the first status when none was selected.

## Start from a template {icon="template"}

When a Space has templates, the dialog for a new task or event shows a **Template** row. The row offers **Blank** and the templates for that kind of item. With more than six templates, the row becomes a searchable list.

A template fills in the title, description, priority, tags, and assignees. For a task, it also fills in the checklist. For an event, it fills in the location, time, and duration. A line below the description sums up what the template adds. Every field stays editable before you save, and **More options** shows all of them. When you already typed something, Spaces asks before a template replaces it.

A template can propose dates:

- A rule such as "Wednesday or Thursday" shows the next matching days as chips, for example **Wed 10/14**, **Thu 10/15**, and **Wed 10/21**. A rule such as "in 3 days" proposes one date.
- The first proposal is selected. Choose another chip, **Other date…** for any date, or **No date** for a task without a deadline.
- For events, the schedule field below stays available for any other time.
- Proposals use your time zone. With a weekday rule, today appears only while the time of the template has not passed yet.
- The placeholders `{{date}}`, `{{weekday}}`, and `{{week}}` in the title and description follow the chosen date until you edit the text. This also applies to **No date** and to a date from the picker.

With **Manage** access, you set up templates in the Space settings under **Templates**: a name, the defaults, the date rule, and a due time or start time. **Assign to me** assigns whoever creates the item. Changing or deleting a template never changes items that were already created from it. Everyone who can create items can use the templates.

## Structure an item {icon="point"}

:::reference
- **Title:** Use a direct action or a noun phrase. Make the title readable in a list without opening the item.
- **Assignees:** Assign people when the item needs follow-up. Leave the item unassigned when it belongs in a shared queue.
- **Status:** Use the status to show the workflow state. Kanban views depend on a consistent status.
- **Due date or event time:** Use a deadline for tasks and a schedule for events when the timing changes what people do next.
- **Estimated duration:** Record a positive estimate in whole minutes when it helps someone size or schedule a task. Events use their start and end time instead.
- **Blocked by:** Add every unfinished task that must be completed first. A blocked task cannot be completed until all active blockers are complete. Dependencies must stay in one Space and cannot form a cycle.
- **Blocks:** The task details show the reverse direction: every task that currently depends on this task.
- **Related tasks:** Link tasks that share context but do not depend on each other. A link to a related task is not a blocker.
- **Links & resources:** Attach Cloud resources and external pages, such as the GitHub issue that a task implements. Links to GitHub issues and pull requests show their title and whether they are open, closed, or merged.
- **Checklist:** Break a task into small steps when a checkbox and a label are enough. Checklist entries have no assignees, dates, or detail view of their own, on purpose.
- **Recurrence:** Use recurring events for repeated appointments or routines. Keep one-off tasks as normal tasks.
- **Tags:** Use tags for themes that cut across assignees and status, such as frontend, legal, blocked, or meeting.
- **Attachments:** Add screenshots, other images, and videos to a task when the work needs visual context. Examples are a bug report or a reel to approve.
:::

## Add images and videos to a task {icon="photo"}

Choose **Add image or video**, or drop images and videos from your computer anywhere on the open task. Each task supports up to 20 attachments.

- Spaces downscales large source images before it uploads them. It keeps videos unchanged.
- Spaces accepts MP4, MOV, M4V, WebM, and OGV videos of up to 10 MB.
- Select an existing image to open the attachment gallery. There you can download the stored image or remove it.
- A video shows its first frame. Select it to play it with the controls of your browser. You see the whole picture, even as a vertical reel, and you can download the video.
- If your browser cannot play the format of a video, Spaces offers the download instead.

Attachments and their automation links follow the access to the task: **View** access to see them, **Edit** access to change them.

## Plan in the task details {icon="list-details"}

The **Planning** block at the top of the task details shows the due date, estimate, priority, tags, and dependencies. With **Edit** access, you change each of them in place:

- Select the row to pick a date, to choose a priority, or to tick tags.
- For the estimate, type the minutes and press **Enter**.
- **No priority** at the end of the list clears the priority. **Clear date** in the calendar removes the due date.
- The pencil opens the complete form.

Under **Blocked by**, every blocking task shows its title and state: a lock for an open task, and a check mark and **done** for a finished one. Select a task to open it. **+ Task** searches the Space for another blocker. The × that appears beside a blocker removes it.

**Blocks** lists the tasks that wait for this one. From five entries on, a list shows three, open tasks first, and folds the rest behind **N more**. Without **Edit** access, you see the same values without the edit actions.

## Work through the day {icon="route"}

:::steps
1. **Open the right view:** Start from **Overview**, **Table**, **Kanban**, **Calendar**, or the filter state that fits the current work.
2. **Update the status first:** The status tells everyone what changed before they open the item.
3. **Check blockers:** When prerequisite work changes, finish or remove the active blockers. Completed blockers stay visible for context.
4. **Add context:** Use comments for discussion. Use notes for current instructions or lasting context.
5. **Close finished work:** Move completed items out of active views, so open lists stay useful.
:::

You can edit or delete your own comment for 10 minutes after you post it. Comments of other people stay unchanged, even for people with **Manage** access.

## Work quickly with the keyboard {icon="keyboard"}

- Press **Cmd/Ctrl+Alt+N** to create a task, or an event in the calendar view.
- Press **Cmd/Ctrl+Shift+K** to search the current Space.
- In Kanban, focus the board and use the arrow keys to move between cards. The keyboard button above the board lists these shortcuts.
- Press **Enter** to open the focused card, **M** to assign it to yourself, or **D** to complete it.

These single-key shortcuts stay inactive while you type in a field or editor. Cloud search and the layout help also show the available actions and their shortcuts.

## Claim a task and hand it over {icon="notes"}

Tasks can carry a progress note and a completion result. The task details show them as **Latest status** and **Last result**, below the **Assigned** list. Reopening a task keeps the last result.

Choose **I'm on it** on a board card or in the task details to claim a task. Choose **Release** to release the claim. In the details, you can leave a short handoff note when you release it.

While a task is claimed, other people see who works on it:

- The card shows the avatar of the holder with a green ring, first among the assignees, in any column.
- The **In progress** filter lists claimed tasks.
- In the details, the holder leads the **Assigned** list with the same ring, the label **working on it**, and the time they started. A holder who is not assigned is marked as such.

A claim only marks who works on the task right now. The assignment and the column do not change. CLI workers and service accounts claim the same way and appear the same way.

Claims do not expire. They coordinate work and do not lock it: with **Edit** access, you can move a claimed task between open columns, and ordinary shared edits stay available. Completing your own claimed task, also by dragging it into a done column, releases the claim. With **Edit** access, you see **Take over** for the claim of another account. You confirm it in a dialog that names the current holder. If you complete a task that someone else claimed, for example by dragging it into a done column, Spaces asks once, such as "Claimed by Jana Berger – take over and complete?". It then takes the claim over and completes the task in one step. **Cancel** leaves the card where it was. Sending a task through a wormhole to another Space ends its claim the same way: your own claim ends without a question, and you take over someone else's claim after you confirm. The activity shows who took a claim over from whom.

## Prepare invitations from Cloud search {icon="calendar-event"}

You need access to edit the event and an eligible mailbox.

:::steps
1. Open an event. Cloud search then offers **Prepare invitation**.
2. If an invitation already exists, prepare its update or its cancellation instead.
3. Choose the sending mailbox and the recipients.
4. Continue in Mail to review and send the draft.
:::
