---
id: notebooks-core-model
title: "Core model"
icon: "ti ti-components"
description: "Understand notebooks, notes, named data, queries, and attachments."
order: 110
---

A notebook is a shared workspace. A note is its Markdown source document. Named data and queries add structure without replacing that source.

## The objects {icon="box-multiple"}

:::reference
- **Notebook:** A workspace with notes, attachments, settings, permissions, and exports. Its immutable six-character id appears in URLs and APIs.
- **Note:** A Markdown document with prose, tasks, links, tables, data, and attachments. Its immutable six-character id appears in URLs and note links.
- **Note tree:** Notes can have parent notes. Navigation and queries can use that hierarchy.
- **Tag:** A #tag in note content groups notes for search, tag pages, and queries.
- **Attachment:** A file uploaded to the notebook and referenced with attach://shortId.
- **Named block:** Put @name directly above a table, list, data block, or section to give it a stable name.
- **Query:** A :::query block lists notes from this notebook, filtered by tags, title, or your named data.
- **Contents:** A :::toc block links to headings in the current note.
:::

## One source, three views {icon="book"}

**Write** edits the Markdown collaboratively. **Read-only** keeps the workspace and detail panel without editing the body. **Book** displays the note as a web page with navigation and tag filters, but no editor or discussion panel.

Read permission always opens Book. Writers and admins can switch views; admins choose their shared default in settings. An explicit URL view takes precedence. Locked notes use Read-only instead of Write.

Keep important information visible in Markdown. Queries read saved note data; they do not run code, modify pages, or create hidden state.
