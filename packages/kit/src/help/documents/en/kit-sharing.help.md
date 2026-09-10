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
**Local data** in the sidebar and download them. The explorer can delete individual
files or saved values, or clear all local data. Each deletion asks for confirmation
and stops the run. It affects only this app/current user's local data. Close other tabs running the same app first. This does not delete
source or change sharing. Deleting browser data also removes local results.

The CLI can manage the persistenceEnabled manifest field. If disabled, script
reads and writes fail; existing data is retained and remains available in the
local explorer. There is no temporary-storage fallback. Kit settings do not
expose a toggle. Deleting the Cloud app removes source and grants, not browser
storage on other devices.


## Shared database

If enabled in **Settings → Shared database**, the app can store data on the server. Every user with Use permission shares that data. This is separate from local files and KV. App Admin can disable access without deleting data, export a snapshot or reset the database after confirmation. Deleting the app also deletes its server database; pending deletion is retried if rsql is unavailable. Global administrators configure the optional server under `/admin/kit`.

Cloud administrators use the row actions menu on **Kit administration** (`/admin/kit`). Choose **Permissions** to open the access editor directly; the dialog contains no app settings.
