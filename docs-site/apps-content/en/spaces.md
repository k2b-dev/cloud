---
title: Spaces
navTitle: Spaces
section: Work
order: 130
description: Shared boards for tasks, events, comments, views, and calendar planning.
tags: [spaces, tasks, calendar]
updated: 2026-10-19
---

# Spaces

Spaces organizes tasks and events for a team, project, household, class, or
recurring process. The same items can be viewed as a list, table, Kanban board,
or calendar without copying the work into separate systems.

Open another Space in the sidebar, shared by the overview and every Space.
On phones, open the title menu **Space name ⌄**, or **Spaces ⌄** on the overview.
Both offer **My work**, every accessible Space, and **New space** for signed-in
users. The create dialog offers **Template** with **Blank space**, **Task board**,
**Event calendar**, and **Project tracker**; choosing one fills the form and sets
the starting view. Every field stays editable before creating the Space.

## Use Spaces

- Track tasks with status, priority, assignees, deadlines, simple checklists,
  tags, descriptions, and comments.
- Plan events with start and end times, recurrence, and calendar views.
- Start recurring kinds of work from templates that fill in the fields and
  propose the next matching dates.
- Switch between list, table, Kanban, and calendar views for the current job.
- Filter and group the same items by state, activity, person, priority, tag, or
  time. The inactive filter finds open tasks without activity for 30 days; the
  in-progress filter finds tasks somebody has claimed.
- Import an invitation from Mail into a chosen writable Space, or publish an
  enabled calendar feed to another calendar client.

The Spaces start page brings accessible work together without changing its
owning Space. **My work** in the sidebar opens it and shows the count assigned
to you. Each Space row shows its open item count; pinned Spaces come first.
The sidebar width is shared between the overview and Space pages and can be
resized. In the page header, switch between **For me**, **Today**, and
**Upcoming**, search Spaces, tasks, and events, or choose **New task** to choose
a Space for a new task. On larger screens, the Activity panel shows recent
Space and item changes; on mobile it opens from the **Activity** button.

Inside a Space, **List**, **Table**, **Kanban**, and **Calendar** are tabs in the
page header. Search and filter chips share that header in list, table, and
Kanban; **Reset** clears active filters and search. The calendar keeps its own
toolbar. The header also offers scoped search, **New task** or **New event**,
and the **…** menu for **Space settings**, **Copy iCal URL** when enabled, and
**Keyboard shortcuts** in Kanban. On phones, the primary action is a round
**+** button. If you can edit the Space, the header previews people with access
beside the menu or inside it when space is limited.

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

## Check off tasks in the mobile app

> **Preview:** the mobile app is not released yet.

When the installation runs the
[mobile app](/en/docs/frontend/mobile-app-pages), Spaces appears on its Start
page and, when there is room, in its tab bar for people with the `user` role. Guests do not see it.
The page at `/pwa/spaces` shows the start page's **For me**, **Today**, and
**Upcoming** lists with their counts, across every Space you can read.
Tasks you claim also count as yours in **For me**.

- Each row shows the title, the Space with its color, and the deadline or, for
  an event, its time or **All day**. An overdue deadline is red.
- Tap the circle in front of a task to mark it done. The task leaves the list
  at once, and **Undo** in the confirmation brings it back and reopens it. When
  you change your mind several times in a row, your last tap is the one that
  stays. This is the same change as on the web, with the same activity entry,
  and it needs write access to the Space. The circles are dimmed for the moment
  until the page is ready.
- Events have no circle. Complete them in Spaces on the web.
- A task you claimed yourself with **I'm on it** is completed with your claim,
  as on the web. A task someone else claimed stays open; the app names who is
  working on it, and you can take it over on the web.
- A task with unfinished blockers stays open, and the app says why. So does a
  task in a Space you can only read, and a task that was deleted in the
  meantime disappears from the list. These notices offer no **Retry**, because
  trying again would not change the answer.
- If a change cannot be saved, for example while the phone is offline, the
  task goes back to how it is saved, and a notice offers **Retry**.
