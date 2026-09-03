---
title: Notebooks
navTitle: Notebooks
section: Work
order: 120
description: Markdown handbooks and collaborative notebooks with structured blocks, discussions, links, and files.
tags: [notebooks, markdown, collaboration]
updated: 2026-09-04
---

# Notebooks

Notebooks brings company handbooks, wikis, and working notes into one
permission-scoped workspace. Notes use Markdown and can link to other notes,
tags, and uploaded files. Editors work together in real time; readers see a
dedicated Book view.

The Notebooks start page keeps accessible notebooks at the top, shows recently
edited notes across those notebooks, and provides one permission-aware activity
stream. Pin notebooks to keep them first, or use the shared search prompt to
open an accessible notebook or note directly. Activity stays beside the
overview on larger screens and opens as a separate panel on mobile so it does
not replace the note list.

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

Executable scripting is no longer supported. Existing script fences stay in
the Markdown as readable code and do not run in any view. Replace page indexes
with queries and heading lists with contents blocks. Script buttons, write
actions, and hidden runtime state have no replacement.

## How Notebooks fits Cloud

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

Notebooks provides a native CLI module for notes, discussions, search,
attachments, access, exports, and snapshots. Start with read commands:

```bash
cld notebooks list --json
cld notebooks search --all --query "launch plan" --json
cld notebooks comments --notebook abc123 --note def456 --json
```

Run `cld notebooks help` for the available resources. Run
`cld notebooks <command> --help` before editing content, changing access, or
running a snapshot.
