---
id: venue-troubleshooting
title: Troubleshooting
icon: ti ti-lifebuoy
description: Fix incorrect opening status, missing shifts, problems taking shifts, public content, feedback, and calendar subscriptions.
order: 120
---

## Common symptoms {icon="lifebuoy"}

:::reference
- **The public page shows the wrong opening status:** Check regular hours, date overrides, timezone, and whether the venue is enabled for the intended date.
- **A shift is missing:** Confirm the current week or month, the shift's weekday or one-off date, whether it is paused, and any schedule filters. An opening-hour exception never creates a shift; plan a one-off shift for that date instead.
- **A user cannot take a shift:** The user needs staff or admin access, the shift must allow another person, and it must not have ended.
- **Someone does not see Venue settings or the section list:** Only admins see the settings and manage the public page; staff and read users get the page link only. Staff access allows shift work, not venue administration. Grant admin access only when that person should manage configuration.
- **An old link to a section opens something else:** Sections no longer have pages of their own. An old section link opens **Public page** with that section marked for admins, and the schedule for everyone else.
- **A public section is missing:** In **Public page**, check that the section's switch is on and it is not marked **Draft**, and that **Public page on** is on. The preview shows what visitors see. Also confirm that you are viewing the current venue's public page. With read access, the API and `cld venue sections list` return only the sections the public page shows.
- **Times look shifted:** Venue shows every time in the venue's time zone. The workspace names that time zone when your device runs in another one; check the venue's time zone if it looks wrong.
- **Feedback is absent:** Confirm that feedback is enabled and clear the current search, **Only with comment**, or the date-range filter. Older ratings are on later pages of the list. The Feedback view needs staff or admin access.
- **A calendar subscription is stale:** Calendar apps choose their own refresh interval. If the calendar stopped updating after someone renewed the link, open **My shifts** > **Subscribe to calendar** and subscribe with the current link.
- **The public page shows "Additionally open" instead of a shift name:** This is intended. Visitors see when staffing opens the venue, not the internal names of shifts.
:::

## Opening-status check {icon="point"}

:::steps
1. Check the venue timezone.
2. Review the weekly hours for the weekday.
3. Review any override for the exact date.
4. Open the public page rather than relying on an old browser tab.
:::

:::warning Public and calendar links
Public pages intentionally expose enabled public content. A personal calendar link shows your shifts to anyone who has it. If you shared it by mistake, use **Renew link** in **Subscribe to calendar**: the old link stops working at once.
:::
