### A wildcard weekday planned only Sundays

- **What happened:** "My apps & automations" said "0 planned starts" on a Monday although an automation ran every 15 minutes from 07:00 to 19:45. The Code page's day line showed no planned marks either.
- **Root cause:** The shared cron parser (`packages/cloud/src/shared/cron-schedule.ts`) expanded `*` in day-of-week to 0 through 7 and folded 7 into Sunday, so the range collapsed to Sunday alone. `visitCronDaySlots`, which previews a day's starts, then matched no other weekday. The scheduler itself runs on its own cron engine, so the runs still happened.
- **Error class:** A field's wildcard reused the field's alias range (7 for Sunday) and lost every value but one.
- **Guard:** `cron-schedule.test.ts` plans `*/15 7-19 * * *` and `0 9 * * *` on a Monday, and checks that an explicit Sunday (0 or 7) still plans nothing that day.
