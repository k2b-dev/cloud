---
title: Notebooks
navTitle: Notebooks
section: Work
order: 120
description: Collaborative Markdown notebooks with discussions, structured blocks, links, files, and small tools.
tags: [notebooks, markdown, collaboration]
updated: 2026-08-30
---

# Notebooks

Notebooks keeps prose, lightweight structured data, and small interactive tools
in one shared workspace. Notes use Markdown, synchronize in realtime, and can
link to other notes, tags, and uploaded files. Page discussions keep questions,
feedback, and decisions beside the note without mixing them into its body.

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
- Discuss a page in a durable Markdown thread. New comments appear live for
  other readers, and authors can correct or remove their own comment for ten
  minutes.
- Keep small tables, lists, todos, data blocks, and sections beside the prose
  that explains them.
- Attach images and files to the notebook and reference them from notes.
- Download the current note as Markdown or as an A4 PDF using the Document,
  Report, Compact, or Custom print style. PDF generation uses the current live
  editor content and does not store a generated copy.
- Enable trusted scripts when a notebook needs summaries, dashboards, charts,
  prompts, or buttons over its own data.

Use a separate notebook when content needs its own access rules, settings, or
export boundary.

## Understand the Notebooks model

| Resource | Responsibility |
| --- | --- |
| Notebook | Permission-scoped workspace with notes, files, settings, and exports |
| Note and note tree | Markdown document and its place in the notebook hierarchy |
| Comment | Durable Markdown discussion attached to one note |
| Link and tag | Connections and searchable labels parsed from note content |
| Attachment | Notebook-owned file referenced from Markdown |
| Named block and script | Structured Markdown data and optional code that operates inside the notebook boundary |
| Activity | Durable, permission-aware semantic changes across a notebook or note |
| Saved version | Recoverable note snapshot with the set of contributors represented by that version |

Named blocks remain visible Markdown rather than a hidden database. Scripts can
read and update the current notebook through the documented runtime APIs, but
cannot use that API to reach another notebook.

Realtime typing does not create one history row per keystroke. Notebooks groups
collaborative edits by actor, note, and hour. Saved versions remain separate
recovery snapshots and can reference every user or service account whose edits
contributed since the preceding saved version.

Comments follow the parent notebook's permissions. Readers can see existing
discussion; users with write access can add comments, including on a locked
note. Locking freezes the note body, not its discussion. Comment authors may
edit or delete their own comment for ten minutes after posting.

## How Notebooks fits Cloud

Notebooks owns notes, hierarchy, attachments, realtime document state, search,
exports, and snapshots. Cloud supplies identity, resource access,
resource-bound API keys, settings, background schedules, dashboard widgets,
application discovery, and the shared Help surface.

## Find detailed product help

Open **Help** inside Notebooks for writing, organization, structured blocks,
formulas, scripts, access, exports, and troubleshooting. Developers can read
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
