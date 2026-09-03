---
id: notebooks-troubleshooting
title: "Troubleshooting"
icon: "ti ti-lifebuoy"
description: "Resolve query, data, formula, attachment, and view problems."
order: 180
---

Check the note's Markdown source and your notebook permissions before changing its structure.

## Common symptoms {icon="stethoscope"}

:::reference
- **A query shows an error:** Open its source and check the marked line. Use source: notes, supported fields and operators, and close the block with :::.
- **Named data is missing from a query:** Put @name directly above :::data. Use unique names and keys, flat values, and the same field spelling in the query. Invalid or duplicate named data is not indexed.
- **A query returns no notes:** Check scope, tags, value types, and match. The default match: all requires every filter. The query reads saved notes, not unsaved text in another editor.
- **A formula shows an error:** Check function spelling, argument count, column names, and circular references. Column names with spaces need backticks.
- **An attachment is missing:** Confirm the file exists in this notebook and the Markdown uses attach://shortId.
- **Editing or comments are absent:** Read permission opens Book only. Writers and admins can switch to Write or Read-only for the detail panel. Locked notes cannot be edited.
- **An old script no longer runs:** Executable scripting is no longer supported. Existing script fences remain readable code; replace page lists with :::query and contents with :::toc. There is no replacement for script buttons or write actions.
:::

## Check updates {icon="refresh"}

Write synchronizes the note body with other editors. Saved changes refresh query previews and Book content. Read-only does not subscribe to collaborative body edits: reload it after the saved source changes.

If a Book page cannot refresh, its last readable content stays visible and you can retry. If access is revoked or the page disappears, Notebooks stops displaying the stale content and checks the page again. Without JavaScript, reload to see changes.
