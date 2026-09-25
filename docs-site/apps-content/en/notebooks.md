---
title: Notebooks
navTitle: Notebooks
section: Work
order: 120
description: Markdown handbooks and collaborative notebooks with structured blocks, discussions, links, and files.
tags: [notebooks, markdown, collaboration]
updated: 2026-09-25
---

# Notebooks

Notebooks brings company handbooks, wikis, and working notes into one
permission-scoped workspace. Notes use Markdown and can link to other notes,
tags, and uploaded files. Editors work together in real time; readers see a
dedicated Book view.

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

## Use Notebooks

- Capture project notes, decisions, research, meeting records, recipes, or
  lightweight task lists.
- Organize notes in a tree and connect related knowledge with note links and
  tags.
- Publish an internal handbook in Book view, with page navigation and tag
  filters but no editing controls or detail panel.
- Discuss a page in a durable Markdown thread. New comments appear live for
  other users viewing its detail panel, and comment authors can correct or
  remove their own comment for ten minutes.
- Keep small tables, lists, todos, data blocks, and sections beside the prose
  that explains them.
- Attach images and files to the notebook and reference them from notes.
- Open **Edit with AI** from a writable note's detail panel to start an
  Assistant chat with the current page and its discussion. Notebooks reviews
  and authorizes every proposed page change before it is applied.
- Download the current note as Markdown or as an A4 PDF using the Document,
  Report, Compact, or Custom print style. PDF generation uses the current live
  editor content and does not store a generated copy.
- Add filtered page lists with `:::query` and page contents with `:::toc`, using
  your own named data instead of a fixed metadata schema.

Use a separate notebook when content needs its own access rules, settings, or
export boundary.

## Choose a reading or writing view

Users with read permission always use **Book**. It shows the note as a web page
with navigation and tag filters, without an editor, detail panel, or discussion
panel. Query blocks (`:::query`) and tables of contents (`:::toc`) are rendered
on the server with the page.

Page links, tag filters, search, and pagination update the Book content without
reloading the whole page when JavaScript is available. Browser Back and Forward
preserve the reading route. Saved changes refresh the current page, navigation,
and query results automatically. Without JavaScript, links and filters still
work through regular page loads. Switching to Write or Read-only loads that
workspace as a new page.

In the editor, type `:::` to insert a query or table of contents. Rich mode shows
a server-rendered preview; move the cursor into the block or choose **Show
source** to edit it. Invalid settings are marked at their source lines. Previewing
a draft does not save it or change the notes returned by the query.

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

## Understand the Notebooks model

| Resource | Responsibility |
| --- | --- |
| Notebook | Permission-scoped workspace with notes, files, settings, and exports |
| Note and note tree | Markdown document and its place in the notebook hierarchy |
| Comment | Durable Markdown discussion attached to one note |
| Link and tag | Connections and searchable labels parsed from note content |
| Attachment | Notebook-owned file referenced from Markdown |
| Named data and query | User-defined Markdown properties and filtered lists of notes in this notebook |
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
default is most recently updated first, up to 25 results; set `limit` from 1
to 100. A notice identifies additional matches. Queries do not aggregate table
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
title always comes from the first `# Heading`. `pull` mirrors a notebook
one-way: a note without children is `<slug>.md`, a note with children is a
folder with `index.md` for its own content, and attachments are stored in
`_attachments/` with relative links. When siblings share a title, their file
names carry the note ID, as in `backup--Ab12Cd.md`; this suffix exists only in
the mirror. Each file starts with `id`, `title`, and `updatedAt` front matter,
and `.cld-notebook.json` records one `path`, `contentHash`, and `updatedAt`
per note.

Changes go back through `write`, `edit`, `mv`, and `rm`, which update the
mirror immediately. Writes through a mirror file are rejected with 409 when the
note changed on the server since the last pull. `pull` downloads only changed
notes, follows renames, moves, and deletions, and never overwrites a file with
local changes: it lists such files and exits 1 unless `--force` is given.

Run `cld notebooks help` for the full command set and
`cld notebooks <command> --help` before editing content, changing access, or
running a snapshot. The Cloud CLI agent skill describes the Markdown mirror
workflow, including moving a Git documentation folder into a notebook.

## Deployment requirements

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
