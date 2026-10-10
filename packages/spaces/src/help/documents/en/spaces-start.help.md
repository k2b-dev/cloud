---
id: spaces-start
title: Start with Spaces
icon: ti ti-layout-sidebar
description: Learn the basic terms, set up a Space, and connect it to Mail invitations and other resources.
order: 100
---

Spaces is for shared work that needs tasks, events, lists, assignees, comments, and lightweight planning. The Spaces overview lists every Space that you can access. There you create, find, or return to a Space.

When you open Spaces from the navigation, you return to the Space that you looked at last in this browser, even in another tab. If that Space was deleted or is no longer shared with you, the overview opens instead.

## Know the basic terms {icon="layout-grid"}

:::reference
- **Space:** One work area for a team, project, household, class, or recurring process.
- **Item:** The basic unit of work. An item is either a task with a deadline or an event with a schedule.
- **Task:** Work with status, priority, assignees, deadline, estimated duration, blockers, a simple checklist, tags, description, and comments.
- **Event:** A scheduled item. Events appear in calendar views and in optional calendar exports.
- **View:** The current way to see the same items: as a list, a table, a Kanban board, or a calendar.
- **Tags:** Lightweight labels that group work across assignees, deadlines, schedules, and views.
:::

## Set up a Space {icon="route"}

:::steps
1. **Create a Space:** Name it after the shared work area, not after a single task. Examples: Product Launch, Office Move, Weekly Planning.
2. **Add real items:** Create a few tasks or events before you adjust views. Real work shows which statuses, tags, and assignees matter.
3. **Choose views:** Use the list or table to scan, Kanban for the status flow, and the calendar for scheduled work.
4. **Share the Space:** Invite people and groups when the structure is clear. They can then start without extra explanation.
:::

:::note When Spaces fits
Use Spaces when people need a clear shared place to work. Use Grids when records need typed fields, relations, forms, dashboards, formulas, exports, or automations.
:::

## Use Spaces with Mail invitations {icon="calendar-share"}

Spaces owns the imported meeting state, recurrence, organizers, attendees, and invitation sequence numbers. Mail owns the original message, mailbox identities, editable drafts, attachments, and delivery. So each event stays in one calendar, and invitations still go through the normal Mail delivery.

- Import an invitation from Mail explicitly. Or respond in Mail: this saves or updates the event and prepares an editable response draft in one step.
- A repeated delivery with the same calendar UID updates the same linked event only when its sequence is newer. Stale and duplicate deliveries do not duplicate the event.
- A cancellation completes the linked event. A cancellation alone cannot create a new event.
- In an editable event, open **Invitations**. Choose a writable mailbox and a currently verified From identity, then create an editable Mail draft.
- Updates use a newer sequence. You send a cancellation explicitly. Delivery failures stay visible in Spaces.
- If Mail or the capability that Spaces needs is unavailable, Spaces hides the invitation controls. You can still use Spaces fully as a calendar.
- In a Mail draft, choose an existing event, or create a compact event in a writable Space. Then attach its invitation. The draft stays editable, and Mail sends it only through the normal delivery.

## Link resources and pages to work {icon="link"}

Every item has one **Links & resources** list for Cloud resources and external pages. In an editable item, you have two options:

- Choose **Add link** to attach an `http(s)` URL with an optional label. Each item holds up to 20 external links.
- Choose **Link Cloud resource** to find and attach a resource from Cloud search. You can attach any supported resource that you can currently access.

A link to a GitHub issue or pull request shows `repository#number`, the title, and whether it is open, closed, or merged. Other links show the icon and host of the site, or the label that you gave them. Previews are read-only. They refresh a few minutes after the state changes on GitHub. Spaces never writes to GitHub.

Public repositories need no setup. For private repositories, a person with **Manage** access can store a GitHub token under **Space settings → GitHub**. Without a token, private links appear as plain links. Link a task to its issue instead of repeating the issue in the description.

An item can keep stable references to resources that other Cloud apps own. Mail uses the same model to link a whole conversation to an existing task or event. Mail can also create a linked item from the conversation details. Imported calendar invitations add the same conversation reference automatically.

The reference belongs to the shared item, not to the person who created it. Access to the Space controls who can see or remove the link. The target app checks its own current access whenever someone opens the resource. If the target is removed or access changes, everyone who can see the Space still sees the stored label. With **Edit** access, you can remove the unavailable reference.

Links to other tasks appear separately as **Related tasks**, directly above this list. These links give context only: they do not block either task. A link can point to a task in another Space when both items are accessible.
