---
id: spaces-start
title: Overview
icon: ti ti-layout-sidebar
description: Core concepts and first setup path.
order: 100
---

Spaces is for shared work that needs tasks, events, lists, assignees, comments, and lightweight planning. The Spaces overview lists every work area you can access and is the right place to create, find, or return to a space.

## Overview {icon="layout-grid"}

:::reference
- **Space:** One work area for a team, project, household, class, or recurring process.
- **Item:** The basic unit of work. An item is either a task with a deadline or an event with a schedule.
- **Task:** Work with status, priority, assignees, deadline, estimated duration, blockers, tags, description, and comments.
- **Event:** A scheduled item shown in calendar views and optional calendar exports.
- **View:** The current way to see the same items as list, table, Kanban, or calendar.
- **Tags:** Lightweight labels for grouping work across assignees, deadlines, schedules, and views.
:::

## First useful path {icon="route"}

:::steps
1. **Create a space:** Name it after the shared work area, not a single task. Examples: Product Launch, Office Move, Weekly Planning.
2. **Add real items:** Create a few tasks or events before tuning views. Real work shows which statuses, tags, and assignees matter.
3. **Choose views:** Use list or table for scanning, Kanban for status flow, and calendar for scheduled work.
4. **Share with the right people:** Invite users or groups once the structure is clear enough that they can act without extra explanation.
:::

:::note When Spaces fits
Use Spaces when people need a clear shared operating surface. Use Grids when records need typed fields, relations, forms, dashboards, formulas, exports, or automations.
:::

## Use Spaces with Mail invitations {icon="calendar-share"}

Spaces owns imported meeting state, recurrence, organizers, attendees, and invitation sequence numbers. Mail owns the original message, mailbox identities, editable drafts, attachments, and delivery. This boundary keeps one event in one calendar while still using the normal Mail sending pipeline.

- Import from a Mail invitation explicitly, or respond from Mail to save/update the event and prepare an editable response draft in one step.
- A repeated delivery with the same calendar UID updates the same linked event only when its sequence is newer. Stale and duplicate deliveries do not duplicate the event.
- A cancellation completes the linked event; it cannot create a new one by itself.
- In an editable event, use **Invitations** to choose a writable mailbox and any currently verified From identity before creating an editable Mail draft. Updates use a newer sequence, cancellation is explicit, and transport failures remain visible in Spaces.
- If Mail or its required capability surface is unavailable, invitation controls stay hidden and Spaces remains fully usable as a calendar.
- From a Mail draft, choose an existing event or create a compact event in a writable Space, then attach its invitation. The draft remains editable and Mail sends it only through the normal delivery flow.

## Link Cloud resources to work {icon="link"}

A Space item can keep stable references to resources owned by other Cloud applications. In an editable item, use **Link Cloud resource** under **Linked resources** to find and attach any currently accessible resource supported by Cloud search. Mail also uses the same model to link a whole conversation to an existing task or event, or to create a linked item from the conversation details. Imported calendar invitations add the same conversation reference automatically.

The reference belongs to the shared Space item, not to the person who created it. Space access controls who can see or remove the link, while the target application checks its own current permission whenever someone opens the resource. If the target is removed or access changes, the stored label remains visible to Space readers and a writer can unlink the unavailable reference.

Links to other Space tasks appear separately as **Related tasks**. These links provide context only: they do not block either task and may point to a task in another Space when both items are accessible.
