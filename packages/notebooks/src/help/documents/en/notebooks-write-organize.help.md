---
id: notebooks-write-organize
title: "Write & organize"
icon: "ti ti-markdown"
description: "Write readable Markdown notes, discuss pages, connect them with links and tags, and attach files."
order: 120
---

Write notes as readable Markdown. Then use links, tags, attachments, and the sidebar to make the notebook easy to navigate.

**Collaboration**

## Discuss a page {icon="message-circle"}

Use **Comments** in the note details for questions, feedback, and decisions. Comments belong next to the page but do not change its Markdown.

:::reference
- **Views:** With **Edit** or **Manage** access, you follow discussions in **Write** or **Read-only**. Book has no detail panel and no discussions.
- **Add:** With **Edit** access, you can post Markdown comments. Other people who have the detail panel open see new comments immediately.
- **Correct:** You can edit or delete your own comment for ten minutes after you post it.
- **Locked notes:** A lock freezes the note text, not its discussion. With **Edit** access, you can still comment on a locked note.
:::

Keep lasting handbook content in the note itself. Use comments to discuss that content before or after it changes.

**Edit with AI** opens Assistant with the page and its discussion. After a review, Assistant can also correct or delete your recent comments. The same author and ten-minute rules apply. Assistant can check query and contents drafts without saving them. This check does not cover every Markdown feature or table formula.

## Restore a saved version {icon="history"}

Open the note details and choose **Version history**. Pick a version to see its content or the changes.

**Restore this version** makes it the current content for everyone working in the note. The note then opens in **Write**. The previous content stays in the history. Choose **Undo** in the confirmation to bring it back.

**Restore as copy** creates a new note directly below the original, under the same parent. The original stays unchanged.

You need **Edit** access to restore. A locked note can only be restored as a copy.

**Markdown**

## Write a useful note {icon="pencil"}

:::reference
- **Headings:** Use #, ##, and deeper headings to create sections. The first H1 is the note title in navigation and search. Without an H1, the first visible line is the title.
- **Lists and tasks:** Use - for lists. Use - [ ] or - [x] for tasks. Use 1. for numbered lists. They count up from their first number. Nested numbered lists show a., b. and then i., ii. in the editor, Book view, and PDF.
- **Format text:** Use the toolbar or the keys below. Without a selection, the format applies to the word at the cursor. Spaces at the edge of a selection stay outside the format. Press the same keys again to remove the format. If you select only part of formatted text, only that part loses the format. Formatting does not apply in code, in link addresses, in tags, or across paragraphs and list items.
- **Slash menu:** Use the insert menu of the editor for common blocks such as notes, files, and tables. Type ::: for data, query, contents, and callout blocks.
- **Markdown characters:** Rich mode shows characters such as `**` or `#` when your cursor is in them. When you select with the mouse, they appear after you release the button. The text stays still while you drag.
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

## Format text {icon="typography"}

The toolbar shows the current text style and active formats. Its buttons and keys turn a format on and off.

| Key | What happens |
| --- | --- |
| **Ctrl/⌘+B** | Toggles bold. |
| **Ctrl/⌘+I** | Toggles italic. |
| **Ctrl/⌘+Shift+S** | Toggles strikethrough. |
| **Ctrl/⌘+Shift+H** | Toggles highlight: `==text==`. |
| **Ctrl/⌘+E** | Toggles inline code. |
| **Ctrl/⌘+K** | Inserts a link; selected text becomes its label. |
| **Ctrl/⌘+Alt+K** | Opens the picker to link another note. |
| **Ctrl/⌘+Shift+1/2/3** | Toggles Heading 1/2/3. Press again to return to normal text. |
| **Ctrl/⌘+Shift+7/8/9** | Toggles a numbered list, bullet list, or checklist. |
| **Ctrl/⌘+Z** / **Ctrl/⌘+Shift+Z** | Undoes or redoes. Every toolbar action and every Enter is its own step. |

