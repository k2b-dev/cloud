---
title: Spaces
navTitle: Spaces
section: Work
order: 130
description: Shared boards for tasks, events, comments, views, and calendar planning.
tags: [spaces, tasks, calendar]
updated: 2026-08-30
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
