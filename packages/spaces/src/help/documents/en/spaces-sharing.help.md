---
id: spaces-sharing
title: Share a Space and change settings
icon: ti ti-lock
description: Give people the right access level, change Space settings, and share calendar exports safely.
order: 130
kind: task
---

Give each person and group only the access they need in this Space.

## Open Space settings {icon="settings"}

:::steps
1. Open **…** in the page header.
2. Choose **Space settings**.
:::

The settings open in a dialog. Closing it returns you to the current view.

The categories sort the settings by owner and effect:

- **Space** contains the shared name and details, tags, and workflow statuses.
- **Personal** contains your browser defaults. They apply immediately and only for you.
- **Connections** contains the calendar feed, the wormholes, and the GitHub token for link previews. Only people with **Manage** access change wormholes and the token.
- **Sharing** contains access and API keys. It is for people with **Manage** access.
- **Lifecycle** contains permanent deletion.

When a form has a footer, review its count of changes and choose **Save changes**. Actions on a list, such as adding a status, changing access, or revoking a key, save immediately after you confirm them.

## Choose the access level {icon="shield-lock"}

:::reference
- **View:** See the Space and its items. Change your personal defaults and copy the calendar feed.
- **Edit:** Also create and update items, comments, status, dates, and assignments. Change the Space details, tags, statuses, the automatic Kanban columns, and the column order.
- **Manage:** Also change wormholes, the GitHub token, access, API keys, the calendar export, and deletion.
:::

## Add a GitHub token {icon="brand-github"}

The GitHub token is optional and belongs to one Space. Spaces stores it encrypted and uses it only to preview GitHub links on items of this Space. Spaces never shows the token again.

Prefer a fine-grained token that can only read issues and pull requests of the repositories that the Space works on. Remove the token when you no longer need it.

## Share a calendar export {icon="calendar-share"}

Use the calendar export when people need scheduled work in an external calendar. **Copy iCal URL** appears only when the export is enabled.

:::warning Calendar links are access links
Anyone with the export URL can read the exported event details.
:::

:::steps
1. Open **…** in the page header.
2. Choose **Copy iCal URL**.
3. Add the copied URL as a subscription in your calendar app.
:::
