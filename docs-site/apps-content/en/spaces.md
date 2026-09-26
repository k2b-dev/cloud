---
title: Spaces
navTitle: Spaces
section: Work
order: 130
description: Shared boards for tasks, events, comments, views, and calendar planning.
tags: [spaces, tasks, calendar]
updated: 2026-09-26
---

# Spaces

Spaces organizes tasks and events for a team, project, household, class, or
recurring process. The same items can be viewed as a list, table, Kanban board,
or calendar without copying the work into separate systems.

## Use Spaces

- Track tasks with status, priority, assignees, deadlines, simple checklists,
  tags, descriptions, and comments.
- Plan events with start and end times, recurrence, and calendar views.
- Switch between list, table, Kanban, and calendar views for the current job.
- Filter and group the same items by state, activity, person, priority, tag, or
  time. The inactive filter finds open tasks without activity for 30 days.
- Import an invitation from Mail into a chosen writable Space, or publish an
  enabled calendar feed to another calendar client.

The Spaces start page brings accessible work together without changing its
owning Space. A sidebar lists your Spaces with their open items and last
activity; opening one enters its workspace, and **New space** starts one from
a starter. Pin frequently used Spaces, search Spaces, tasks, and events,
and switch between **For me**, **Today**, and **Upcoming**. On larger screens,
the Activity panel shows recent Space and item changes; on mobile it opens
from the Activity button.

The selected work view and its counters arrive with the page. Switching work
views loads the selected list on demand; Back and Forward restore the view
from the URL. A failed load shows a retry action instead of an empty list.
The app's `/api/spaces/overview/work?view=mine|today|upcoming` endpoint uses the
same permission-filtered reads as SSR and requires an unbound user-backed actor.

Activity is recorded by the Spaces service, so authorized changes made through
the web interface, CLI, or capabilities appear consistently. Repeated edits
to the same item are grouped to keep the feed useful.

Use one Space for work that shares a team and access boundary. Create another
when the audience or lifecycle is different.

## Understand the Spaces model

| Resource | Responsibility |
| --- | --- |
| Space | Permission-scoped work area with columns, tags, items, and settings |
| Item | Task or event with shared content and workflow fields |
| Column and tag | Ordered workflow stage and cross-cutting label |
| Comment, checklist entry, and assignee | Collaboration context attached to one item |
| Link | A Cloud resource reference or an external URL on one item; GitHub issue and pull request links show a cached preview |
| Calendar surface | Time-based view, invitation integration, and optional iCal export |

Tasks use deadlines; events use a schedule and may recur. Views, filters, and
grouping change how items are presented, not which resource owns them.

In list and table views, search updates results without reloading the page or
moving focus out of the search field. The URL follows the displayed results,
so you can share or reload the filtered view. While a search loads, the previous
results stay visible. If it fails, your search text remains available and you
can retry.

Press **Enter** to search immediately. Without JavaScript, submitting the
search loads the filtered page and keeps your other filters. The start page's
**For me**, **Today**, and **Upcoming** links also work without JavaScript.

In list and table views, changing search or filters keeps the open item's
editor and unfinished comment in place. If you select another item while a
calendar date change is loading, the completed date change keeps your newer
selection.

An item's **Links** list holds Cloud resource references and external URLs
(at most 20 URLs per item). A GitHub issue or pull request link renders as
`repo#number` with its title and open, closed, or merged state; other links
show the site's favicon and host or the label you gave them. Previews are
fetched server-side, cached in Valkey for five minutes per Space, and never
fetched while a page renders: a first view shows the plain link and the
detail panel fills the preview once. Public repositories work without
configuration. A Space administrator can store one GitHub token per Space
under **Settings › GitHub**; it is encrypted at rest, used only to preview
links in that Space, and never displayed again. Without a token, private links
render without a preview. Spaces never writes to GitHub.

Task checklist entries are deliberately small: one completion state and one
label, without separate assignees, dates, or detail pages. Checklist changes
also count as task activity.

Spaces keeps common actions keyboard-first. Outside form fields and dialogs,
**C** creates an item and **Cmd/Ctrl+Shift+K** opens scoped search. These actions
also appear in Cloud search and Layout Help. A focused Kanban card supports
arrow-key navigation, **Enter** to open, **M** to assign it to yourself, and
**D** to complete it. An open item also exposes editing, assignment, deadline,
and completion or reopening actions in the palette.

## How Spaces fits Cloud

Spaces owns its items, views, calendar behavior, comments, and recurrence.
Cloud supplies identity, resource access, resource-bound API keys, live
application discovery, dashboard widgets, capability registration, and shared
Help. Mail passes authorized invitation context to Spaces; Spaces remains the
owner of the resulting event.

## Find detailed product help

Open **Help** inside Spaces for first use, views, daily workflow, sharing,
calendar integration, and troubleshooting. Developers can read
[Resource authorization](/en/docs/identity/authorization),
[URL state and navigation](/en/docs/frontend/url-state-and-navigation), and
[App capabilities](/en/docs/platform/capabilities) for the shared contracts
Spaces adopts.

## Automate Spaces from the terminal

`cld spaces` lists and changes work from a terminal. An item is addressed by
its ID or as `<space>:<title>`, with the space given by ID or exact name:

