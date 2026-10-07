---
title: Venues
navTitle: Venues
section: Everyday
order: 200
description: Opening hours, staffing shifts, public pages, calendars, and visitor feedback for staffed places.
tags: [venues, shifts, schedules, public-pages, cli]
updated: 2026-10-07
---

# Venues

Venues coordinates staffed places such as service counters, office hours,
cafes, and recurring event locations. Each venue combines opening status,
staffing, a public page, and visitor feedback without mixing those concerns
across different places.

## Use Venues

- Start from a blank venue or a template and set its public identity. Until
  the schedule has shifts, admins see setup steps derived from what exists:
  opening hours or shifts, shifts when staffing opens the venue, and access
  for the team.
- Define weekly opening hours and opening-hour exceptions for individual
  dates: a closed day or a special opening with its own times.
- Publish weekly or one-off staffing slots and let staff take upcoming shifts. One click or tap
  on a shift opens its details with the people on it; on a phone they open as
  a sheet from the bottom.
- Manage the public page in one view: switch it on or off, copy its page and
  monitor links, add notices, Markdown, links, or menu sections, keep them as
  drafts until they are ready, put them in order, and check a preview of the
  page, also while it is off.
- Review visitor feedback, optionally only ratings with a comment, and
  subscribe to your own shifts in a calendar app.
- Get a reminder before your shifts; admins also hear about cancellations and
  about shifts that start within 24 hours and still miss people.

Every time in a venue uses the venue's time zone and a 24-hour clock, so
people who open the venue from another time zone see the same times as the
people on site. An end time of 24:00 means until midnight.

Public content and opening status are visible without a Cloud account while
the admin keeps the venue's public page switched on. A switched-off venue and
an unknown one show the same page, which only says that the venue is not
available and links to the Venues app. Upcoming staffed openings appear there as "Additionally
open" with their times; the public page and its status API never show the
internal names of shift templates. Staffing and administration still follow
the venue's resource permissions.

The public page puts the opening status first, then the week's regular hours
from Monday to Sunday, with days without hours marked closed, then "Changed
hours": the closed days and special openings of today and the next 29 days,
with the note the admin wrote for visitors. Public sections and the feedback
form follow. The status API returns the same list as `upcomingExceptions`. The
page follows the Cloud theme of whoever opens it, so visitors without an
account see it light. The workspace previews each section with the same
renderer, so the preview matches the public page. The full monitor display is
always dark, never scrolls, and shows "+N more" where a list does not fit,
always after at least one entry. The feedback code shows whenever everything
fits with it; otherwise the lists get its room. It uses one column on screens
taller than wide, and on wide screens when there are no exceptions, staffed
openings, or feedback code to show next to the status and hours.

A link in a links section leads to an `https:`, `http:`, `mailto:`, or `tel:`
address or to a path on the same Cloud that starts with a single `/`, such as
`/app/grids/forms/…`. The section dialog marks any other address, such as
`www.example.org`, at its field and does not save it; the API and
`cld venue sections` answer 400 and name the link, for example
`content.links.1.href`. So a saved section holds only links the public page
shows.

## Notifications

Venues sends three platform notifications. Each is recommended for browser
delivery with email as the fallback, and every user can turn channels off in
their notification preferences under **Notifications** in the profile.

| Notification | Recipients | When |
| --- | --- | --- |
| Shift reminders (`venue.shiftReminder`) | The person who took the shift, while they still have staff access | About 24 hours before the shift starts, for sign-ups made at least 24 hours ahead; nothing for a closed day or a paused or deleted shift |
| Shift cancellations (`venue.shiftCancelled`) | The venue's admins, except the admin who removed the person | After someone leaves an upcoming shift or an admin removes them |
| Understaffed shifts (`venue.shiftUnderstaffed`) | The venue's admins | Once per shift that starts within 24 hours and still misses people; paused shifts and closed days send nothing. The title starts with **Closed unless staffed** when the shift opens the venue only once staffed and the venue has no regular hours or special opening during it |

Admins are the users with admin access through a direct or group grant; a
grant to everyone signed in or to the public names no recipient. A notice
opens the schedule on the shift's day with its details, where the page
checks access as usual, and the email ends with the same link. Notices use
the venue's time zone and the Cloud's default language (`app.locale`).
Browser notifications on iPhone and iPad need Cloud installed as a Home
Screen app.

A cancellation notice goes out after the cancellation commits; if it fails,
the cancellation stands and the failure is logged. Every notice has an
idempotency key made from the sign-up or the shift and its day, so repeated
requests and scans never send one twice.

## Understand the Venues model

| Resource or surface | Responsibility |
| --- | --- |
| Venue | One staffed place with its name, timezone, public settings, and access policy |
| Opening rule and date override | Regular weekly hours plus opening-hour exceptions for a specific date: closed, or a special opening that replaces the day's hours and opens the venue in every opening mode. An exception never creates a shift |
| Shift template and assignment | A weekly staffing slot on one weekday or a one-off slot on a specific date, and the users assigned to it; a paused template (`active: false`) plans no occurrences. `POST /api/venue/venues/{id}/templates/batch` creates up to seven templates, for example one per weekday, in one transaction: all or none |
| Public section | An ordered Markdown, menu, notice, or links block; the public page shows it unless it is a draft |
| Feedback entry | A visitor rating (1 to 5 stars, required) and optional comment for one venue |
| Personal calendar link | A tokenized iCal feed of the current user's shifts at every venue, worded in the Cloud's default language (`app.locale`) because a calendar app sends no language; renewing it replaces the token, and the old URL answers 404 |

