### Date display must not recreate ICU formatters for every row

- **What happened:** Switching Mail folders blocked the browser while replacing a 50-row page. Date display contributed to the work; it was only one of several costs.
- **Root cause:** `formatDate` constructed an Intl formatter on each call, and `formatDateTime` converted an instant through Dayjs timezone handling and `Date.toLocaleString` just to read its hour and minute. A Chromium A/B of the actual patch reduced median commit CPU from 197.3 to 179.7 ms over 12 warm switches per side (baseline range 158.0–259.5 ms; candidate range 141.7–329.4 ms); this alone did not meet the 50 ms Long Task goal.
- **Error class:** Repeating locale and timezone setup in a per-row display path.
- **Guard:** `src/dates.test.ts` bounds formatter construction across 100 rows with a unique locale key and checks reconstruction after eviction, rejects localized-string conversion in the display path, checks locale/zone isolation, and covers midnight, fractional-hour offsets and both DST transitions. Calendar arithmetic retains its separate implementation and tests.