```bash
cld spaces ls --json
cld spaces ls "Product" --mine --due-before 2026-10-01 --json
cld spaces show "Product":"Fix mobile dialog" --json
cld spaces add "Product":"Write release notes" --deadline 2026-10-20 --assignee me
cld spaces done "Product":"Fix mobile dialog"
```

Titles are matched exactly. When a space name or title matches several
resources, the command fails with every candidate as `path (id)` and changes
nothing; retry with an ID. There is no default space, so every address names
its space.

The commands follow the shared `cld` verbs: `ls`, `show`, `add`, `set`, `mv`,
and `rm`, the quick actions `done`, `reopen`, `assign`, and `due`, `deps` for
blockers, and the groups `comments`, `attachments`, `checklist`, `references`, `links`,
`invitation`, and `access`. `calendar` and `overlap` query a time range across
spaces. Every command supports `--json`; destructive commands need `--yes`,
and long text comes from `--from <file|->`. Run `cld spaces help` for the
full list. The API behind item addresses is `GET /api/spaces/items/:itemId`
and `GET /api/spaces/resolve?space=&title=`; both apply the same read access
as the web interface.

The `spaces.item.read` capability includes bounded task attachment metadata
with authenticated preview and download links. Attachment content remains in
Spaces rather than being embedded in capability results.

## Assistant workflows

Use `space.browse` for a compact, paginated choice of Spaces. Set
`minimumPermission: "write"` before creating content. `space.read` adds column
and tag IDs when an action needs them; a second read is not required simply
to confirm a Space already selected from an authorized list.
Space lists may shorten descriptions to fit a full page; when
`descriptionTruncated` is true, `space.read` returns the full description.

`task.focus` finds open tasks across accessible Spaces without looping over
each Space. It supports assignment, deadline, priority, blocker, and inactivity
filters. Inactive means no task activity for 30 days. Deadline windows use the
configured application timezone, matching the overview. `task.list` and
`event.list` accept `activity` and
`deadlineFilter`; lists include readable column names when available.

For actual calendar occurrences, use `event.agenda` with offset-aware `from`
and `to` timestamps. The interval includes its start and excludes its end,
covers at most 31 days, and includes open events rather than task deadlines.
Spaces expands recurrence in the application timezone. Follow `page.nextCursor`
while `page.hasMore` is true, even when a page contains no occurrences: an old
series may have no dates in the interval. Pages keep series and their overrides
together and are individually chronological. Collect every page and sort by
`startsAt` for a complete chronological agenda. Cursors belong to the original
interval, Space, and assignment filter; restart without a cursor after changing
these. A recurrence-budget error is not an empty agenda; inspect the affected
series through `event.list` and `item.read`.

Simple checklists use `task.checklist.list`, `task.checklist.create`,
`task.checklist.update`, and `task.checklist.delete`. Each entry has only an ID,
label, and completed state. Updates change only supplied fields, and deleting
an entry never deletes its task. The same permissions, activity history, and
100-entry task limit apply as in the interface. Follow checklist list cursors
until complete. Work and checklist pages may contain fewer than the requested
limit to stay within the response byte budget; continuation preserves every
entry. Existing task and event lists instead shorten optional previews and
relation snapshots with explicit truncation flags, preserving their page model.

`calendar-destination.list` lists writable Mail invitation destinations in pages
of up to 100. Follow the returned cursor to retrieve every destination.

## Implementation tasks and agent handoffs

Spaces supports flat implementation tasks with blockers, shared progress notes,
completion results and explicit worker claims. Progress and the latest result
appear in the task details; reopening preserves the result. Earlier notes are
recorded in task activity.

Use `cld spaces ls <space-id> --ready --json` to find open tasks without
active blockers. Read `show <item> --context` before starting, then claim the task
with a caller-generated UUID. Competing claims fail, including separate workers
using the same account. Claims do not expire or lock ordinary edits. Release
the claim when stopping, before a transfer, or before completing from another
session. An administrator can recover an abandoned claim by its exact ID.

`progress` accepts a full handoff as text or through `--from <file|->`. `done` can save
an outcome with verification evidence and an optional commit SHA in the same
transaction as completion. Both user and resource-bound service accounts can
record this work under their actual identity. Comments remain user-authored.

`show <item> --context` includes work state, checklist, attachments, references,
links, and blockers, plus explicit pages of comments and dependent tasks. Follow `hasNext`
in those pages using `comments list` and `deps`; use `activity --cursor` to read
older work notes. Pages are fresh reads and may change during collaboration.
The `comments list` output and the `blocks` field of `deps` are paginated objects.

For capabilities, use `task.work.read`, `task.claim`, `task.release` and
`task.progress`; `task.set-completed` accepts optional `result`, `commit` and
`claimId`. Results and progress notes each have the existing 5,000-character
text budget. Keep the repository's Space ID in its agent instructions and
use it in every item address.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.


## Commands in global search

Use **Actions** (or `>`) in the Cloud search to create a task or event. Inside a
Space, the form uses that Space; elsewhere, choose a writable Space first.
An open writable item contributes explicitly named edit and completion actions.
Blocked or completed tasks do not offer completion.

Cmd/Ctrl+Shift+K searches the current Space. Cmd/Ctrl+Alt+N opens a new task, or an event in calendar view. Outside inputs, E edits the selected item, M assigns it to you, and D marks it done or reopens it. Completion remains unavailable while blocked. Search actions update the open palette in place. Actions for the selected object appear before page actions.
