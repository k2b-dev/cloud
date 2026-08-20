---
id: spaces-troubleshooting
title: Troubleshooting
icon: ti ti-lifebuoy
description: Fix missing spaces or items, unexpected views, assignment problems, and calendar export issues.
order: 140
---

## Common symptoms {icon="lifebuoy"}

:::reference
- **A space is missing from the overview:** Confirm that you still have read access. Spaces shared through a group can disappear when group membership changes.
- **An item is missing:** Clear search and filter chips, then check the current view. A task without a date may not appear where a calendar-only view is expected.
- **Kanban shows the wrong column:** Kanban grouping follows the selected grouping field, commonly status. Open the item and correct that field instead of moving unrelated filters.
- **An assignee cannot update work:** Read access is not enough to edit items. The person or one of their groups needs write or admin access.
- **A completed item still appears:** Check the active filters and grouping. Some views intentionally include completed work.
- **A task cannot be completed:** Open **Blocked by** and complete or remove every active blocker first. Completed blockers remain listed for context until you unlink them.
- **A calendar subscription is stale:** Calendar clients refresh subscriptions on their own schedule. Confirm the export URL is still enabled before replacing it.
- **A Mail invitation cannot be imported:** Confirm that Spaces is running, the attachment contains one supported REQUEST, PUBLISH, or CANCEL event, and you have write access to the chosen Space. A default Space is only a suggestion.
- **A response action is missing in Mail:** Confirm that the message contains a supported REQUEST, you can write to at least one Space, and Mail has a verified sender identity. The response action saves/updates the event and prepares an editable Mail draft; it does not bypass Mail delivery review.
- **An invitation draft failed:** Open the event in Spaces and review the message under **Invitations**. Correct Mail access or the verified sender identity, then retry explicitly. The idempotency key prevents one retry from creating a second draft.
:::

## Reset a confusing view {icon="layout-list"}

:::steps
1. Return to the space from the Spaces overview.
2. Choose List for the least transformed view of the items.
3. Clear search and filter chips.
4. Open the missing item from another known view or global search.
5. Reapply one filter at a time.
:::

:::warning Calendar links are access links
Anyone with a working calendar export URL may be able to read the exported event details. Disable or replace the export when a link has been shared too widely.
:::
