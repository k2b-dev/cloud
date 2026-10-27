---
title: Notebooks
navTitle: Notebooks
section: Work
order: 120
description: Markdown handbooks and collaborative notebooks with structured blocks, discussions, links, and files.
tags: [notebooks, markdown, collaboration]
updated: 2026-10-27
---

# Notebooks

Notebooks brings company handbooks, wikis, and working notes into one
permission-scoped workspace. Notes use Markdown and can link to other notes,
tags, and uploaded files. Editors work together in real time; readers see a
dedicated Book view. A note opens with its saved text and connects for
real-time editing on the first change, so reading and moving between notes
costs no collaboration connection.

Book keeps the normal Cloud navigation around its page tree and reading area,
including on tag pages. It still requires sign-in and notebook access; choosing
Book does not publish a notebook anonymously.

The Notebooks overview lists your notebooks in a sidebar with their note
count and last edit; opening one enters its workspace. The page itself shows recently edited notes across all notebooks,
one create action, and one permission-aware activity stream. Pin notebooks to
keep them first, or use the shared search prompt to open an accessible
notebook or note directly. Activity stays beside the overview on larger
screens and opens as a separate panel on mobile so it does not replace the
note list.

Open the notebook name in the sidebar or phone menu to switch notebooks.
Signed-in users can choose **New notebook** to create and open a blank notebook,
including from Book view. Use the overview to start from a template.

