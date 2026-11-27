### Pulse showed a moment of another day as a time alone

- **What happened:** The history of a Pulse source showed "09:00 (vor 38 Wochen)" for a source created in March. A fired alert from yesterday or a store that has been down since last night read the same way: a time without its day.
- **Root cause:** `compactDateWithDelta` in `packages/pulse/src/frontend/workspace/date-format.ts` always formatted the time of day. It was written for live states that start today and was later used for moments of any age.
- **Error class:** A date formatter that assumes "today" without checking it, and so drops the day for older moments.
- **Guard:** `compactDateWithDelta` compares the day in the base's time zone with today and adds the day when they differ. `date-format.test.ts` fixes the clock and checks today, a moment after midnight in the zone but before midnight in UTC, and a moment months ago.
