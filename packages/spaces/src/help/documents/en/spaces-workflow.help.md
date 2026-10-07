---
id: spaces-workflow
title: Workflow
icon: ti ti-arrow-bounce
description: How to structure items and keep active work readable.
order: 120
---

Spaces works best when each item has a clear next action. Keep item titles short, put context in notes, and use status or dates to make queues obvious. Use events when the calendar view should carry the work.

When you create an item, Spaces initially selects a task or event based on the current view. You can switch the type at the top of the dialog. The compact form asks for a title and description; events also require their schedule. Choose **More options** for the complete task or event fields without losing what you entered. A task uses the status where you started creating it, or the first status when none was selected.

## Good item structure {icon="point"}

:::reference
- **Title:** Use a direct action or noun phrase. The title should be readable in a list without opening the item.
- **Assignees:** Assign people when the item needs follow-up. Leave it unassigned when it belongs in a shared queue.
- **Status:** Use status to show workflow state. Kanban views depend on this being consistent.
- **Due date or event time:** Use a deadline for tasks and a schedule for events when timing changes what people should do next.
- **Estimated duration:** Record a positive whole-minute estimate when it helps someone size or schedule a task. Events use their start and end time instead.
- **Blocked by:** Add every unfinished task that must be completed first. A blocked task cannot be completed until all active blockers are complete. Dependencies must stay within one Space and cannot form a cycle.
- **Blocks:** The task details show the reverse direction: every task that currently depends on this task.
- **Related tasks:** Link tasks that share context but do not depend on each other. A related-task link is not a blocker.
- **Links & resources:** Attach Cloud resources and external pages such as the GitHub issue a task implements. GitHub issue and pull request links show their title and open, closed, or merged state.
- **Checklist:** Break a task into small steps when a checkbox and label are enough. Checklist entries intentionally have no assignees, dates, or separate detail view.
- **Attachments:** Add screenshots, other images, and videos to a task when the work needs visual context, such as a bug report or a reel to approve. Use **Add image or video**. Spaces downscales large source images before uploading them and keeps videos unchanged. It accepts MP4, MOV, M4V, WebM, and OGV videos of up to 10 MB. Select an existing image to open the attachment gallery, download the stored image, or remove it. Select a video, which shows its first frame, to play it with your browser's own controls, see the whole picture even as a vertical reel, or download it. If your browser cannot play a video's format, Spaces offers the download instead. Each task supports up to 20 attachments. Attachments and their automation links follow the task's read and write permissions.
- **Recurrence:** Use recurring events for repeated appointments or routines. Keep one-off tasks as normal tasks.
- **Tags:** Use tags for themes that cut across assignees and status, such as frontend, legal, blocked, or meeting.
:::

## Plan in the task details {icon="list-details"}

The **Planning** block at the top of the task details shows the due date,
estimate, priority, tags, and dependencies. With write access you change each
of them in place: select the row to pick a date, type the estimate in minutes
and press Enter, choose a priority, or tick tags. **No priority** at the end of
the list clears the priority; **Clear date** in the calendar removes the due
date. The pencil opens the complete form.

Under **Blocked by**, every blocking task shows its title and state: a lock for
an open task, a check mark and **done** for a finished one. Select a task to
open it. **+ Task** searches the Space for another blocker, and the × that
appears beside a blocker removes it. **Blocks** lists the tasks that wait for
this one. From five entries on, a list shows three, open tasks first, and
folds the rest behind **N more**. Without write access you see the same values
without the edit actions.

## Daily workflow {icon="route"}

:::steps
1. **Open the right view:** Start from list, table, Kanban, calendar, or the filter state that matches the current work.
2. **Update status first:** Status tells everyone what changed before they open the item.
3. **Check blockers:** Finish or remove active blockers when prerequisite work changes. Completed blocker tasks remain visible for context.
4. **Add context in notes or comments:** Use comments for discussion. Use notes for current instructions or durable context.
5. **Close finished work:** Move completed items out of active views so open lists stay useful.
:::

You can edit or delete your own comment for 10 minutes after posting. Other people's comments remain unchanged, including for Space administrators.

## Work Quickly from the Keyboard {icon="keyboard"}

Press **Cmd/Ctrl+Alt+N** to create a task, or an event in calendar view, and press **Cmd/Ctrl+Shift+K** to search the current space. In Kanban, focus the board and use the arrow keys to move between cards; the keyboard button above the board lists these shortcuts. Press **Enter** to open the focused card, **M** to assign it to yourself, or **D** to complete it. These single-key shortcuts stay inactive while you type in a field or editor. Available actions and their shortcuts also appear in Cloud search and the layout help.

## Implementation work and handoffs {icon="notes"}

Tasks can carry a progress note and a completion result. The task details show
them as **Latest status** and **Last result**, below the **Assigned** list.
Reopening keeps the last result.

Press **I'm on it** on a board card or in the task details to claim a task; a
second click releases it, and in the details you can leave a short handoff note
on release. While a task is claimed, the card shows the holder's avatar with a
green ring first among the assignees in any column, and the **In progress**
filter lists claimed tasks. In the details, the holder leads the **Assigned**
list with the same ring, the label **working on it**, and the time they
started; a holder who is not assigned is marked as such. A claim only marks who is working on it right now;
assignment and the column do not change. CLI workers and service accounts claim
the same way and appear the same way.

Claims do not expire and cannot be overwritten. Completing a claimed task,
including dragging it into a done column, is reserved for the holder and
releases the claim. Space admins see **Take over** for another account's claim
and confirm it in a dialog that names the current holder; ordinary
collaborative edits remain available while a task is claimed.

## Prepare invitations from Cloud search {icon="calendar-event"}

Open an event to see **Prepare invitation** in Cloud search. If an invitation already exists, you can prepare its update or cancellation. Choose the sending mailbox and recipients, then continue in Mail to review and send the draft. The action is available only with event editing access and an eligible mailbox.
