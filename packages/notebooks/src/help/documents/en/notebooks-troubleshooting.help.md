---
id: notebooks-troubleshooting
title: "Troubleshooting"
icon: "ti ti-lifebuoy"
description: "Fix problems with queries, data, formulas, attachments, and views."
order: 180
---

Before you change the structure of a note, check its Markdown source and your access to the notebook.

## Fix common problems {icon="stethoscope"}

:::reference
- **A query shows an error:** Open its source and check the marked line. Use source: notes and supported fields and operators. Close the block with :::.
- **Named data is missing from a query:** Put @name directly above :::data. Use unique names and keys and flat values. Spell the field the same way in the query. Notebooks does not index invalid or duplicate named data.
- **A query returns no notes:** Check scope, tags, value types, and match. The default match: all requires every filter. The query reads saved notes, not unsaved text in another editor.
- **A formula shows an error:** Check the function spelling, the number of arguments, the column names, and circular references. Column names with spaces need backticks.
- **An attachment is missing:** Check that the file exists in this notebook and that the Markdown uses attach://shortId.
- **Editing or comments are missing:** **View** access opens only Book. With **Edit** or **Manage** access, switch to **Write** or **Read-only** for the detail panel. You cannot edit locked notes.
- **An old script no longer runs:** Executable scripting is no longer supported. Existing script fences stay readable code. Replace page lists with :::query and contents with :::toc. Script buttons and write actions have no replacement.
:::

## Check updates {icon="refresh"}

**Write** synchronizes the note text with other editors. Saved changes refresh query previews and Book content. **Read-only** does not receive shared text edits. Reload it after the saved source changes.

If a Book page cannot refresh, its last readable content stays visible, and you can try again. If your access ends or the page disappears, Notebooks stops showing the old content and checks the page again. Without JavaScript, reload the page to see changes.
