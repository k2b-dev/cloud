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

**Edit with AI** opens Assistant with the page and its discussion. Assistant can also correct or delete your recent comments after review; the same author and ten-minute rules apply. Query and TOC drafts can be checked without saving. This check does not validate every Markdown feature or table formula.

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

## Indent with Tab {icon="keyboard"}

Tab indents in the note editor, so you can nest lists and line up code without reaching for the mouse. The note stores plain spaces.

:::reference
- **Text and code:** Tab inserts two spaces at the cursor or indents the selected lines. Shift+Tab removes up to two spaces of indentation.
- **Lists:** Tab nests the current item under the item above it, and its sub-items move with it. Shift+Tab moves it back out one level.
- **Tables:** Tab selects the next cell, Shift+Tab the previous one.
- **Suggestions:** If a suggestion list is open, Tab accepts the highlighted suggestion.
- **Leave the editor:** Press Esc, then Tab to move to the next control, or Esc, then Shift+Tab to move back.
- **Keep Tab for focus:** In **Settings**, open **Notebook — View & behavior** and turn on **Tab moves focus instead of indenting**. The choice is stored in this browser and applies immediately.
:::

## Hide the navigation {icon="layout-sidebar-left-collapse"}

Hide the navigation to write with the full width, or when others can see your screen and should not see your notes and folders.

:::reference
- **Hide:** Select **Hide navigation** at the far left of the editor toolbar, press **Cmd/Ctrl+Alt+S**, type `>` in the Cloud search and run **Hide notebook navigation**, or drag the navigation's edge almost all the way to the left. The navigation disappears completely in both layouts and in Book view, including the navigator's note list and Book view's list of pages.
- **Show:** Select **Show navigation** in the same place, press **Cmd/Ctrl+Alt+S** again, or type `>` in the Cloud search and run **Show notebook navigation**. Where the editor toolbar is not shown, such as in Book view, in an empty notebook, in Read-only, in the graph, or in the attachments, the button sits in the bottom-left corner.
- **Stays hidden:** The choice is stored in this browser and applies to every notebook, also after a reload and in other open tabs. A notebook with hidden navigation opens without it, so its note titles do not appear while the page loads.
- **Your place in the note:** Hiding or showing the navigation keeps the cursor where it is, and the text at the top of the editor or of Book view stays in place.
- **Phones:** Small screens keep the navigation in the menu. The button appears on wider screens, where the navigation sits beside the note.
:::

## Typographic symbols {icon="typography"}

Notebooks shows some typed sequences as one symbol when you read or edit a note. The note keeps the characters you typed, so search, export, and Assistant see them unchanged.

| You type | You see |
| --- | --- |
| `->` `<-` `<->` | → ← ↔ |
| `=>` `<=>` | ⇒ ⇔ |
| `<=` `>=` `!=` `+-` | ≤ ≥ ≠ ± |
| `(c)` `(r)` `(tm)` | © ® ™ |
| `...` | … |
| `--` with a space on both sides | – |

:::reference
- **See the characters:** Place the cursor on a symbol or select it to edit the typed characters. **Show Markdown source** always shows them. In Book, hover a symbol.
- **Unchanged:** Code, math, links, HTML, data and query blocks, and front matter keep the typed characters.
- **Keep a sequence:** Type a backslash before its first character, for example `\->`.
:::

**Readable emphasis**

## Callouts {icon="message-circle"}

Use callouts for context, decisions, warnings, and status that should be visible while scanning a note. Write `:::note`, `:::info`, `:::success`, `:::warning`, or `:::danger` on its own line, the text, and `:::` to close. A callout is a calm box: a light tint for its type, regular text, and no icon. To give it a heading, write it after the type, such as `:::warning Open risk`. The editor, Book, and PDF export show the same box, as do Spaces descriptions, comments, and Help.

**Readable boxes**

```text
# Project brief

:::info
Use this box for context that readers should notice.
:::

:::success
Decision: keep the first version small.
:::

:::warning Open risk
Waiting for final prices.
:::
```

**Diagrams**

## Zoom and export diagrams {icon="chart-dots-3"}

Write a Mermaid diagram in a code block marked `mermaid`. The editor and Book show the rendered diagram; in the editor, click it to edit its source.

:::reference
- **Zoom:** Use the plus and minus buttons, hold Ctrl or Cmd while scrolling, or pinch on a touch screen. Plain scrolling keeps scrolling the page.
- **Move:** When zoomed in, drag the diagram or use the arrow keys. The reset button returns to the full diagram.
- **Keyboard:** Focus the diagram, then press + and - to zoom, 0 to reset, and F to open it fullscreen.
- **Fullscreen:** The fullscreen button opens the diagram in a large window with the same controls. Press Esc to close it.
- **Export:** In fullscreen, **Download SVG** saves a scalable file and **Download PNG** saves an image on the theme background. The file name is the note title.
:::

In the editor, the controls appear when you point at or focus the diagram. Every diagram opens at its full size again after a reload.

**Organization**

## Links, tags, and attachments {icon="link"}

:::reference
- **Note links:** The Markdown form is [Label](note://shortId), but the editor can insert links for you. To open a note at a heading, add the heading name in lowercase with hyphens: [Label](note://shortId#backup-restore) opens the heading "Backup & Restore". If the note has no such heading, it opens at the top.
- **Tags:** Use #garden style tags for cross-note grouping. Tag filters match parsed tags, not arbitrary words.
- **Attachments:** Images render inline. Other files render as links. Both use attach://shortId references.
- **Open an attachment:** Select an image to see it full screen. Select a PDF, Markdown, text, JSON, or CSV file to open its preview. The preview has **Download**. PDFs add **Open in new tab**, and text and JSON files add **Copy**. Other files, such as archives, audio, and video, are downloaded after you confirm. So are very large files and images that don't display in the note. This works in the editor, in Book view, in the details panel, and in the attachments view.
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
