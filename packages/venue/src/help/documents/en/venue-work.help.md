---
id: venue-work
title: Shifts & Public Page
icon: ti ti-calendar-event
description: Workspace views, the public page, feedback, and access.
order: 110
---

The venue workspace separates daily staffing, personal assignments, feedback, the public page, and administrative settings. Its sidebar and phone menu have a fixed set of entries for each role, however many sections the venue has: **Take shift** for staff where shifts take sign-ups, **Schedule**, **My shifts**, **Feedback** for staff and admins, **Public page**, and **Venue settings** for admins only, last.

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
- **Public page:** Admins manage everything visitors see in one view. On top, **Public page on** switches the page on or off, **Copy page link** and **Copy monitor link** copy the addresses of the page and of its full display, and **Open** opens the page in a new tab. Staff and read users open **Public page** to copy or open the link.
- **Sections:** Below the switch, **Sections** lists every section in the order visitors see them, drafts included and marked **Draft**. Each row moves the section up or down with its arrow buttons, which also work from the keyboard; the new order saves at once, for all sections together. The switch in a row decides whether visitors see the section; when it is off, the section is a draft. **Edit** changes a section; saving keeps whatever its switch shows and never moves it. The menu next to it duplicates a section as a draft at the end, titled like **Lunch (copy)**, or deletes it after a confirmation. The dialog names a missing title, an unnamed menu item, or an incomplete link at the field and stays open with your input until the save succeeds.
- **Preview:** Next to the list, or below it on a phone or narrow window, the **Preview** shows the page as visitors see it, with the public page's own rendering: status, hours, changed hours, and the visible sections in their order. It also works while the page is off. A notice stands out in the same way, and menu items outside their availability dates are left out, counted in the venue's time zone.
- **Links in sections:** A link leads to a web address with https:// or http://, an email address with mailto:, a phone number with tel:, or a path on this Cloud starting with /; the dialog marks any other address and does not save it. Links to single sections from before this view open **Public page** with that section marked.
:::

## Public page and monitor {icon="device-tv"}

:::reference
- **Order:** The public page starts with the venue's status: **Open** with the current opening window, or **Closed** with the next opening. When nothing is planned for the next two weeks, one sentence says so. Then follow the regular hours of the week with today marked, which visitors can fold away, then **Changed hours**, the upcoming staffed openings, the public sections, and feedback. On a phone this is the order from top to bottom; on a wide screen the hours and feedback sit in a column next to the sections.
- **Changed hours:** Closed days and special openings of today and the next 29 days appear in advance, with their date, their times, and their note, such as **Sat, Oct 3 · Closed · Public holiday**. Notes of exceptions and regular hours are public, so write them for visitors.
- **Theme:** The page follows the Cloud theme of the person who opens it, light or dark. Visitors without a Cloud account see it light.
- **Monitor:** The full display for an unattended screen is always dark and never scrolls. A wide screen shows two columns, or one when there are no changed hours, staffed openings, or feedback code to show; a screen taller than it is wide, such as a portrait kiosk or a phone, shows one. Where a list does not fit, it shows as many entries as fit and says how many it leaves out, such as **+3 more**.
:::

## Settings and access {icon="shield-lock"}

:::reference
- **General:** Edit name, slug, description, icon, theme color, logo, banner, and feedback activation, and the schedule rules:
  - **Public opening logic** decides whether regular hours, staffed shifts, or both open the venue.
  - **Sign-up** decides whether staff take the recurring **Shifts**, add their own **Free time**, or **Both**.
  - **Time zone** sets the zone of every venue time. Existing opening hours, exceptions, and shifts keep their clock times: 09:00 stays 09:00 in the new zone.
  - **Public page on** switches the public page and its monitor display on or off. While it is off, the link shows only that the venue is not available.

  Changes in **General** wait for **Save**. Only admins see and open the settings.
- **Schedule:** Manage regular hours, exceptions, and recurring shifts. Every change here saves at once.
  - **New exception** chooses between **Closed** for the whole day and **Special opening** with a start and end time; a special opening replaces the day's regular hours and shows the venue as open during its times, whatever the opening logic. Exceptions read like **Sat, 10/17/2026 · Special opening 18:00–23:00 · Long night**; past ones are folded under **Past exceptions**.
  - **New shift** can pick several weekdays at once and creates one shift per weekday in a single step: either all of them or, when something is wrong, none. The list groups shifts by weekday, and each shift is edited on its own.
  - The switch next to a shift pauses or resumes it at once. A paused shift keeps its settings and reads **Paused**, but the schedule plans no slots for it, nobody can take it, and it does not open the venue. Deleting a shift removes it for good; past sign-ups keep its name.
  - Times take a 24-hour clock time such as 09:30; typing `9` becomes 09:00. An end time of 24:00 means until midnight. Fields say what is missing or wrong, and a dialog stays open with your input until the save succeeds.
- **Access:** Admins grant read, staff, or admin access to users, groups, public, or signed-in users.
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
| Public page | Copy or open the link | Copy or open the link | Switch, sections, order, and preview |
| Visitor feedback: ratings, comments, and counts | No | Yes | Yes |
| Open venue settings | No | No | Yes |
| Change settings, access, schedule, or public sections | No | No | Yes |
| Remove another person from a shift | No | No | Yes |

For public sections, read access shows no more than the public page: when the public page is off, read users see none. The public page lists upcoming staffed openings as **Additionally open** with their times; it never shows the internal names of shifts. The same rules apply to the API, `cld venue`, AI tools, and Venue API keys with the matching permission.

:::note Stable links
Venue links use the venue's immutable short ID. Editing the display slug changes discovery metadata, not the public or staff URL.
:::
