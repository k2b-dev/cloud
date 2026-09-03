---
id: notebooks-write-organize
title: "Write & organize"
icon: "ti ti-markdown"
description: "Write readable Markdown notes, discuss pages, connect them with links and tags, and attach files."
order: 120
---

Write notes as readable Markdown, then use links, tags, attachments, and the sidebar to make the notebook navigable.

**Collaboration**

## Discuss a page {icon="message-circle"}

Use **Comments** in the note details for questions, feedback, and decisions that belong beside the page but should not change its Markdown.

:::reference
- **Views:** Writers and admins can follow discussions in Write or Read-only. Book has no detail panel or discussions.
- **Add:** Writers can post Markdown comments. New comments appear live for other users viewing the detail panel.
- **Correct:** You can edit or delete your own comment for ten minutes after posting.
- **Locked notes:** A lock freezes the note body, not its discussion. Writers can still comment on a locked note.
:::

Keep durable handbook content in the note itself. Use comments to discuss that content before or after it changes.

**Markdown**

## Write a useful note {icon="pencil"}

:::reference
- **Headings:** Use #, ##, and deeper headings to create sections. The first H1, or otherwise the first visible line, is also the note title used by navigation and search.
- **Lists and tasks:** Use - for lists and - [ ] or - [x] for tasks.
- **Slash menu:** Use the editor insert menu for common blocks such as notes, files, and tables. Type ::: for data, query, contents, and callout blocks.
:::

**Normal note**

```text
# Trip notes

Use short paragraphs. Keep one idea per section.

## Packing
- [x] Passport
- [ ] Charger
- [ ] Rain jacket

## Ideas
- Visit the old town early
- Keep one evening open
```

**Readable emphasis**

## Callouts {icon="message-circle"}

Use callouts for context, decisions, warnings, and status that should be visible while scanning a note.

**Readable boxes**

```text
# Project brief

:::info
Use this box for context that readers should notice.
:::

:::success
Decision: keep the first version small.
:::

:::warning
Risk: waiting for final prices.
:::
```

**Organization**

## Links, tags, and attachments {icon="link"}

:::reference
- **Note links:** The Markdown form is [Label](note://shortId), but the editor can insert links for you.
- **Tags:** Use #garden style tags for cross-note grouping. Tag filters match parsed tags, not arbitrary words.
- **Attachments:** Images render inline. Other files render as links. Both use attach://shortId references.
:::

**Hub note with links**

```text
# Garden hub

#garden #spring #planning

Use /note to insert links. You do not need to find note ids by hand.

- [Plant list](note://aB12Cd)
- [Bed plan](note://xY98Qr)
- [Seed order.pdf](attach://pQ45Rt)
```

**Attachment references**

```text
# Receipt

Drag a file into the editor, paste an image, or type /file.

Images render inline:

![Tomato seedlings](attach://img123)

Other files render as links:

[Soil test.pdf](attach://pdf123)
```
