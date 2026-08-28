---
id: notebooks-core-model
title: "Core model"
icon: "ti ti-components"
description: "The stable concepts behind notebooks, notes, named blocks, attachments, and scripts."
order: 110
---

A notebook is a shared workspace. A note is the source document. Named blocks and scripts add structure around that source instead of replacing it.

**Core model**

## The objects {icon="box-multiple"}

:::reference
- **Notebook:** A workspace with notes, attachments, settings, permissions, exports, optional scripts, and notebook-local state. Its id is the immutable six-character id used in URLs and APIs.
- **Note:** A Markdown document that can contain prose, tasks, links, tables, data blocks, attachments, and script output. Its id is the immutable six-character id used in URLs and note links.
- **Note tree:** Notes can have parent notes. The sidebar uses that hierarchy for navigation.
- **Tag:** A #tag parsed from note content and used by search, tag pages, and scripts.
- **Attachment:** A file uploaded to the notebook and referenced from Markdown with attach://shortId.
- **Named block:** A table, list, todo list, data block, or section marked with @name so scripts can read it.
- **Script:** A trusted JavaScript block that reads notebook APIs and renders output in the note.
:::

:::success Source of truth
Keep important information visible in Markdown. Scripts and formulas should summarize or update readable source data, not hide the only copy of it.
:::
