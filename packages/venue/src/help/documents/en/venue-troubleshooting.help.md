---
id: venue-troubleshooting
title: Troubleshooting
icon: ti ti-lifebuoy
description: Fix incorrect opening status, missing shifts, signup problems, public content, feedback, and calendar subscriptions.
order: 120
---

## Common symptoms {icon="lifebuoy"}

:::reference
- **The public page shows the wrong opening status:** Check regular hours, date overrides, timezone, and whether the venue is enabled for the intended date.
- **A shift is missing:** Confirm the current week or month, recurring template, and any schedule filters.
- **A user cannot sign up:** The user needs staff or admin access, the shift must allow another person, and the signup window must still be valid.
- **A staff member cannot change settings:** Staff access allows shift work, not venue administration. Grant admin access only when that person should manage configuration.
- **A public section is missing:** Confirm that the section is enabled and that you are viewing the current venue's public page.
- **Feedback is absent:** Confirm feedback is enabled and clear the current search or date-range filter.
- **A calendar subscription is stale:** Calendar clients choose their own refresh interval. Confirm the personal iCal URL is still valid before replacing it.
:::

## Opening-status check {icon="point"}

:::steps
1. Check the venue timezone.
2. Review the weekly hours for the weekday.
3. Review any override for the exact date.
4. Open the public page rather than relying on an old browser tab.
:::

:::warning Public and calendar links
Public pages intentionally expose enabled public content. Personal iCal links may expose assigned shift details to anyone holding the URL; replace or disable access if a link is shared unintentionally.
:::