Read, staff, and admin permissions serve different jobs:

| Permission | Sees and does |
| --- | --- |
| Read | The shift schedule, your own shifts, and exactly what the public page shows; no visitor feedback and no drafts |
| Staff (`write`) | Also joins shifts, sees visitor feedback, and gets drafts through the API and `cld` |
| Admin | Also changes schedules, public content, the public page switch, feedback settings, and access, and removes other people from a shift |

The workspace navigation has a fixed set of entries per role, however many
sections a venue has: Take shift for staff where shifts take sign-ups,
Schedule, My shifts, Feedback for staff and admins, Public page, and Venue
settings for admins only. Admins manage the public page in its own view:
the public page switch, links to the page and its monitor display, the
sections in their public order with a visibility switch each, and a preview
built from the public page's own components that also works while the page
is off. Staff and read users open Public page for its link only and do not
see the venue settings. Links to single sections from before this view,
`/app/venue/{id}/public-sections/{sectionId}`, redirect admins to
`/app/venue/{id}/public?section={sectionId}` and everyone else to the
schedule.

`PUT /api/venue/venues/{id}/sections/order` takes `sectionIds`, every section
of the venue exactly once, and saves the order in one transaction: a list
that misses or repeats a section answers 400, a section of another venue 404,
and neither changes anything. `GET /api/venue/venues/{id}/public-preview`
returns what the public status route would return, also while the public page
is off. Both require admin permission.

The same rules apply in the workspace, the API, `cld venue`, capabilities, and
Venue API keys with the matching permission.

### Plan a one-off shift through the API

Admins can use `POST /api/venue/venues/{id}/templates` for either kind of shift.
For a one-off, send `date` as `YYYY-MM-DD` with the title, start and end times,
and staffing settings. The date must be from today through 366 days ahead in
the venue's time zone. Omit `weekday` to derive it from the date; if supplied,
it must agree. For weekly shifts, omit `date` or set it to `null` and supply
`weekday` (Sunday is 0).

`PATCH /api/venue/venues/{id}/templates/{resourceId}` replaces the settings.
Include the date when updating a one-off; changing it applies the same date
limits. Keeping an old date allows edits to a past shift. An update cannot
switch a weekly shift into a one-off or a one-off into a weekly shift.
The batch route accepts up to seven shifts of either kind and saves all or none.

One-off shifts use the same signup, capacity, cancellation, notifications,
and personal calendar as weekly shifts. They appear only on their date,
including when viewing past weeks. The dashboard's `templates` list contains
weekly templates and one-off shifts from seven days ago through 366 days ahead;
its `slots` include the one-offs in the requested calendar range. Paused and
deleted shifts plan no slots. For a one-off,
`POST /api/venue/venues/{id}/templates/{templateId}/signup-weeks` takes only
its own date and, as for weekly shifts, skips a date the user already has or
that is full: the answer is `201` with the sign-ups it made, possibly none.

The `shift.list` and `shift.read` capabilities return `recurring: true` for
weekly shifts and `false` for one-offs. Pass the returned `venueId`,
`templateId`, and `date` to `assignment.signup` for either kind. The capability
limit of 100 active templates applies to weekly templates and one-offs in the
requested date range, so old one-offs do not prevent listing upcoming shifts;
when that range exceeds the limit, `shift.list` asks for fewer days.
Opening-hour exceptions stay separate: they change only the hours and never
create a shift. A one-off shift counts toward the staffed opening logic like a
weekly shift on that date.

## How Venues fits Cloud

Venues owns schedules, assignments, opening status, public content, feedback,
and its application API. Cloud supplies actors and access subjects, resource
authorization, resource-bound API keys, dashboard widgets, application
discovery, and the shared Help surface.

## Find detailed product help

Open **Help** inside Venues for setup, schedules, shift signup, public sections,
feedback, calendar links, permissions, and troubleshooting. Developers can
read [Resource authorization](/en/docs/identity/authorization),
[Resource API keys](/en/docs/identity/resource-api-keys), and
[Dashboard widgets](/en/docs/platform/dashboard-widgets) for the shared
contracts Venues adopts.

## Automate Venues from the terminal

Venues provides a native CLI module. Start with read commands to discover the
accessible resources and current public state:

```bash
cld venue list --json
cld venue status "Cafe Counter" --json
```

Run `cld venue help` for the available areas. Run
`cld venue <command> --help` before changing access, schedules, shifts, or
public content. `cld venue sections update` changes only the flags you pass,
so editing a draft never publishes it.

The feedback filter for ratings with a comment, the renewal of the personal
calendar link, shift templates on several weekdays at once, the section order,
and the public page preview are available in the workspace and the API
(`feedbackComments=true` on the dashboard, `POST /api/venue/calendar/my/renew`,
`POST /api/venue/venues/{id}/templates/batch`,
`PUT /api/venue/venues/{id}/sections/order`,
`GET /api/venue/venues/{id}/public-preview`), not in `cld venue`.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.

Startup adds the nullable shift date, its weekday constraint, and a date index
idempotently. Existing templates keep `date: null` and continue weekly; no new
configuration or signup migration is needed. Once one-off shifts exist, an
older Venue release ignores their date and plans them every week; before
rolling back, delete or pause one-off shifts, or restore the pre-upgrade database.

Venues runs one scheduler, `venue:shift-notices`, every 15 minutes on the
installation's NATS; after downtime it runs once for the missed time. Each run
scans the next 24 hours in batches of 100 venues and sign-ups and hands the
notices to Cloud's notification delivery. It needs no new configuration.