`notebook.activity` reads recorded changes for a `notebook` short ID,
optionally one `item` (note short ID). Each edit bucket remains one row, with
an actor, icon, localized sentence, last occurrence time, resource ref, and
count. Each new passage comment (`annotation.create`) adds one separate row,
with count 1 and an optional `href` to its `notebooks.annotation` reader. The
reader opens the note with `?annotation=<id>`. Replies, comment edits,
resolution and acceptance add no comment rows. Deleted comments, deleted notes,
and notes the caller cannot read are omitted. Comments remain available when
Chat is unavailable; the Chat row is only a projection. Follow `page.nextCursor` with
`cursor`; `before` and `after` are exclusive ISO datetime bounds. `limit`
defaults to 50 and accepts 1–100. See [Chat system conversations](/en/docs/operations/chat-system-chats#read-item-events)
for the shared event contract.

## Use Notebooks

- Capture project notes, decisions, research, meeting records, recipes, or
  lightweight task lists.
- Organize notes in a tree and connect related knowledge with note links and
  tags. Each level reads by title until a writer arranges it by hand, by
  dragging in the sidebar, with Alt+ArrowUp or Alt+ArrowDown, or with **Move
  up** and **Move down** in the note menu; the sidebar, Book, and export follow
  that order for everyone, and the folder menu sorts a level alphabetically
  again. Notebooks with thousands of notes open as fast as small ones: the
  sidebar loads a level when it opens, shows 20 notes around the open one,
  and loads up to 100 more on request.
- Publish an internal handbook in Book view, with page navigation and tag
  filters but no editing controls or detail panel.
- Discuss a page in a durable Markdown thread. New comments appear live for
  other users viewing its detail panel, and comment authors can correct or
  remove their own comment for ten minutes.
- Keep small tables, lists, todos, data blocks, charts, and sections beside the prose
  that explains them.
- Attach images and files to the notebook and reference them from notes. Drop
  or paste them into the editor, or choose them with the paperclip from this
  device or, when Cloud apps offer files, from one of them, such as Files.
- Open **Edit with AI** from a writable note's detail panel to start an
  Assistant chat with the current page and its discussion. Notebooks reviews
  and authorizes every proposed page change before it is applied.
- Download the current note as Markdown or as an A4 PDF using the Document,
  Report, Compact, or Custom print style. PDF generation uses the current live
  editor content and does not store a generated copy. In the PDF, links to the
  note itself jump within the document: to the linked heading, or to the top
  when the note has no such heading. Links to other notes, their headings, tags,
  and attachments open in Cloud at the installation's public address. Opening
  them still requires sign-in and notebook access. After the download, the
  dialog lists what the PDF left out, with a reason and what to do. The PDF marks each item in
  place. Attached JPEG, PNG, WebP and GIF images appear at the size Book shows
  them. Images share the administrator's **Max input bytes** budget; large
  images print at 300, 200 or 150 dpi. Preparing images gets the same time as
  the renderer's **Timeout** setting, at most 115 seconds. SVG attachments stay
  available as downloads. External images print when the server can reach them
  at a public HTTPS address without a redirect.
  Anything left out shows **Image not included: …** in the PDF and is listed in
  the dialog.
- Add filtered page lists with `:::query` and page contents with `:::toc`, using
  your own named data instead of a fixed metadata schema.
- See how notes link in **Links**. A notebook with more than 500 notes shows
  the notes around the open note there, and says so above the graph.

Use a separate notebook when content needs its own access rules, settings, or
export boundary.

## Choose a reading or writing view

Users with read permission always use **Book**. It shows the note as a web page
with navigation and tag filters, without an editor, detail panel, or discussion
panel. Query blocks (`:::query`), tables of contents (`:::toc`), and charts (`:::chart`) are rendered
on the server with the page.

Page links, tag filters, search, and pagination update the Book content without
reloading the whole page when JavaScript is available. Browser Back and Forward
preserve the reading route. Saved changes refresh the current page, navigation,
and query results automatically. A query that matches more notes than one
page shows 20 at a time, with page buttons below it; the address keeps the
page, so a reload or a saved change shows the same rows. Without JavaScript,
links and filters still work through regular page loads, and a query shows its
first page. Switching to Write or Read-only loads that
workspace as a new page.

In the editor, type `:::` to insert a query, table of contents, or chart. Rich mode shows
a server-rendered preview; move the cursor into the block or choose **Show
source** to edit it. Invalid settings are marked at their source lines. Previewing
a draft does not save it or change the notes returned by the query.

Rich mode indents list items by their Markdown nesting. Numbered lists count
from their starting number. Nested numbered lists show a., b., then i., ii.,
then decimal numbers again in the editor, Book view, and PDF.

On wide screens, **Full width** lets text use the available space instead of
the centered reading column in Write, Read-only, and Book. Toggle it in a
note's detail panel under **View**, in **Settings → Notebook → View & behavior →
Only for you**, or through **Turn on full width** / **Turn off full width** in
Cloud search. The choice applies to every notebook and open tab in this browser and
survives reloads. Full width works only on large screens, where these controls
show. When the navigation and the detail panel leave less room than the
reading column, the lines get longer only after you close the panel.

The editor toolbar shows the current text style in its style menu and marks active
bold, italic, strikethrough, highlight, and list formats as pressed. Bullet,
numbered, and checklist buttons are directly available, beside Outdent and
Indent. Link, note link, and attachment controls sit beside **More**, which
inserts callouts, tables, code blocks, and inline code. Touch devices show
**Undo** and **Redo** at the start of the toolbar.

**Ctrl/⌘+Shift+1/2/3** toggles H1/H2/H3, matching the shared Markdown editor;
pressing the same heading shortcut again restores normal text. These shortcuts
match physical digit keys on every keyboard layout; macOS keeps ⌘+Shift+3 for
screenshots, so Mac users pick H3 in the style menu. **Ctrl/⌘+Shift+H** now
toggles highlight (`==text==`); it previously cycled heading levels.

Every toolbar action and formatting shortcut is a separate undo step, as is
every Enter. Typing before and after these actions stays in separate steps;
undoing your edit preserves other people's concurrent text.

In the editor, Tab indents: it nests list items together with their sub-items,
moves between table cells, accepts an open suggestion, and otherwise inserts two
spaces. Press Esc, then Tab to move focus out of the editor. Each person can
keep Tab for focus movement under **Settings → Notebook → View & behavior**; the
choice is stored in that browser. **Ctrl/⌘+]** and **Ctrl/⌘+[** nest and lift list
items even with that preference; **Indent** and **Outdent** in the editor toolbar
provide the same controls on phones. **Alt+Up/Down** (Option on a Mac) moves an
item with its sub-items within its list and stops at the edge; Windows and Linux
also accept **Ctrl+Shift+Up/Down**, while ⌘+Shift+Up/Down on a Mac keeps
selecting to the start or end of the note. A selection across several items
moves those lines instead. After your own structural change, the numbered list
you changed gets its Markdown numbers repaired, keeping its first number, in the
same undo step; other lists keep theirs.

Enter continues a list; on an empty item it lifts one level or ends the list.
At an item's text start, Enter inserts an empty item above. Splitting an item
with children adds a new first child and keeps the existing children under it.
Backspace at an item's start lifts it or turns a top-level item without children
into normal text. Empty top-level items with children stay in place.
**Ctrl/⌘+Shift+7/8/9** changes selected lines to numbered lists, bullet lists,
or checklists. The editor matches the physical digit keys, so the shortcuts work
on every keyboard layout. Repeat to turn top-level items without children into
normal text; their continuation lines lose the item indentation. **Ctrl/⌘+Enter**
checks or unchecks the task under the cursor, also from its continuation lines.
Type `[] ` at a line start to begin a checklist. Backspace after `# ` turns a
heading into normal text, also inside quotes and list items.

Mermaid diagrams enhance their server-rendered source in the browser. Without
JavaScript, or if a diagram cannot render, its source stays readable. On mobile,
expand the compact navigation to browse pages and tags.

Editors and notebook admins can switch between **Write**, **Read-only**, and
**Book**. Write edits the note; Read-only keeps the familiar workspace and
detail panel without allowing changes to the note body. Use either workspace
view to read or contribute to page discussions.

Notebook admins choose **Default view** under **Settings → Notebook → View &
behavior**. The initial default for editors and admins is Write. An explicit
view in the page URL overrides this default; read permission still forces
Book. Locked notes open in Read-only instead of Write.

## Use the note side panel

In Write and Read-only, the panel header shows the last editor and edit time
on one line, with locked, read-only, or offline state when applicable. The
avatar stack opens **Here now** with the people present and their current
sections; select a person to scroll to their cursor.

The action row contains **Edit with AI** and **View**. View offers **Open as**
(Edit, Read, Book), **Text** (Formatted, Markdown), and **Full width**. The
**⋯** menu contains Copy content, Download as Markdown, Export as PDF,
Version history, Show in graph, and Duplicate, subject to the note's permissions.

Sections appear in this order: Comments, Tasks, Contents (from two headings),
References, Attachments, Linked from, and Activity. Activity uses translated
sentences and ends with who created the note. Hover or focus a timestamp for
its exact date; use the versions link to open saved history.

## Reserve deleting and locking notes for admins

By default, everyone with write access can delete notes and lock them
permanently. Neither can be undone. A notebook admin can set **Who can delete
and lock notes** to **Admins only** under **Settings → Sharing → Access**; the
change saves immediately. People and agents with write access keep editing,
including removing content, and saved versions keep earlier content
recoverable. Their **Delete** and **Lock note** actions stay visible but
disabled with the reason. A locked note keeps its saved versions readable but
can no longer be edited or restored from them.

The API carries the rule as the notebook's `noteDeletePermission` (`write` or
`admin`); the one setting covers both actions. Only notebook admins change it
with `PATCH /api/notebooks/:id` or
`cld notebooks update <notebook> --note-delete-permission admin`. Under
`admin`, everyone else, including agents and API keys with write access, gets
403: `DELETE /api/notebooks/:id/notes/:noteId` with code
`NOTE_DELETE_ADMIN_ONLY`, and `POST /api/notebooks/:id/notes/:noteId/lock`
with code `NOTE_LOCK_ADMIN_ONLY`. `cld notebooks rm` and `cld notebooks lock`
fail with the same messages.

