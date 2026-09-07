---
title: Venues
navTitle: Venues
section: Everyday
order: 200
description: Opening hours, staffing shifts, public pages, calendars, and visitor feedback for staffed places.
tags: [venues, shifts, schedules, public-pages, cli]
updated: 2026-09-07
---

# Venues

Venues coordinates staffed places such as service counters, office hours,
cafes, and recurring event locations. Each venue combines opening status,
staffing, a public page, and visitor feedback without mixing those concerns
across different places.

## Use Venues

- Start from a blank venue or a template and set its public identity.
- Define weekly opening hours and exceptions for individual dates.
- Publish staffing slots and let staff sign up for upcoming shifts.
- Add notices, Markdown, links, or menu sections to the public page.
- Review visitor feedback and share personal calendar subscriptions for shifts.

Public content and opening status are visible without a Cloud account when the
venue enables them. Staffing and administration still follow the venue's
resource permissions.

## Understand the Venues model

| Resource or surface | Responsibility |
| --- | --- |
| Venue | One staffed place with its name, timezone, public settings, and access policy |
| Opening rule and date override | Regular weekly hours plus exceptions for a specific date |
| Shift template and assignment | A recurring staffing slot and the users assigned to its occurrences |
| Public section | An ordered Markdown, menu, notice, or links block on the public page |
| Feedback entry | A visitor rating and optional comment for one venue |
| Personal calendar link | A tokenized iCal view of the current user's assigned shifts |

Read, staff, and admin permissions serve different jobs. Staff can join shifts;
admins can change schedules, public content, feedback settings, and access.

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
public content.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
