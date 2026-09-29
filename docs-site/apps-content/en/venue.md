---
title: Venues
navTitle: Venues
section: Everyday
order: 200
description: Opening hours, staffing shifts, public pages, calendars, and visitor feedback for staffed places.
tags: [venues, shifts, schedules, public-pages, cli]
updated: 2026-09-28
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
- Define weekly opening hours and exceptions for individual dates: a closed
  day or a special opening with its own times.
- Publish staffing slots and let staff take upcoming shifts. One click or tap
  on a shift opens its details with the people on it; on a phone they open as
  a sheet from the bottom.
- Add notices, Markdown, links, or menu sections to the public page, or keep
  them as drafts until they are ready.
- Review visitor feedback, optionally only ratings with a comment, and
  subscribe to your own shifts in a calendar app.

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

## Understand the Venues model

| Resource or surface | Responsibility |
| --- | --- |
| Venue | One staffed place with its name, timezone, public settings, and access policy |
| Opening rule and date override | Regular weekly hours plus exceptions for a specific date: closed, or a special opening that replaces the day's hours and opens the venue in every opening mode |
| Shift template and assignment | A recurring staffing slot on one weekday and the users assigned to its occurrences; a paused template (`active: false`) plans no occurrences. `POST /api/venue/venues/{id}/templates/batch` creates up to seven templates, for example one per weekday, in one transaction: all or none |
| Public section | An ordered Markdown, menu, notice, or links block; the public page shows it unless it is a draft |
| Feedback entry | A visitor rating (1 to 5 stars, required) and optional comment for one venue |
| Personal calendar link | A tokenized iCal feed of the current user's shifts at every venue; renewing it replaces the token, and the old URL answers 404 |

Read, staff, and admin permissions serve different jobs:

| Permission | Sees and does |
| --- | --- |
| Read | The shift schedule, your own shifts, and exactly what the public page shows; no visitor feedback and no drafts |
| Staff (`write`) | Also joins shifts and sees visitor feedback and drafts |
| Admin | Also changes schedules, public content, the public page switch, feedback settings, and access, and removes other people from a shift |

Read and staff users can open the venue settings, but only read them.

The same rules apply in the workspace, the API, `cld venue`, capabilities, and
Venue API keys with the matching permission.

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
calendar link, and shift templates on several weekdays at once are available
in the workspace and the API (`feedbackComments=true` on the dashboard,
`POST /api/venue/calendar/my/renew`, `POST /api/venue/venues/{id}/templates/batch`),
not in `cld venue`.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