## Understand the Notebooks model

| Resource | Responsibility |
| --- | --- |
| Notebook | Permission-scoped workspace with notes, files, settings, and exports |
| Note and note tree | Markdown document and its place in the notebook hierarchy |
| Comment | Durable Markdown discussion attached to one note |
| Link and tag | Connections and searchable labels parsed from note content |
| Attachment | Notebook-owned file referenced from Markdown |
| Named data and query | User-defined Markdown properties and filtered lists of notes in this notebook |
| Chart | A chart from this note's data, with values, a table view, and spreadsheet copy; PDF includes its data table |
| Activity | Durable, permission-aware semantic changes across a notebook or note |
| Saved version | Recoverable note snapshot with the set of contributors represented by that version |

Named data remains visible Markdown rather than a hidden database. Queries read
saved notes; they cannot write changes or access another notebook.

Realtime typing does not create one history row per keystroke. Notebooks groups
collaborative edits by actor, note, and hour. Saved versions remain separate
recovery snapshots and can reference every user or service account whose edits
contributed since the preceding saved version.

Comments follow the parent notebook's permissions, but Book does not display
the discussion panel. Users with write access can add comments in the detail
panel, including on a locked note. Locking freezes the note body, not its
discussion. Comment authors may edit or delete their own comment for ten
minutes after posting.