- The selected list is part of the address, so a reload keeps it.
- Each list shows a bounded number of items, the same as the start page on the
  web: up to 100 for **For me**, 5 for **Today**, and 30 for **Upcoming**. When
  the count is higher, a line under the list says how many more are in Spaces
  on the web.

### Open a task

Tap a row to open its task. The task has its own address,
`/pwa/spaces/<space>/<task>`, so a reload, Back, and rotating the device show
the same task. Only people who can read the task's Space can open it; for
anyone else the address does not exist.

- On a phone and on an iPad upright, the task replaces the list, with
  **Back to Spaces** in its head. From 64 rem (1024 px), for example on an
  iPad across or a monitor, the list stays beside the task, the open task's
  row is marked, and **No task selected** holds the place until you choose one.
- The task shows its Space in the head, whether it is done, the deadline or
  for an event the time and place, the people assigned or attending, the
  description, and the checklist with how many items are done.
- The title, Space, and date show at once from the row; the rest follows.
- Tap the circle to mark the task done or open it again, and tap a checklist
  item to check it off. Each change shows at once with a spinner at its place
  while it saves. When it cannot be saved, it goes back, its row offers
  **Retry**, and a line above the checklist says how many changes are not
  saved.
- Without write access to the Space, the task says so, and the circle and the
  checklist are off.
- **Comment** sends a comment to the task. What you type stays on the device
  until it is sent, also when the app is closed in between. When it cannot be
  sent, the text stays and **Retry** safely repeats the send, including after
  restarting the app. A late answer cannot clear a newer draft. Without write access to
  the Space, there is no comment field.
- **Open in Spaces** opens the task in Spaces on the web, to edit everything
  else.

The comment API, `POST /api/spaces/:id/items/:itemId/comments`, accepts an
optional `requestId` UUID alongside `content`. Reuse it for retries of the same
comment. While that comment exists unchanged, a retry returns it without
another comment or activity entry; a different author, item, occurrence, or
content with the same request ID returns 409. The response keeps its usual
short comment ID.

## Understand the Spaces model

| Resource | Responsibility |
| --- | --- |
| Space | Permission-scoped work area with columns, tags, items, and settings |
| Item | Task or event with shared content and workflow fields |
| Column and tag | Ordered workflow stage and cross-cutting label |
| Reaction | One emoji reaction per person on an item |
| Comment, checklist entry, and assignee | Collaboration context attached to one item |
| Link | A Cloud resource reference or an external URL on one item; GitHub issue and pull request links show a cached preview |
| Calendar surface | Time-based view, invitation integration, and optional iCal export |

Tasks use deadlines; events use a schedule and may recur. Deadlines are all-day by default. Choose **Add time** for a specific time and **Remove time** to return to an all-day deadline. An all-day deadline becomes overdue on the following day in the application timezone. Day and week calendars show it in the all-day row; month and year show it on its date. Existing timed deadlines keep their time. Views, filters, and
grouping change how items are presented, not which resource owns them.

Each person can react once per emoji. Reacting needs write access; seeing reactions
needs read access. Standalone and agent accounts react under their own name.
Reactions send no notifications and record no activity, so they do not reset the
inactive marker. An item holds at most 20 different emoji, ordered by the first
remaining reaction. Counts do not change this order. A reaction on a series belongs
to the series item. Generated occurrences have none; saved overrides have their own.

Kanban card footers show up to three reaction chips and "+n" for further emoji.
Select a chip to add or remove your reaction. With a mouse, the card's add button
shows on hover or focus; on touch screens the card has none, so open the item.
The item shows all reactions above the comments, with an add button that is
always visible for people who can edit the item.
Readers see read-only chips. Generated occurrences show no reactions. Recent
emoji are stored per browser under `spaces:recent-emoji`. If saving fails, a
toast offers **Try again** to repeat the failed action. When the item already has
20 different emoji, a new one is not sent; the toast says to react with one that is
already there and offers no **Try again**.

