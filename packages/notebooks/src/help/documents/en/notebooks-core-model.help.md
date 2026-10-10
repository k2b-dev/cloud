---
id: notebooks-core-model
title: "Core model"
icon: "ti ti-components"
description: "Understand notebooks, notes, named data, queries, and attachments."
order: 110
---

A notebook is a shared workspace. A note is a Markdown source document in it. Named data and queries add structure and do not replace that source.

## Know the objects {icon="box-multiple"}

:::reference
- **Notebook:** A workspace with notes, attachments, settings, access, and exports. Its six-character ID never changes and appears in URLs and APIs.
- **Note:** A Markdown document with text, tasks, links, tables, data, and attachments. Its six-character ID never changes and appears in URLs and note links.
- **Note tree:** A note can have a parent note. Navigation and queries can use this hierarchy.
- **Homepage:** The homepage note comes first on its level of the note tree in the sidebar and shows a home icon. Set it in **Settings → Notebook → General**.
- **Tag:** A #tag in the note text groups notes for search, tag pages, and queries.
- **Attachment:** A file that you upload to the notebook. Notes refer to it with attach://shortId.
- **Named block:** Write @name directly above a table, list, data block, or section. This gives the block a stable name.
- **Query:** A `:::query` block lists notes from this notebook. It filters by tags, title, or your named data.
- **Contents:** A `:::toc` block links to the headings in the current note.
:::

## Choose one of three views {icon="book"}

:::reference
- **Write:** Edit the Markdown together with others.
- **Read-only:** Keep the workspace and the detail panel, without editing the note text.
- **Book:** Read the note as a web page with navigation and tag filters. Book has no editor and no discussion panel.
:::

**View** access always opens Book. With **Edit** or **Manage** access, you can switch views. People with **Manage** access choose the shared default view in the settings. A view in the URL comes before the default. Locked notes open in **Read-only** instead of **Write**.

Keep important information visible in the Markdown. Queries read saved note data. They do not run code, change pages, or create hidden state.