## Show data as a chart

A chart reads only this note's data, including evaluated table formulas.
Point at or tap a chart value to see its series, x label, and formatted value.
You can also focus the chart and use the arrow keys to read each value.
Press Escape to close the tooltip.

**Show as table** shows the values as a table in the same place.
**Copy data** copies the values as tab-separated text for a spreadsheet.
These controls work in Book, Read-only, the editor's Rich-mode preview,
and version history. PDF export keeps the chart and its data table.

```text
@sales
| Date | Revenue | Costs |
| --- | --- | --- |
| 2026-01-01 | 1200 | 600 |
| 2026-02-01 | 1400 | 700 |

:::chart
type: area
title: Sales 2026
data: @sales
x: Date
y: [Revenue, Costs]
tooltip:
  label: Amount
  format: EUR
:::
```

Choose `line`, `area`, `bar`, `pie`, `donut`, `scatter`, or `stat`. Line, area, and scatter need numeric or ISO-date x values. Bar uses one value column. You can also reference a named list or data block, or write inline `columns` and `rows`. A note allows 20 charts, each data list at most 480 values, and a chart at most 8 series. Invalid blocks keep their source with a diagnostic.

## Build a handbook index

Define your own fields beside the page text. A name directly above a data block
makes its properties available to queries:

```text
@profile
:::data
owner: Ada
status: active
reviewDays: 30
approved: true
teams:
  - operations
  - support
:::
```

Data values are strings, numbers, booleans, or flat lists. Use unique block
names and keys; nested objects and inline arrays are not supported. Quote
numeric-looking text when it must remain a string. Dates remain strings.
Invalid or duplicate named data is excluded from queries and reported.

A hub page can list the active handbook pages without maintaining links by hand:

```text
:::query
source: notes
scope: notebook
match: all
where:
  - field: $tags
    op: contains-all
    value: [handbook]
  - field: profile.status
    op: eq
    value: active
sort:
  field: $updated
  direction: desc
columns:
  - $title
  - profile.owner
limit: 25
:::
```

Queries support the current notebook, direct children, or all descendants of
the current page. Combine filters with `match: all` or `match: any`. Use
equality, membership, text matching, numeric comparisons, or existence checks
on your data. Tags support `contains`, `contains-any`, and `contains-all`.
Field names and equality are case-sensitive; text contains/prefix filters and
tags ignore case. Negative comparisons do not match missing fields.

Sort by `$title`, `$created`, or `$updated`, ascending or descending. The
default is most recently updated first. In Book and the editor, `limit` (1 to
100, default 25) sets the rows per page, at most 20, and page buttons reach
every match. The CLI, capabilities and PDFs return the first `limit` matches
and say how many more match. Queries do not aggregate table
rows, join datasets, evaluate expressions, or modify notes. Open **Help →
Structured blocks** for the complete operator and limit reference.

For the headings on one page, insert:

```text
:::toc
min-depth: 2
max-depth: 3
:::
```

This includes matching headings before and after the block. Omit the depth
settings to include levels 1–6. Book and rich editor previews use the same
server-rendered results. Read-only keeps its saved note source until a reload;
reload after the source changes to see the matching preview.

Code fences are displayed as text and never executed. Use `:::query` for page
indexes and `:::toc` for heading lists.

## How Notebooks fits Cloud

Assistants can choose a writable notebook with `notebook.browse`, then browse
its roots or a selected page's children with `note.children`. Use `note.search`
to find a known page directly. Neither path needs the whole notebook tree.
`comment.browse` selects discussion previews; `comment.read` supplies full text.
The detailed lists and readers remain available.

