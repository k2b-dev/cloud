---
id: kit-sharing
title: Sharing and local data
icon: ti ti-code
description: Sharing and local data in Kit
order: 103
---

Open **Settings → Sharing** as an app administrator. Read grants show metadata;
Use grants allow running the app and reading its code; Admin grants allow editing,
sharing and deleting it. Keep at least one administrator. App users can inspect
the delivered source, so never place secrets in it.

Sharing gives recipients the code, not your local files. Tools within one app
share local files and KV on the same user/device. Other users, devices and browser
profiles have separate data. Local data is not a Cloud backup.

All users with Use access can inspect the app's files and saved values under
**Settings → Local data** and download them. **Delete local data** in the sidebar
asks for confirmation, stops the run and clears only this app/current user's
local data. Close other tabs running the same app first. This does not delete
source or change sharing. Deleting browser data also removes local results.

The CLI can manage the persistenceEnabled manifest field. If disabled, script
reads and writes fail; existing data is retained and remains available in the
local explorer. There is no temporary-storage fallback. Kit settings do not
expose a toggle. Deleting the Cloud app removes source and grants, not browser
storage on other devices.