The heading and list shortcuts use the physical digit keys on every keyboard layout. On a Mac, macOS keeps **⌘+Shift+3** for screenshots; choose Heading 3 in the style menu instead.

:::reference
- `/` at a line start or after whitespace opens the insert menu. Type a command name to filter it.
- `[[` opens note suggestions. Choosing a note replaces the typed brackets with a Markdown link to it.
- `![[` opens attachment suggestions. Choosing an image embeds it; choosing another file inserts a download link.
- `==text==` highlights text. Highlight stays within one line.
- On touch screens, **Undo** and **Redo** sit at the start of the toolbar.
- On a phone, the toolbar stays above the keyboard while you type, so you can format, indent, and outdent without closing the keyboard.
:::

## Lists {icon="keyboard"}

Lists in the note editor follow their structure. The keys work the same for bullet lists, numbered lists and checklists.

| Key | What happens |
| --- | --- |
| **Enter** | Adds the next item. At the start of an item's text, it adds an empty item above. On an item with sub-items, the new item becomes its first sub-item. |
| **Enter** on an empty item | Moves the item one level out. On the top level, the list ends and you write normal text. A top-level item with sub-items stays. |
| **Backspace** at the start of an item | Moves the item one level out. On the top level, the item becomes normal text. A top-level item with sub-items stays. |
| **Tab** or **Ctrl/⌘+]** | Nests the item under the item above. Its sub-items move with it. |
| **Shift+Tab** or **Ctrl/⌘+[** | Moves the item one level out. |
| **Alt+Up/Down** | Moves the item with its sub-items past the item above or below. It stops at the list edge. |
| **Ctrl/⌘+Shift+7**, **8**, **9** | Changes the selected lines to a numbered list, a bullet list or a checklist. The depth stays. Press it again on a top-level item to get normal text. The keys are the number keys 7, 8 and 9 on every keyboard layout. |
| **Ctrl/⌘+Enter** | Checks or unchecks the task at the cursor, also from a later line of the task. |
| `- `, `1. ` or `[] ` at the start of a line | Starts a bullet list, a numbered list or a checklist. |

**Shift+Enter** starts a new line in the same item. **Backspace** directly after `# ` turns a heading into normal text.

:::reference
- **Text and code:** **Tab** inserts two spaces at the cursor or indents the selected lines. **Shift+Tab** removes up to two spaces of indentation. The note stores plain spaces.
- **Without Tab:** **Ctrl/⌘+]** and **Ctrl/⌘+[** work even when Tab moves focus. On a phone, use **Indent** and **Outdent** in the editor toolbar.
- **Move list items:** On a Mac, use **Option+Up/Down**. On Windows and Linux, **Ctrl+Shift+Up/Down** does the same. On a Mac, **⌘+Shift+Up/Down** keeps selecting to the start or end of the note. If your selection covers more than one item, the selected lines move instead.
- **Numbered lists:** When you add, remove, indent or move items, the list you changed is numbered again in the Markdown. It keeps its first number, also when you remove the first item. Other lists keep their numbers. One undo restores the change and its previous numbers.
- **Toolbar:** Bullet list, Numbered list, and Checklist are directly in the toolbar, also on phones.
- **Tables:** **Tab** selects the next cell, **Shift+Tab** the previous cell.
- **Suggestions:** If a suggestion list is open, **Tab** and **Enter** accept the highlighted suggestion.
- **Leave the editor:** Press **Esc**, then **Tab** to move to the next control. Press **Esc**, then **Shift+Tab** to move back.
- **Keep Tab for focus:** Open **Settings → Notebook → View & behavior** and turn on **Tab moves focus instead of indenting**. This browser stores the choice, and it applies immediately.
:::

## Find notes in the sidebar {icon="layout-sidebar"}

The sidebar shows the notebook's notes as a tree, with the homepage first. Filters turn it into a list.

:::reference
- **Notebook name:** Choose the name at the top to switch to another notebook or to open **All notebooks**.
- **Search and new notes:** Choose **Search notes**, or press **Cmd/Ctrl+Shift+K**. With **Edit** or **Manage** access, choose the pencil next to the name, or press **Cmd/Ctrl+Alt+N**, to create a note. The last word you type also matches the start of a word: *meet* finds *meetings*. Notes whose title is or starts with what you typed come first.
- **Favorites, Recent, and Tags:** These filters show a list instead of the tree, with the most recently changed note first. **Recent** shows the 12 most recently changed notes. Each note shows when it changed and its first two tags. Choose the filter again, or **×** above the list, to see the tree again.
- **The list stays in place:** While the list is open, changes from you or others do not move its notes. A note that starts to match the filter comes at the end. To sort the list again, choose the filter two times.
- **Your favorites:** In the menu of a note, choose **Add favorite**. Only you see your favorites.
- **Note menu:** Choose **⋯** next to a note, right-click the note, or select it and press **Shift+F10**.
- **The filter stays:** It stays when you open a note from the list and when you reload the page. When you open another note from a link in a note, from the search, or as a new note, the tree shows again.
- **Phones:** The menu offers the same filters and shows the list immediately. Open a note from the list to keep the filter. If you close the menu without opening a note, it shows what it showed before.
:::

## Hide the navigation {icon="layout-sidebar-left-collapse"}

Hide the navigation to focus on the note. Hide it also when others can see your screen and must not see your notes and folders.

:::reference
- **Hide:** Choose **Hide navigation** at the far left of the editor toolbar. You can also press **Cmd/Ctrl+Alt+S**, or type `>` in the Cloud search and run **Hide notebook navigation**. You can also drag the edge of the navigation almost all the way to the left.
- **What disappears:** The sidebar disappears completely, and so does the page list of Book view.
- **Show:** Choose **Show navigation** in the same place, or press **Cmd/Ctrl+Alt+S** again. You can also type `>` in the Cloud search and run **Show notebook navigation**.
- **No toolbar:** Some places show no editor toolbar: Book view, an empty notebook, **Read-only**, and the attachments. There, the button is in the bottom-left corner. The graph has the button at the left end of its own toolbar.
- **Stays hidden:** This browser stores the choice. It applies to every notebook, even after a reload and in other open tabs. A notebook with hidden navigation opens without it, so its note titles do not appear while the page loads.
- **Reading width:** On a large screen, the text stays in a column as wide as in Book view, also in the editor and in **Read-only**. When you hide the navigation, the column moves to the middle. The lines do not get longer.
- **Full width:** For longer lines, turn on **Full width** in the detail panel, or type `>` in the Cloud search and run **Turn on full width**. The text then fills the free space in the editor, in **Read-only**, and in Book view. Only you see it, and this browser stores the choice for every notebook and open tab. Full width works only on large screens, where the switch shows. When the navigation and the detail panel leave less room than the column, the lines get longer only after you close the panel.
- **Your place in the note:** When you hide or show the navigation, the cursor stays where it is. The text at the top of the editor or of Book view stays in place.
- **Phones and tablets:** On small screens, the navigation stays in the menu. On a tablet, the button at the top left opens the navigation over the note. When the navigation is hidden, the button in the bottom-left corner shows it again. On larger screens, the navigation is next to the note.
:::

## Arrange notes {icon="arrows-sort"}

On each level of the sidebar, notes are in title order until someone arranges them. With **Edit** or **Manage** access, you choose your own order, for example the chapters of a book. Everyone sees this order immediately in the sidebar and in Book.

:::reference
- **Drag:** On a computer, drag a note up or down among its neighbours. A line shows where it lands. Sub-notes move with their note, and the note stays on its level. To put a note under another note, use **Move** in the note menu.
- **Keyboard:** Select a note in the sidebar and press **Alt+Arrow Up** or **Alt+Arrow Down**.
- **Phones and menus:** Open the note menu and choose **Move up** or **Move down**.
- **One level at a time:** When you arrange a note, only the order of its level is fixed. Other levels stay in title order. New notes on an arranged level appear at the end. Notes that you move there from elsewhere also appear at the end.
- **Back to titles:** In the menu of a note with sub-notes, **Sort subnotes alphabetically** sets that level back to title order. For the top level, choose **Sort top level alphabetically** in the menu of any note on it.
- **Homepage:** The homepage stays first on its level. Other notes cannot move above it.
- **Sidebar sorting:** The order applies when the sidebar sorts by **Notebook order**. Sorting by **Last updated** or **Created** changes only your view and offers no arranging.
- **View access:** People with **View** access see the arranged order but cannot change it.
:::

## Type typographic symbols {icon="typography"}

When you read or edit a note, Notebooks shows some typed sequences as one symbol. The note keeps the characters that you typed. Search, export, and Assistant see them unchanged.

| You type | You see |
| --- | --- |
| `->` `<-` `<->` | → ← ↔ |
| `=>` `<=>` | ⇒ ⇔ |
| `<=` `>=` `!=` `+-` | ≤ ≥ ≠ ± |
| `(c)` `(r)` `(tm)` | © ® ™ |
| `...` | … |
| `--` with a space on both sides | – |

:::reference
- **See the characters:** Place the cursor on a symbol or select it to edit the typed characters. **Show Markdown source** always shows them. In Book, hover over a symbol.
- **Unchanged:** Code, math, links, HTML, data and query blocks, and front matter keep the typed characters.
- **Keep a sequence:** Type a backslash before its first character, for example `\->`.
:::

**Readable emphasis**

## Add callouts {icon="message-circle"}

Use callouts for context, decisions, warnings, and status that readers must see while they scan a note.

:::steps
1. On its own line, write `:::note`, `:::info`, `:::success`, `:::warning`, or `:::danger`.
2. Optional: Add a heading after the type, for example `:::warning Open risk`.
3. Write the text on the next lines.
4. Close the callout with `:::` on its own line.
:::

A callout shows a type icon and a light tint. The icon and title use the tone color; body text stays neutral. The editor, Book, and PDF export show the same box. Spaces descriptions, comments, and Help show it too.

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

Write a Mermaid diagram in a code block marked `mermaid`. The editor and Book show the rendered diagram. In the editor, choose the diagram to edit its source.

:::reference
- **Zoom:** Use the plus and minus buttons, or hold **Ctrl** or **Cmd** while you scroll. On a touch screen, pinch. Plain scrolling still scrolls the page.
- **Move:** When you have zoomed in, drag the diagram or use the arrow keys. The reset button shows the full diagram again.
- **Keyboard:** Focus the diagram. Press **+** and **-** to zoom, **0** to reset, and **F** to open it in fullscreen.
- **Fullscreen:** The fullscreen button opens the diagram in a large window with the same controls. Press **Esc** to close it.
- **Export:** In fullscreen, **Download SVG** saves a scalable file. **Download PNG** saves an image on the theme background. The file name is the note title.
:::

In the editor, the controls appear when you point at the diagram or focus it. After a reload, every diagram opens at its full size again.

**Organization**

## Connect notes with links, tags, and attachments {icon="link"}

:::reference
- **See how notes link:** Choose **Links** at the bottom of the navigation. **Network** shows every note of the notebook and the links between them. The open note has a ring in the app color. This also works with **View** access, in Book view.
- **Circle:** All notes stand on one circle, grouped by area in page order. The area name is inside the circle. Links cross the circle in the color of the area they start from. Point at a note to keep only its links visible. Solid lines go out. Dashed lines come in. When there are many notes, some titles appear only when you point at a note or zoom in.
- **Neighborhood:** The current note is in the middle. Notes it links to are on the right. Notes linking to it are on the left. The second step is on the outer ring. On a tall, narrow screen such as a phone, incoming links are above and outgoing links are below.
- **Timeline:** Notes are rows, with the last change first. Groups start with **Today**, **Yesterday**, **This week**, and **Last week**, then months and years. Links are arcs on the left, in the color of the area they start from. Point at a row or focus it to see its links. Incoming links are dashed. This display scrolls instead of zooming. It opens at the open note.
- **Depth:** Choose **1 step** or **2 steps** in **Neighborhood**.
- **Move to center:** Focus a note and press **Space**. On a touchscreen, select a note and choose **Move to center**. This note becomes the middle.
- **On a phone:** Links opens in **Neighborhood** unless you choose another display. Your choice stays in the address.
- **No links here:** Choose **Show whole notebook** to see **Network**. If filters hide all links of the current note, choose **Reset filters**.
- **Areas:** Each top-level page with sub-pages is an area with its own color. The other top-level pages are in **Top level**. The network does not move by itself. You can drag a note, and its neighbors follow a little.
- **Point at a note:** The note and its neighbors stay visible, and the other notes fade. Links from the note are solid lines. Links to the note are dashed. The bottom-left corner shows the area, the number of links in each direction, and the last change.
- **Filters and search:** Choose **All notes**, **Only linked**, or **Only unlinked**. Choose an area to hide or show it. **Find note** marks the notes with a matching title, and Enter goes to the first match. The address keeps these settings, so a reload or Back shows the same view.
- **As list:** Shows the same notes and filters as a table: the area, the notes that a note links to, the notes that link to it, and the last change. Choose **Changed** to sort by the last change, newest first. Choose it again for the oldest first. The address keeps the order.
- **Keyboard:** Press Tab to go into the graph. In **Network** and **Neighborhood**, the arrow keys move to the next note in that direction. Page Down and Page Up go through the notes in page order. In **Circle**, the arrow keys go along the circle. Page Down and Page Up jump to the next or previous area. In **Timeline**, Arrow Up and Arrow Down go to the next or previous row. Enter opens the note, Home goes to the open note, and Esc clears the search. In all displays except **Timeline**, + and − zoom and 0 fits the graph.
- **Touch screens:** In **Timeline**, choose a row to open the note. In the other displays, choose a note to select it. A bar at the bottom shows the note. Choose **Open** to open it. Pinch with two fingers to zoom.
- **Note links:** The Markdown form is `[Label](note://shortId)`. The editor can insert links for you.
- **Link to a heading:** Add the heading name in lowercase with hyphens. `[Label](note://shortId#backup-restore)` opens the heading "Backup & Restore". If the note has no such heading, it opens at the top.
- **Tags:** Use tags such as #garden to group notes across the notebook. Tag filters match parsed tags, not any word.
- **Attachments:** Images appear inline. Other files appear as links. Both use attach://shortId references. Add `=400x`, `=x300`, or `=400x300` after the address to set an image's size.
- **How links look:** Links to notes, headings, and files are light gray labels with a colored type icon. PDFs are red, images violet, design files orange, notes blue-gray, and headings gray.
- **Heading in another note:** The link shows that note first, as in "Color system › Accent color".
- **File on its own line:** The link also shows the file size.
- **Websites and email addresses:** These links stay part of the text with a thin underline. Website links end in a small ↗.
- **Where links look this way:** Book view and PDF exports show links this way. The editor uses the same look with three differences. It shows only the link text for a heading, takes the file type from the link text, and shows no file sizes.
- **Open an attachment:** Select an image to see it in fullscreen. Select a PDF, Markdown, text, JSON, or CSV file to open its preview.
- **Preview actions:** The preview has **Download**. PDFs add **Open in new tab**, and text and JSON files add **Copy**.
- **Other files:** Notebooks downloads other files, such as archives, audio, and video, after you confirm. The same applies to very large files and to images that the note cannot display.
- **Where this works:** You can open attachments in the editor, in Book view, in the details panel, and in the attachments view.
- **All notebook files:** Open **Attachments** at the bottom of the notebook sidebar to list and search all files in the notebook.
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
