---
id: kit-authoring
title: Create and edit apps
icon: ti ti-code
description: Create and edit apps in Kit
order: 101
---

Choose **New app** and start with a blank tool or the CSV workshop. App
administrators can open **Edit**. Each *.script.js file defines a tool:

```js
export default kit.script({ name: "My tool", run() { kit.ui.text("Hello!"); } });
```

Helpers use .js and relative imports such as ./utils.js. No external packages,
dynamic imports or network calls are available. Read the Kit SDK Help articles
for the current methods. Use workbench controls, content and footer for file tools;
initialize UI in run() and process files in callbacks. Use kit.money for amounts.

File tabs and preview tabs occupy separate pane groups. Add a file with the plus
button; rename or delete it from its menu. Renaming updates static imports.
Script preview uses your current draft and starts only when you click Start. Source
changes require a restart to appear in a running preview. The console shows
errors and log messages with timestamps.

**Save** or Ctrl/Cmd+S saves; **Cancel** confirms discarding changes. New edits made
while saving stay unsaved. On a revision conflict, download your draft, load the
latest version and reconcile. Never overwrite someone else's changes blindly.

## Markdown pages

Choose **Add Markdown page** in the editor sidebar to create a `.md` file.
Edit it with the standard Markdown toolbar; its preview updates as you type.
The first `# Heading` becomes its navigation title, or the filename if absent.
Save to make it available in the app sidebar. Pages open directly without
starting a script. Rename and delete use the file menu. Keep at least one
tool or page. Pages share the app permissions and revision, and can also be
read and changed through the CLI and Assistant source operations.
