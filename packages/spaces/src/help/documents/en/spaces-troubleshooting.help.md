---
id: spaces-troubleshooting
title: Fix problems in Spaces
icon: ti ti-lifebuoy
description: Find missing Spaces or items, fix unexpected views and assignment problems, and repair calendar exports and Mail invitations.
order: 140
---

## Fix common problems {icon="lifebuoy"}

:::reference
- **A Space is missing from the overview:** Check that you still have access to the Space. A Space that is shared through a group can disappear when your group membership changes.
- **An item is missing:** Clear the search and the filter chips. Then check the current view. A calendar-only view can hide a task without a date.
- **Kanban shows the wrong column:** Kanban groups by the selected grouping field, usually the status. Open the item and correct that field. Do not change unrelated filters.
- **An assignee cannot update work:** **View** access is not enough to edit items. The person or one of their groups needs **Edit** or **Manage** access.
- **A completed item still appears:** Check the active filters and the grouping. Some views include completed work on purpose.
- **A task cannot be completed:** Check **Blocked by** in the **Planning** block of the task. Open blockers show a lock. Complete or remove every open blocker first. Completed blockers stay listed for context until you remove them.
- **A calendar subscription is stale:** Calendar clients refresh subscriptions on their own schedule. Check that the client uses the current export URL. If needed, regenerate the URL in Spaces and replace the old subscription.
- **A Mail invitation cannot be imported:** Check that Spaces is running. Check that the attachment contains one supported REQUEST, PUBLISH, or CANCEL event. Check that you have **Edit** access to the chosen Space. A default Space is only a suggestion.
- **A response action is missing in Mail:** Check that the message contains a supported REQUEST. Check that you can edit at least one Space and that Mail has a verified sender identity. The response action saves or updates the event and prepares an editable Mail draft. It does not skip the review before Mail sends it.
- **An invitation draft failed:** Open the event in Spaces and read the message under **Invitations**. Correct the Mail access or the verified sender identity. Then try again explicitly. The idempotency key prevents a retry from creating a second draft.
:::

## Reset a confusing view {icon="layout-list"}

:::steps
1. Return to the Space from the Spaces overview.
2. In the Space sidebar, choose **Overview**. It shows the items without Kanban columns or calendar periods.
3. Clear the search and the filter chips.
4. Open the missing item from another known view or from global search.
5. Apply the filters again, one at a time.
:::

## Replace a calendar link {icon="calendar-share"}

:::warning Calendar links are access links
Anyone with a working calendar export URL can read the exported event details.
:::

When a link was shared too widely, regenerate the export URL and replace the subscription.
