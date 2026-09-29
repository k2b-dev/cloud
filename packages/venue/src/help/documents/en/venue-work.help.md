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
- **Shifts:** Shows the schedule as a day, week, or month calendar. On a phone, **Month** shows a compact month with the chosen day's shifts listed below it, each with its state in words. The browser remembers the view you used last, separately on each device; the first visit on a phone starts with the phone month view. Free time appears in the calendar as its own entry with the person's name.
- **Shift details:** One click or tap on a shift or on free time opens its details: the time, the staffing, and who is on it. On a wide screen the details sit next to the calendar; on a phone or narrow window they open as a sheet from the bottom. The address of the page includes the selected shift, so reloading the page, sharing the link, or going back keeps it. Staff users take the shift with **Take shift** and can tick **Also the next 4 weeks** to take the same shift in the four following weeks as well. On a shift you already have, **Leave** gives it up after a confirmation. Admins also see **Remove** next to every other person and take them off the shift after a confirmation; their spot becomes free. Read users see the details without these actions. Ended shifts show their details without actions.
- **This week and gaps:** Above the calendar, one line counts the free spots of today and the next six days and names the next shift that still misses people; select it to open its details. These figures stay the same when you page through the calendar. The filter **Gaps only** shows only shifts that still miss people and have not ended, and hides free time.
- **Take a shift:** The dialog lists every shift of the next 14 days, starting today, grouped by day, and says how far the list reaches; **Load more shifts** adds the next 14 days. **Only free** is on at first and hides full shifts; switch it off to see them too. Shifts you already have read **You're in** and offer **Leave**. While **Also the next 4 weeks** is ticked, **Take shift** also takes the same shift in the four following weeks. For free time, pick a start and end, which starts at the next quarter hour, and add it with **Add free shift**.
- **Shift states:** Every shift names its state in words and with an icon, and the color repeats it. A shift that reached its target shows a check with **Target reached** or **Full**. A shift that still needs people shows how many, such as **1 missing**, in amber. It turns red only when the venue opens for the shift only once it is staffed and the shift starts within 24 hours. An ended shift is gray and reads **Ended**. Staffing reads as *assigned of target*, for example **0 of 1–3 staffed · 1 missing**.
- **My shifts:** Lists your upcoming shifts with weekday, date, start and end, and the shift's name; free time reads **Free time** with its note. **Leave** gives up a shift after a confirmation, and your spot becomes free for others.
- **Subscribe to calendar:** In **My shifts**, **Subscribe to calendar** shows your personal calendar link for your shifts at every venue. **Open in calendar app** subscribes on your device, and **Copy link** copies the link for calendar apps that ask for a URL. The link is personal: anyone who has it can see your shifts. **Renew link** replaces it, and the old link stops working at once. Calendars that used the old link need the new one.
- **Feedback:** Shows the average rating per day on a scale from 1 to 5, the number of ratings per day, comment search, a filter **Only with comment**, and 7-, 14-, or 30-day filters for visitor ratings and comments from the public page. A period counts calendar days in the venue's time zone, today included. The figures and the list cover the same period; the list shows 50 ratings per page. The search and **Only with comment** narrow the list and its count, but not the figures. Only staff and admins see this view.
- **Public sections:** Admins can add, edit, duplicate, or delete markdown, menu, notice, and links sections. The switch **Show on the public page** decides whether visitors see a section; when it is off, the section is a draft. Saving an edit keeps whatever the switch shows. Drafts carry the label **Draft** in the sidebar, and every section states above its preview whether visitors see it. Staff and admins also see drafts; read users see only what the public page shows.
:::

## Settings and access {icon="shield-lock"}

:::reference
- **General:** Edit name, slug, description, icon, theme color, logo, banner, and feedback activation, and the schedule rules:
  - **Public opening logic** decides whether regular hours, staffed shifts, or both open the venue.
  - **Sign-up** decides whether staff take the recurring **Shifts**, add their own **Free time**, or **Both**.
  - **Time zone** sets the zone of every venue time. Existing opening hours, exceptions, and shifts keep their clock times: 09:00 stays 09:00 in the new zone.
  - **Public page on** switches the public page and its monitor display on or off. While it is off, the link shows only that the venue is not available.

  Changes in **General** wait for **Save**. Read and staff users see these settings read-only; only admins can change them.
- **Schedule:** Manage regular hours, exceptions, and recurring shifts. Every change here saves at once.
  - **New exception** chooses between **Closed** for the whole day and **Special opening** with a start and end time; a special opening replaces the day's regular hours and shows the venue as open during its times, whatever the opening logic. Exceptions read like **Sat, 10/17/2026 · Special opening 18:00–23:00 · Long night**; past ones are folded under **Past exceptions**.
  - **New shift** can pick several weekdays at once and creates one shift per weekday in a single step: either all of them or, when something is wrong, none. The list groups shifts by weekday, and each shift is edited on its own.
  - The switch next to a shift pauses or resumes it at once. A paused shift keeps its settings and reads **Paused**, but the schedule plans no slots for it, nobody can take it, and it does not open the venue. Deleting a shift removes it for good; past sign-ups keep its name.
  - Times take a 24-hour clock time such as 09:30; typing `9` becomes 09:00. An end time of 24:00 means until midnight. Fields say what is missing or wrong, and a dialog stays open with your input until the save succeeds.
- **Access:** Admins grant read, staff, or admin access to users, groups, public, or signed-in users.
- **Links:** Open the public page, or open **Subscribe to calendar**, the same dialog as in **My shifts**.
- **API keys:** Admins can create resource-bound keys for integrations that need access to this venue.
- **Danger zone:** **Delete venue** removes the venue with its shifts, sign-ups, feedback, and public page. It asks you to type the venue's name before it deletes anything.
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
