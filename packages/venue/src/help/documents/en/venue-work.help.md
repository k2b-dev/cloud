---
id: venue-work
title: Shifts & Public Page
icon: ti ti-calendar-event
description: Workspace views, public sections, feedback, and access.
order: 110
---

The venue workspace separates daily staffing, personal assignments, public content, feedback, and administrative settings.

All times use the venue's time zone and a 24-hour clock, wherever you open the venue. When your device runs in another time zone, the workspace names the venue's time zone above the times, as summer or standard time for the dates shown.

## Workspace views {icon="layout-list"}

:::reference
- **Shifts:** Shows staffing slots in a week or month calendar. Staff users sign up from the action button or, when the venue takes shift sign-ups, by double-clicking a slot. For read users, the calendar only shows coverage. The sign-up dialog lists every shift of the next 14 days, starting today, and says how far the list reaches; **Load more shifts** adds the next 14 days. Shifts you already joined read **Joined**.
- **My shifts:** Lists your upcoming assignments with day and time range and lets you cancel your own shifts.
- **Feedback:** Shows rating trends, comment search, and 7-, 14-, or 30-day filters for visitor ratings and comments from the public page. A period counts calendar days in the venue's time zone, today included. The figures and the list cover the same period; the list shows 50 ratings per page, and a search narrows the list but not the figures. Only staff and admins see this view.
- **Public sections:** Admins can add, edit, duplicate, or delete markdown, menu, notice, and links sections. The switch **Show on the public page** decides whether visitors see a section; when it is off, the section is a draft. Saving an edit keeps whatever the switch shows. Drafts carry the label **Draft** in the sidebar, and every section states above its preview whether visitors see it. Staff and admins also see drafts; read users see only what the public page shows.
:::

## Settings and access {icon="shield-lock"}

:::reference
- **General:** Edit name, slug, description, icon, theme color, logo, banner, and feedback activation. Read and staff users see these settings read-only; only admins can change them.
- **Schedule:** Choose the public opening logic and manage regular hours, closed days, and recurring shifts.
- **Access:** Admins grant read, staff, or admin access to users, groups, public, or signed-in users.
- **Links:** Open the public page or copy your personal iCal subscription for venue shifts.
- **API keys:** Admins can create resource-bound keys for integrations that need access to this venue.
:::

## Who sees what {icon="eye"}

| In the workspace | Read | Staff | Admin |
| --- | --- | --- | --- |
| Shift schedule and your own shifts | Yes | Yes | Yes |
| Sign up for shifts | No | Yes | Yes |
| Cancel your own shifts | Yes | Yes | Yes |
| Public sections | As the public page shows them | All, including drafts | All, including drafts |
| Visitor feedback: ratings, comments, and counts | No | Yes | Yes |
| Open venue settings | Read-only | Read-only | Yes |
| Change settings, access, schedule, or public sections | No | No | Yes |
| Cancel another person's shift | No | No | Yes |

For public sections, read access shows no more than the public page: when the public page is off, read users see none. The same rules apply to the API, `cld venue`, AI tools, and Venue API keys with the matching permission.

:::note Stable links
Venue links use the venue's immutable short ID. Editing the display slug changes discovery metadata, not the public or staff URL.
:::