Capability pages may be shorter than requested to fit the transport budget.
Follow `page.nextCursor`; a short page is not necessarily the last page.
`note.tree` returns at most 100 entries per response, even for larger requests.

`note.read` returns source windows and a hash for the complete document.
`contentComplete` is true only for the entire source starting at offset zero.
Follow `nextContentOffset` and check that `contentHash` stays unchanged before
joining windows. Never use a partial window as a whole-note replacement;
prefer structural edits with `ifContentHash`. `note.edit` accepts
`blockLimit: 0` for a compact receipt that still includes before/after hashes.

Assistant can check query and TOC drafts with `notebooks.note.preview` before
saving them. This returns compact diagnostics through the same server preview
as the editor, without saving a draft or returning HTML. Saved previews need
read access; drafts need write access and an unlocked note. A user-backed
identity is required. The check does not validate every Markdown feature or
table formula, and queries still use saved data.

Assistant can also read, create, edit, and delete page comments. Editing and
deleting require the original author, write access, and the same ten-minute
window as the app. Both changes have explicit reviews and recheck those rules
when applied. The built-in `cloud-notebooks` Skill describes these workflows
and the supported data, query, TOC, and table syntax.

Notebooks owns notes, hierarchy, attachments, realtime document state, search,
exports, and snapshots. Cloud supplies identity, resource access,
resource-bound API keys, settings, background schedules, dashboard widgets,
application discovery, and the shared Help surface.

### Automate passage comments

