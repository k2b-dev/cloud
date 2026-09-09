---
id: kit-start
title: Browser tools
icon: ti ti-code
description: Create, use and share small tools that process files on your device.
order: 100
---

Create an app to start with a CSV converter and a history page. Open **Use app**
to run it, or **Edit** to change the JavaScript files. Only app administrators
can edit or share an app.

## Use an app

The tool opens automatically. Choose a CSV, preview the data, select output
columns and export the result. **Past exports** offers earlier downloads.
Selected files stay in your
browser; Kit does not upload them or change the originals. Download links
appear below the results. **Stop** terminates the running script.

An app can contain several tools. Select a tool in the left navigation. When
local storage is enabled, those tools share results on this device. Other
users and browser profiles have separate data. Sharing an app shares its code
and settings, not your local files. Clearing browser storage removes local
results.

## Edit and share

Each `*.script.js` file defines one tool using
`export default kit.script({ name: "My tool", run() { kit.ui.text("Hello"); } })`.
Use other `.js` files for helpers and import them using relative paths.
The editor shows syntax colors without autocomplete. Files and preview open in
tabs. Use each file’s menu to rename or delete it. Cancel asks before discarding
unsaved changes. Save with the button or Ctrl/Cmd+S.
Preview runs the current editor contents. Use mode runs the saved revision.

The sidebar footer contains **Edit** and **Settings**. **Settings → Share**
offers three permissions: metadata only, use, or edit and share.
People who can use an app can inspect its JavaScript. Never put secrets in
source code.

If another editor has saved first, reload before saving your changes. Keep a
copy of your edits before reloading.