Item reads include `reactions`: each summary has an `emoji`, `count`, `own`, and
up to three other `people` in reaction order. Responses to other item changes
leave `reactions` out, so keep the summary you already have. Add your reaction with
`PUT /api/spaces/:id/items/:itemId/reactions/:emoji`; remove it with `DELETE`
of the same path. Percent-encode the emoji, for example `👍🏽` or `❤️`.
Both return `{ reactions }`. Repeating either intent succeeds without a change.
An invalid emoji returns 400; a 21st different emoji returns 409 with
`REACTION_LIMIT_REACHED`. These routes do not accept `recurrence_id`.

The item details read top to bottom. A task starts with **Planning**: due date,
estimate, priority, and tags, plus a hint that jumps to the first active blocker
while any remain. The description, checklist, and attachments follow; then
**Assigned**, **Latest status**, and **Last result**; then **Blocked by**,
**Blocks**, **Related tasks**, and **Links & resources**; then reactions, comments, and the
collapsed **Details**. An event shows its schedule under **Planning**, then its
location, link, and invitations, its content, the assignees, links,
comments, and details. Parts without content stay hidden unless you can edit
them.

Task attachments hold images and videos, at most 20 per task and 10 MB per
file. **Add image or video** takes them from this device or, when Cloud apps
offer files, from one of them, such as Files; you can also drop them on the
open task. It downscales large images before uploading them and
uploads videos (`.mp4`, `.m4v`, `.mov`, `.webm`, `.ogv`) unchanged, without
transcoding. A video in another format, such as MKV, is not added, and Spaces
names the formats it accepts. A video tile shows its first frame; selecting it
plays the video in a dialog with the browser's own controls and **Download**.
The dialog fits the whole picture, so a vertical reel shows at full height, and
fills the screen on a phone. Whether a video plays depends on its codec and the
browser; one that cannot play offers its download instead. The content route
answers a single byte range with `206 Partial Content`, which browsers need to
play and seek, and ignores any other `Range` header by answering the whole
file. It streams the content from the database in slices, so a player that
stops after the first frame does not make Spaces read the rest. Images and
playable videos are served inline; every other file type downloads.

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

The calendar offers day, week, month, and year views. Below the day view, a
row shows up to five overdue open tasks of the Space and up to five open tasks
without a deadline assigned to you, each with **Show all** for the list view
with the same query. Spaces no longer has a timeline view; an old link with
`cv=timeline` opens the month view of its day.

The month scrolls up and down through week rows, with the weekday names
kept on top. The title follows the month in the center; other months' days
are dimmed, and each first day names its month. The arrows and **Page Up** or
**Page Down** move by a month with the first day's week on top. **Today**
returns to today's month. More weeks load as you scroll or step without
clearing entries or selection, and the count follows the visible days. The
month holds at most 366 days at once; past that, scrolling stops at the last
loaded week, and the arrows open their month on its own. The URL names
a selected day in the focus month, otherwise the day it already named when
that day lies in the focus month, otherwise today in that month, otherwise its
first day.

