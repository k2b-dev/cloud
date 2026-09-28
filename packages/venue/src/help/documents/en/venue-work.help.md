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
- **Shifts:** Shows staffing slots in a week or month calendar. Staff users take a shift with **Take shift** or, when the venue takes shift sign-ups, by double-clicking a slot. For read users, the calendar only shows coverage. The dialog lists every shift of the next 14 days, starting today, and says how far the list reaches; **Load more shifts** adds the next 14 days. Shifts you already have read **You're in**.
- **Shift states:** Every shift names its state in words and with an icon, and the color repeats it. A shift that reached its target shows a check with **Target reached** or **Full**. A shift that still needs people shows how many, such as **1 missing**, in amber. It turns red only when the venue opens for the shift only once it is staffed and the shift starts within 24 hours. An ended shift is gray and reads **Ended**. Staffing reads as *assigned of target*, for example **0 of 1–3 staffed · 1 missing**.
- **My shifts:** Lists your upcoming shifts with weekday, date, start and end, and the shift's name; free time reads **Free time** with its note. **Leave** gives up a shift after a confirmation, and your spot becomes free for others.
- **Subscribe to calendar:** In **My shifts**, **Subscribe to calendar** shows your personal calendar link for your shifts at every venue. **Open in calendar app** subscribes on your device, and **Copy link** copies the link for calendar apps that ask for a URL. The link is personal: anyone who has it can see your shifts. **Renew link** replaces it, and the old link stops working at once. Calendars that used the old link need the new one.
- **Feedback:** Shows the average rating per day on a scale from 1 to 5, the number of ratings per day, comment search, a filter **Only with comment**, and 7-, 14-, or 30-day filters for visitor ratings and comments from the public page. A period counts calendar days in the venue's time zone, today included. The figures and the list cover the same period; the list shows 50 ratings per page. The search and **Only with comment** narrow the list and its count, but not the figures. Only staff and admins see this view.
- **Public sections:** Admins can add, edit, duplicate, or delete markdown, menu, notice, and links sections. The switch **Show on the public page** decides whether visitors see a section; when it is off, the section is a draft. Saving an edit keeps whatever the switch shows. Drafts carry the label **Draft** in the sidebar, and every section states above its preview whether visitors see it. Staff and admins also see drafts; read users see only what the public page shows.
:::

## Settings and access {icon="shield-lock"}

:::reference
- **General:** Edit name, slug, description, icon, theme color, logo, banner, and feedback activation. Read and staff users see these settings read-only; only admins can change them.
- **Schedule:** Choose the public opening logic and manage regular hours, exceptions for single dates, and recurring shifts.
- **Access:** Admins grant read, staff, or admin access to users, groups, public, or signed-in users.
- **Links:** Open the public page, or open **Subscribe to calendar**, the same dialog as in **My shifts**.
- **API keys:** Admins can create resource-bound keys for integrations that need access to this venue.
:::

## Who sees what {icon="eye"}

| In the workspace | Read | Staff | Admin |
| --- | --- | --- | --- |
| Shift schedule and your own shifts | Yes | Yes | Yes |
| Take shifts | No | Yes | Yes |
| Leave your own shifts | Yes | Yes | Yes |
| Public sections | As the public page shows them | All, including drafts | All, including drafts |
| Visitor feedback: ratings, comments, and counts | No | Yes | Yes |
| Open venue settings | Read-only | Read-only | Yes |
| Change settings, access, schedule, or public sections | No | No | Yes |
| Remove another person from a shift | No | No | Yes |

For public sections, read access shows no more than the public page: when the public page is off, read users see none. The public page lists upcoming staffed openings as **Additionally open** with their times; it never shows the internal names of shifts. The same rules apply to the API, `cld venue`, AI tools, and Venue API keys with the matching permission.

:::note Stable links
Venue links use the venue's immutable short ID. Editing the display slug changes discovery metadata, not the public or staff URL.
:::
