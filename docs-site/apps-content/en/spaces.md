---
title: Spaces
navTitle: Spaces
section: Work
order: 130
description: Shared boards for tasks, events, comments, views, and calendar planning.
tags: [spaces, tasks, calendar]
updated: 2026-09-07
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
owning Space. Pin frequently used Spaces, search Spaces, tasks, and events,
and switch between **For me**, **Today**, and **Upcoming**. On larger screens,
the Activity panel shows recent Space and item changes; on mobile it opens
from the Activity button.

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

Task checklist entries are deliberately small: one completion state and one
label, without separate assignees, dates, or detail pages. Checklist changes
also count as task activity.

Spaces keeps common actions keyboard-first. Outside form fields and dialogs,
**C** creates an item and **/** opens search. A focused Kanban card supports
arrow-key navigation, **Enter** to open, **M** to assign it to yourself, and
**D** to complete it.

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

Spaces provides a native CLI module for spaces, items, comments, access, and
calendar queries. Start with read commands:

```bash
cld spaces list --json
cld spaces items "Product" --status active --json
cld spaces attachments "Product" "Fix mobile dialog" --json
```

Run `cld spaces help` for the available areas. Run
`cld spaces <command> --help` before creating or changing work, access, or
calendar integrations.

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
`event.list` retain their existing fields and accept `activity` and
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

`calendar-destination.list` remains the writable destination selector for Mail
invitations. It now exposes pagination (up to 100 destinations per page), so
consumers must follow the returned cursor rather than assume the first page
contains every Space. Existing creation and calendar integration result
contracts are preserved.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