`notebooks.annotation` identifies an inline comment thread owned by Notebooks.
`annotation.list` and `annotation.read` return anchored source offsets, quoted
text, status, replies, current author permissions, and `headingPath`.
`annotation.replies` continues a thread's `repliesNextCursor`. Lists default
to every non-deleted thread. Filter by exact `state`
(`open|resolved|accepted|all`) and root `author` (user/service-account UUID or
`me`, the authenticated actor) before paging. Follow `nextCursor`
(or the capability envelope's `page.nextCursor`); pages contain at most 30
roots or replies and may be shorter to fit the response budget.

Use `annotation.create`, `annotation.reply`, `annotation.edit`,
`annotation.delete`, `annotation.restore`, and `annotation.resolve`
(`resolved: false` reopens) with write access. Agents and service accounts use
the same grants as people. Editing, deleting, and restoring require the author
and the original ten-minute window; a root with replies cannot be deleted.
Create and reply require `Idempotency-Key`; changing the payload under a used
key returns 409. `via` comes from the platform's Assistant or MCP origin and
cannot be supplied by the caller. `stateVia` and `suggestionStateVia` preserve
that origin for thread and suggestion status changes.

`annotation.accept` and `annotation.undo-accept` require an unlocked note and
a caller-stable `operationId` UUID. Retry that ID after an uncertain result.
Replies may carry a replacement suggestion, including on somebody else's
thread. A body or a suggestion that changes the current passage is required.
Root and reply suggestions expose `suggestionState` (`open|accepted|rejected`,
null without a suggestion), `suggestionStateBy` (Person or null),
`suggestionStateAt` (ISO time or null), and `suggestionStateVia`
(`assistant|mcp|null`). `Person` has `kind`, `id`, `name`, and optional
`avatarHash`. Accept chooses `replyId`, or the root by default, and requires
both an open thread and an open suggestion. It accepts that suggestion and the
thread; other suggestions retain their status. Undo reopens the accepted
suggestion and the thread. `annotation.reject` selects the same target and
sets it to `rejected`, or reopens it with `rejected: false`, without changing
text or thread state. Any writer may reject; repeating the same request is safe.

Agents should list the person's open threads, read the passages in context,
and propose suggestions as replies. They must never accept their own suggestions
unless the person explicitly asks them to.

Accept compares the live passage against `expectedText` (the quote by default);
undo compares the accepted text before restoring only that range. A conflict
returns 409 with `details.currentText` and `details.operationId`. Conflict text
is capped at 2,000 UTF-16 characters; longer passages also return
`details.currentTextTruncated: true` and `details.currentTextLength`. Select a
smaller passage to make a new suggestion.

REST uses `/api/notebooks/notes/:noteId/annotations`; GET its list with
`?state=open&author=me`, and POST `/:annotationId/accept` with
`{ operationId, expectedText?, replyId? }` or `/:annotationId/reject` with
`{ replyId?, rejected? }` (default true). Read a thread without the note ID at
`GET /api/notebooks/annotations/:annotationId`. Its list returns
`{ text, contentHash, cursor, restoreRevision, items, nextCursor }`; offsets
refer to exactly that Markdown snapshot. Capability lists omit `text`; compare
`contentHash` with `note.read` before using the offsets. A deleted passage
remains an orphan unless its exact surrounding context can be recovered
unambiguously nearby. Quotes and suggestions allow 2,000 UTF-16 characters,
context 32 on each side, and comment/reply text 5,000.

Create accepts 1-based `occurrence` among exact quotes, alongside context and
`offsetHint`. Missing/out-of-range quotes return HTTP 409
`ANNOTATION_PASSAGE_NOT_FOUND`; ambiguous quotes return
`ANNOTATION_PASSAGE_AMBIGUOUS`, both with `details.matches`.

The CLI offers `cld notebooks annotations list|show|add|reply|edit|delete|restore|resolve|reopen|accept|reject|undo`.
`list` accepts `--state` and `--author`; `show <thread-id>` follows replies within
the response budget and retains a continuation for larger threads. `reply` can
use `--suggestion` or `--suggestion-from <file|->`; `accept` and `reject` select
reply suggestions with `--reply`.
Run `cld notebooks annotations --help` for flags and use the bundled
`annotations.md` CLI reference for retry IDs and reply pagination. Creating a comment records an
`annotation.create` activity row; replies do not create activity rows.

## Find detailed product help

Open **Help** inside Notebooks for writing, organization, structured blocks,
formulas, queries, access, exports, and troubleshooting. Developers can read
[Resource authorization](/en/docs/identity/authorization),
[Realtime UI](/en/docs/frontend/realtime-ui), and
[Application settings](/en/docs/platform/settings) for the shared contracts
Notebooks adopts.

## Automate Notebooks from the terminal

The `cld notebooks` CLI reads and writes notes, and keeps a notebook as a
local folder of Markdown files. A command that takes a note accepts exactly
three address forms:

1. a **note ID** such as `ns98Kq`, unique across notebooks and stable across
   renames and moves;
2. **`<notebook>:<path>`** such as `"Kolb Antik Doku":betrieb/backup`, where the
   notebook is an ID or exact name and each path segment is the slug of a
   child note's title;
3. a **file inside a pulled mirror**, such as `~/docs-mirror/betrieb/backup.md`,
   resolved through the mirror manifest.

A slug is the lowercase title with `ä ö ü ß` written as `ae oe ue ss`, other
accents dropped, and every other run of characters joined into one `-`.
Titles and notebook names are not unique: when a name or path segment matches
several notes, the command fails and lists every candidate with its path and
ID instead of guessing.

```bash
cld notebooks ls
cld notebooks cat "Kolb Antik Doku":betrieb/backup --json
cld notebooks write "Kolb Antik Doku":betrieb/restore --from restore.md --parents
cld notebooks pull "Kolb Antik Doku" ~/docs-mirror
```

`write` replaces a note or creates it when the path does not exist yet; the
title always comes from the first `# Heading`. `pull` downloads a notebook into
a folder: a note without children is `<slug>.md`, a note with children is a
folder with `index.md` for its own content, and attachments are stored in
`_attachments/`. Links to attachments and to notes in the mirror become
relative file paths that editors and `rg` can follow; links to notes outside
the mirror stay `note://` links. A link to a heading keeps its anchor in both
forms, as in `note://Ab12Cd#backup-restore` and `backup.md#backup-restore`.
The anchor is the heading text in lowercase with hyphens, so this link opens
the heading "Backup & Restore" in Book and in the editor; a heading the note
does not have opens the note at its top. When headings repeat, the second
one is `#backup-restore-2`, the third `#backup-restore-3`, and so on. Leave
out the `heading-` that Book's address shows. When siblings share a title,
their file names carry the note ID, as in `backup--Ab12Cd.md`; this suffix
exists only in the mirror. Each file starts with `id`, `title`, and
`updatedAt` front matter, and `.cld-notebook.json` records one `path`,
`contentHash`, `fileHash`, and `updatedAt` per note.

The note list's `q` filter matches substrings in titles and words in saved
page content. A final plain word of at least two characters also matches the
start of a word: `backu` finds `backup`. A fragment from the middle of a body
word does not match.

`mv` also arranges a note among its siblings with `--before <note>`,
`--after <note>`, `--first`, or `--last`, as in
`cld notebooks mv "Docs":guide/setup --after "Docs":guide/intro`. Placing a
note fixes the order of its level by hand; other levels keep their title order.

Changes go back through `write`, `edit`, `mv`, and `rm`, which accept mirror
files and update the mirror immediately. Writing a mirror file, or editing
through one, turns relative links to files in the mirror, written the way pull
writes them, back into `note://` and `attach://` links, including links you
typed yourself; a `--from` file inside a mirror is read from its own location.
Writes through a mirror file are rejected with 409 when the note changed on the
server since the last pull. `pull` downloads only changed notes, follows
renames, moves, and deletions, and updates links in files whose linked notes
moved. It never discards local changes: it lists such files and exits 1 unless
`--force` is given. In those files it only updates links to follow the notes
they name, so the files can still be written back.

Run `cld notebooks help` for the full command set and
`cld notebooks <command> --help` before editing content, changing access, or
running a snapshot. The Cloud CLI agent skill describes the Markdown mirror
workflow, including moving a Git documentation folder into a notebook.

## Deployment requirements

`PUT /api/notebooks/admin/settings/:key` accepts `replaceUnreadable: true` alongside `value` to explicitly replace an unreadable saved setting, including `notebooks.snapshot_cron`.

Notebooks serves its math stylesheet and WOFF2 fonts below
`/public/notebooks/katex-<version>/`. The app's development and production
asset hooks copy these files together. Book and editor pages load the
stylesheet; the overview does not need it.

If retained editing history is missing or damaged, Notebooks preserves the
available changes and the previous saved version. The editor and Book view show
an incomplete-history warning. Contact your administrator and compare the
preserved version or backups before relying on the recovered content. Downloads
and copied note content retain the warning. Ordinary editing does not clear it.

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.

## Actions in Cloud search

Use **New note** in Cloud search to choose a writable notebook and create a note. Within a notebook, the action uses that notebook directly. The current note also exposes AI editing when writable and Markdown/PDF export. **Cmd/Ctrl+Alt+N** creates a note and **Cmd/Ctrl+Shift+K** searches the notebook.

Available keyboard shortcuts appear next to actions and in Layout Help.

Cmd/Ctrl+Shift+K searches titles and content in the current notebook. Cmd/Ctrl+Alt+N creates a note there when you can write. Selected-note actions offer Markdown and PDF export and, when available, editing with Assistant. Note titles continue to come from their content. Search actions update the open palette in place. Actions for the selected object appear before page actions.

## Image upload privacy

New JPEG, PNG, and WebP image uploads remove location and device metadata
without changing image quality. JPEG orientation, colour profiles,
transparency, and supported animation data remain. Malformed containers are
rejected with HTTP 422. This applies to notebook attachments.

Files keeps originals. HEIC, AVIF, TIFF, SVG, video, GIF, BMP, and unknown
formats remain unchanged and can retain metadata. Previously uploaded images
are not rewritten. See [Image upload privacy](/en/docs/platform/image-upload-privacy)
for the supported formats and limits.

## Operate S3 snapshots

Notebook S3 snapshots upload only to public storage by default. For internal
S3-compatible storage, set `NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS` in the Notebooks
container environment. Use the narrowest entry: an exact host name, a single
IP address, or the smallest required CIDR range. Each entry covers every port
and path on the host or range. `/0` and other invalid entries stop Notebooks
at startup. Failed or empty lookups still refuse uploads.

A refused target returns `NOTEBOOK_SNAPSHOT_TARGET_BLOCKED` (HTTP 400) with:
"This S3 endpoint is on an internal network. Notebook snapshots go only to
public storage unless an operator allows this target." Existing configurations
and credentials stay stored; uploads fail with this reason until the operator
allows the target. A notebook admin can always turn snapshots off.