In the day and week views a day runs from 06:00 to 06:00, so the night after
22:00 belongs to the day before. Nights fold unless an entry lies in them. The
day view runs down through the days with runs of empty days folded into one
row; the week view scrolls sideways through them, seven at a time or three on
a phone, and its arrows move by whole weeks. Both load the week before and
after while you scroll, and the URL follows the first day you see; an item
opens there in place. Another filter keeps the days already loaded and the
place you see, and **Back** after an item keeps the day you scrolled to. The count next to the filters counts the days you see.
Timed deadlines show as dashed lines with a checkbox, or **Space**, to check the
task off, and keep their time when you drag them. All-day deadlines sit in the
all-day row; move them in the month view, where they stay all-day, or in the task. Free time creates an event
where it lies, and a task dragged from the row below the day view into free
time gets that time, keeps its deadline also when it moves later, and leaves
the row. **H**, **J**, **K**, **1** to **4**, **G**, **N**, and **Shift+N**
move, switch views, go to a date, and create in the calendar, and the left
and right arrow keys page like **K** and **J**; the keyboard button of the
calendar lists them. In the year view, **N** and **Shift+N** open the full
form on the shown date.
See [Day and week views](/en/ui/content/calendar#day-and-week-views-with-dayhours)
for the behavior in detail.

An item's **Links & resources** list holds Cloud resource references and external URLs
(at most 20 URLs per item). A GitHub issue or pull request link renders as
`repo#number` with its title and open, closed, or merged state; other links
show the site's favicon and host or the label you gave them. Previews are
fetched server-side, cached in Valkey for five minutes per Space, and never
fetched while a page renders: a first view shows the plain link and the
detail panel fills the preview once. Public repositories work without
configuration. A Space administrator can store one GitHub token per Space
under **… → Space settings → Connections → GitHub**; it is encrypted at rest,
used only to preview links in that Space, and never displayed again. Without a
token, private links
render without a preview. Spaces never writes to GitHub.

Task checklist entries are deliberately small: one completion state and one
label, without separate assignees, dates, or detail pages. Checklist changes
also count as task activity.

A Kanban column loads 30 cards at a time. A dropped card lands directly below
the card it was dropped under, or at the top when dropped above the first card,
and keeps that position after a reload, even when the column holds more cards
than the board has loaded. The board names that neighboring card, and Spaces
places the item in the full column. API clients use the same contract:
`POST /api/spaces/:id/items/:itemId/move` takes `columnId` and either
`afterItemId` or `beforeItemId`, an item of the target column. Without either,
the item goes to the top of the column. An explicit `rank` is still stored as
given, but a neighbor wins when both are sent. Without `completed`, the move
completes or reopens the item when the target column's done state differs from
the item's. Moves in one Space apply one at a time, so concurrent drops never
share a position. A neighbor that is not an
item of the Space, for example because it was deleted or sent through a
wormhole, fails with `404`. A neighbor in another column of the Space fails with
`409`, as does one that leaves the target column while the move runs. Neither
changes anything; reload the column and try again. After a rejected drop, the
board shows the columns as Spaces holds them, so the next drop names a current
neighbor.

Spaces keeps common actions keyboard-first. Outside form fields and dialogs,
**C** creates an item and **Cmd/Ctrl+Shift+K** opens scoped search. These actions
also appear in Cloud search and Layout Help. A focused Kanban card supports
arrow-key navigation, **Enter** to open, **M** to assign it to yourself, and
**D** to complete it. An open item also exposes editing, assignment, deadline,
and completion or reopening actions in the palette.

## Templates

A Space keeps templates for new tasks and for new events, at most 100 of each,
with names unique per kind. A template stores a title and a description that
may contain `{{date}}`, `{{weekday}}`, and `{{week}}`, a priority, tags,
assignees or **Assign to me** for whoever creates the item, a task checklist
and estimate, and an event's location, link, all-day flag, and duration. A due
time is optional for tasks: without one, the deadline is all-day. Events default to a 09:00 start.

Its date rule decides which dates the new item dialog proposes:

| Rule | Proposes |
| --- | --- |
| Weekdays, such as Wednesday or Thursday | The next three matching days |
| In X days (0 to 365) | Today plus X days |
| None | No date; a task starts without a deadline, an event today at its time |

Proposals are local calendar dates in the person's time zone, so week, month,
and daylight-saving changes never move a proposed day. A weekday rule offers
today all day for a task without a time, or only while the template's time still lies ahead when it has one. An offset always counts from today. When someone presses **+**, a Space with templates of that kind
shows a **Template** chip row (a searchable list with more than six), and
choosing one fills the form and shows the proposals as date chips with the
first selected, next to **Other date…** and, for tasks, **No date**.
Placeholders follow whichever date the item gets, from a chip or a picker,
until someone edits the text; filled-in text stops at the item limits of 200
and 5,000 characters. Everything stays editable before saving, and Spaces asks
before a template replaces typed input. The chip rows stay on one line and
scroll sideways on phones; hovering, focusing, or switching chips moves
nothing.

Space admins create, change, and delete templates in the Space settings under
**Templates**; people with write access use them, and read access lists them.
Created items keep no link to their template. A default assignee who loses
access to the Space drops out of the template everywhere it is read until the
access returns. The REST API offers
`GET /api/spaces/:id/templates`, `POST`, `PATCH`, and `DELETE` on
`/api/spaces/:id/templates[/:templateId]`, and
`GET /api/spaces/:id/templates/:templateId/draft?date=&noDate=&timeZone=`, which
returns the proposals and the filled create request without saving anything.
`POST /api/spaces/:id/items` takes `checklist` for a new task and
`assignCreator` for the person creating the item, so a template becomes one
atomic create. The Space detail includes `templates`.

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
cld spaces reactions add "Product":"Fix mobile dialog" "👍🏽"
cld spaces reactions remove "Product":"Fix mobile dialog" "👍🏽"
```

`cld spaces templates ls <space>` and `templates show <space>:<template>`
list templates with their rule and next proposals in the local time zone.
`cld spaces add "Product" --template "Weekly report" [--date YYYY-MM-DD |
--no-date]` creates an item from a template; other `add` flags override it. A
given `--deadline` or `--starts-at` picks the day instead, and `--starts-at`
needs `--ends-at`.

For task deadlines, the API and CLI accept `YYYY-MM-DD` as an all-day date or an ISO date-time as a timed deadline. For example, `cld spaces due <item> 2026-10-24` sets an all-day deadline; `cld spaces due <item> 2026-10-24T17:00:00+02:00` adds a time. Responses carry `deadline` unchanged as a calendar date or normalized ISO instant, and `deadlineAllDay` is true only for a date-only deadline. It is false for timed or absent deadlines. Send `deadline: null` to clear a deadline through the update API. Calendar dates never pass through a timezone. `--due-before` still compares against an instant; an all-day deadline sorts at the start of its day in the configured timezone.

Titles are matched exactly. When a space name or title matches several
resources, the command fails with every candidate as `path (id)` and changes
nothing; retry with an ID. There is no default space, so every address names
its space. `--assignee` and `assign` accept `me`, a person or service account
UUID, a username, or a service account name with access to the Space. Repeat
`--assignee` to replace the assignment with several people or accounts.

The commands follow the shared `cld` verbs: `ls`, `show`, `add`, `set`, `mv`,
and `rm`, the quick actions `done`, `reopen`, `assign`, and `due`, `deps` for
blockers, and the groups `reactions`, `comments`, `attachments`, `checklist`, `references`, `links`,
`invitation`, and `access`. `calendar` and `overlap` query a time range across
spaces. Every command supports `--json`; destructive commands need `--yes`,
and long text comes from `--from <file|->`. Run `cld spaces help` for the
full list. The API behind item addresses is `GET /api/spaces/items/:itemId`
and `GET /api/spaces/resolve?space=&title=`; both apply the same read access
as the web interface.

The `spaces.item.read` capability includes bounded task attachment metadata
with authenticated preview and download links; images and playable videos have
a preview link. Attachment content remains in
Spaces rather than being embedded in capability results.

## Assistant workflows

Use `space.browse` for a compact, paginated choice of Spaces. Set
`minimumPermission: "write"` before creating content. `space.read` adds column
and tag IDs when an action needs them; a second read is not required simply
to confirm a Space already selected from an authorized list.
Space lists may shorten descriptions to fit a full page; when
`descriptionTruncated` is true, `space.read` returns the full description.

`template.list` and `template.read` return a Space's templates with their
rule and next proposed dates in the given `timeZone`, or in the application
timezone without one. `task.create` and `event.create` take `templateId`,
`date`, and `timeZone`: the template fills every field left out, its checklist
included, and `date` picks the day, by default the first proposal. An explicit
`deadline` or `startsAt` picks the day instead, for the placeholders and the
summary too. For "use the
weekly report template for next Wednesday" an agent lists the templates, picks
the matching proposal, and creates the item. `template.create`,
`template.update`, and `template.delete` need Space admin access.

`task.focus` finds open tasks across accessible Spaces without looping over
each Space. It supports assignment, deadline, priority, blocker, and inactivity
filters. Inactive means no task activity for 30 days. Deadline windows use the
configured application timezone, matching the overview. `task.list` and
`event.list` accept `activity` and
`deadlineFilter`; lists include readable column names when available.
`task.list` and `task.focus` entries carry `overdue`, true only for an open
task whose deadline lies before today in the application timezone; completed
tasks are never overdue. Use this flag instead of comparing `deadline` yourself.

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

`task.list` and `event.list` return at most three assignees and tags per item.
`assigneeCount` includes assignees omitted from the preview. When it is larger
than the number of `assignees`, state the total (for example, “3 of 11”) or use
`item.read` before naming everyone. The response budget may shorten previews
further; `relationsTruncated` signals a partial relation preview. Resource
reference previews contain at most 2,000 characters; read the resource for its
full content.

`task.blocker.add` returns the saved blocker with a `spaces.item` ref, just like
`task.blocker.list`. For the reverse direction, `task.blocks.list` returns up to
100 dependent tasks per page by default. Use `cursor` and `limit` and follow
`page.nextCursor` until `page.hasMore` is false.

`event.invitation.prepare` rejects a calendar that would take more than 96 KiB
of the response, measured as JSON-encoded UTF-8, and rolls back the
preparation. Reduce the event content or attendees and try again. A retry of a
stored preparation that is too large needs a new idempotency key.

## Implementation tasks and agent handoffs

Spaces supports flat implementation tasks with blockers, shared progress notes,
completion results and explicit worker claims. The task details show the
latest progress note as **Latest status** and the latest result as **Last
result**, below the **Assigned** list; reopening preserves the result. Earlier
notes are recorded in task activity.

Assignees can be people or active service accounts, including agents. People
need direct or group access to the Space; service accounts need their own
direct access. A Space API key can be assigned only within its own Space, and
personal automation keys cannot be assignees. Assignment never grants access.

Claiming as a person or an agent also assigns you; the claim is the working
state of one assignee. This applies to every account that may claim, also
when it has write access only through access for all signed-in accounts. Releasing your own claim keeps you assigned.
**Assigned to me** and **For me** select your personal assignments, including
tasks you claimed. **Assigned** and **Unassigned** count both people and
service accounts; filtering by an assignee ID can select either kind. The
Kanban column stays the only status. People claim from the board card or the task details with **I'm on it** and release with a second
click, optionally leaving a handoff note that is saved as progress. Board cards,
list rows, and table cells put the working person first in the avatar stack,
with a green ring. They appear once and never in the `+N` overflow.

In the task details, **Assigned** is one list. The working person's row comes
first with the green ring, **working on it**, and the time they started working.
The row stays one line: in a narrow panel, the start time gives way to the name
and the label. A holder outside the assignees, such as a personal automation
key or an account that was deleted, still appears first as a working row,
without a remove action.

Claims coordinate work; they do not lock it. A claim guards completion, not the
column: anyone who can edit the Space can move a claimed task between open
columns, or between done columns, without a claim ID. Completing or reopening a
claimed task, including a drag into a done column, needs the holder's claim ID,
and completing ends the claim; the web UI sends it for your own claim. A
wormhole transfer ends the claim too, because the task leaves the Space, so it
needs the holder's claim ID in the same way. Anyone with write access may take
over someone else's claim. In the task details, **Take over** ends the exact
observed claim and claims the task for you. This moves the claim and
assignment together: the previous holder is removed from the assignees,
and you are assigned. Releasing someone else's claim with force also removes
that account's assignment, even without a new claim. Completing, reopening,
moving, or transferring a task with someone else's claim ends that claim but
keeps the assignees as they are.

Removing the working person or service account from **Assigned** ends their
claim. Removing someone else asks once, for example "Jana Berger is working on this – remove
them and end their claim?". A stale assignee list from a client that has not
seen the new claim is refused with `409`; no fields change. API updates need
the holder's `claimId`, plus `force` for someone else's claim. CLI `assign` and
`set`, and the `task.update` and `event.update` capabilities, require you to
release the claim first.

If someone else claimed a task, completing or reopening it from the board, the
list, the calendar tray, or the details, or sending it through a wormhole,
asks once, for example "Claimed by Jana Berger – take over and complete?", and
then takes the claim over and makes the change in one step. Cancel leaves the
task, and the card, where they were. Task activity records who took a claim
over from whom. The previous holder's next progress, release, or completion
call with the ended claim ID gets `409` "Task claim is no longer active", also
when someone has claimed the task again since.

Use `cld spaces ls <space-id> --ready --json` to find open tasks without
active blockers. Read `show <item> --context` before starting, then claim the task
with a caller-generated UUID. Competing claims fail, including separate workers
using the same account. Claims do not expire or lock ordinary edits. Release
the claim when stopping or before completing from another session. Anyone with
write access can take over an abandoned claim with `release --force` and its
exact ID, or complete with `done --claim-id <id> --force`. A wormhole transfer
through the API takes the same `claimId` and `force` and ends the claim.

`progress` accepts a full handoff as text or through `--from <file|->`. `done` can save
an outcome with verification evidence and an optional commit SHA in the same
transaction as completion. Both user and resource-bound service accounts can
record this work under their actual identity. Comments remain user-authored.

`show <item> --context` includes work state, checklist, attachments, references,
links, and blockers, plus explicit pages of comments and dependent tasks. Follow `hasNext`
in those pages using `comments list` and `deps`; use `activity --cursor` to read
older work notes. Pages are fresh reads and may change during collaboration.
The `comments list` output and the `blocks` field of `deps` are paginated objects.

Agents use `reaction.add` and `reaction.remove` with `{ itemId, emoji }` for the same reaction intents. `item.read` includes the full reaction summary; list capabilities include each emoji with its `count` and `own` state.

For capabilities, use `task.work.read`, `task.claim`, `task.release` and
`task.progress`; `task.release` and `task.set-completed` accept `force` to take
over the exact claim named by `claimId`, `task.set-completed` also accepts
optional `result` and `commit`, and `task.list` and `task.focus` accept `claimed: true` to list
only claimed tasks. Results and progress notes each have the existing 5,000-character
text budget. Keep the repository's Space ID in its agent instructions and
use it in every item address.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.

On upgrade, Spaces preserves existing person assignments and extends item
and template assignments to service accounts. Startup also adds existing
non-personal service-account claim holders to their task’s assignees.

## Commands in global search

Use **Actions** (or `>`) in the Cloud search to create a task or event. Inside a
Space, the form uses that Space; elsewhere, choose a writable Space first.
An open writable item contributes explicitly named edit and completion actions.
Blocked or completed tasks do not offer completion.

Cmd/Ctrl+Shift+K searches the current Space. Cmd/Ctrl+Alt+N opens a new task, or an event in calendar view. Outside inputs, E edits the selected item, M assigns it to you, and D marks it done or reopens it. In the calendar, H, J, K, 1 to 4, G, N, and Shift+N show today, page, switch the view, go to a date, and create an event or a task. Completion remains unavailable while blocked. Search actions update the open palette in place. Actions for the selected object appear before page actions.

## Image upload privacy

New JPEG, PNG, and WebP image uploads remove location and device metadata
without changing image quality. JPEG orientation, colour profiles,
transparency, and supported animation data remain. Malformed containers are
rejected with HTTP 422. This applies to task attachments.

Files keeps originals. HEIC, AVIF, TIFF, SVG, video, GIF, BMP, and unknown
formats remain unchanged and can retain metadata. Previously uploaded images
are not rewritten. See [Image upload privacy](/en/docs/platform/image-upload-privacy)
for the supported formats and limits.
