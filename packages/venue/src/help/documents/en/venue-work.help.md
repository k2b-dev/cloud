---
id: venue-work
title: Shifts & Public Page
icon: ti ti-calendar-event
description: Workspace views, public sections, feedback, and access.
order: 110
---

The venue workspace separates daily staffing, personal assignments, public content, feedback, and administrative settings.

## Workspace views {icon="layout-list"}

:::reference
- **Shifts:** Shows staffing slots in a week or month calendar. Staff users can sign up from the action button or by double-clicking a slot.
- **My shifts:** Lists your upcoming assignments and lets you cancel your own shifts.
- **Feedback:** Shows rating trends, comment search, and 7-, 14-, or 30-day filters for visitor ratings and comments from the public page. Only staff and admins see this view.
- **Public sections:** Admins can add, edit, duplicate, or delete markdown, menu, notice, and links sections. Staff and admins also see hidden sections; read users see only what the public page shows.
:::

## Settings and access {icon="shield-lock"}

:::reference
- **General:** Edit name, slug, description, icon, theme color, logo, banner, and feedback activation.
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
| Public sections | As the public page shows them | All, including hidden ones | All, including hidden ones |
| Visitor feedback: ratings, comments, and counts | No | Yes | Yes |
| Change settings, access, schedule, or public sections | No | No | Yes |
| Cancel another person's shift | No | No | Yes |

For public sections, read access shows no more than the public page: when the public page is off, read users see none. The same rules apply to the API, `cld venue`, AI tools, and Venue API keys with the matching permission.

:::note Stable links
Venue links use the venue's immutable short ID. Editing the display slug changes discovery metadata, not the public or staff URL.
:::
