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

## Markdown pages {icon="markdown"}

Choose **Add Markdown page** in the editor sidebar to create a `.md` file.
Edit it with the standard Markdown toolbar; its preview updates as you type.
The first `# Heading` becomes its navigation title, or the filename if absent.
Save to make it available in the app sidebar. Pages open directly without
starting a script. Rename and delete use the file menu. Keep at least one
tool or page. Pages share the app permissions and revision, and can also be
read and changed through the CLI and Assistant source operations.

## Shared data and imports {icon="database-import"}

A Cloud administrator enables rsql globally; an app administrator then enables the app database in Settings. All users with Use access share the same rows. Schema changes require Admin. Disabling access keeps data; resetting deletes tables and records, and deleting the app also deletes its server database. Local files remain separate.

Read the `kit.db` SDK page before programming database operations. `importData` validates rows and appends them in sequential batches. Its progress toast can cancel further work, but confirmed batches remain. `unknown` means the last write may already have completed. Do not blindly repeat it: automatic batch replay and durable resume are not available yet.

Start simple for a one-person tool. Do not add locks, queues or conflict machinery unless multiple users actually need them. In shared workflows, prefer constraints and remember that read-then-write is not an atomic transaction. Reset invalidates running scripts; restart them to use the new database.

## Update UI and ask for input {icon="forms"}

Use `set(value)` on UI handles. Lists and tables also have `upsert(items)` and
`remove(ids)`. Calling `remove()` with no argument clears the displayed items;
it never deletes stored data. Tables need `rowKey` for keyed changes. Read the
UI SDK Help for limits and shapes. The Alpha API has no legacy setters.

For a new task or similar entry, open `kit.ui.modal.dialog({title, fields})` from
a button. It supports text, number, select and boolean fields. Use
`kit.ui.modal.confirm`, `.text` or `.number` for a single decision or value.
Always handle cancellation before writing data. Stopping a script closes its
dialog. Titles and field labels are required; standard buttons use Cloud's language.

`kit.ui.chart({kind,...options})` offers all 14 stdlib chart types, including
line, bar, donut and map. Pass JSON options and update with `.set(options)`.
The shared UI controls theme, sizing and empty states. Formatter functions and
custom HTML are not supported. Keep a readable explanation next to the chart.
