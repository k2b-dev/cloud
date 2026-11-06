### Pulse dashboards showed every time in UTC instead of the base's time zone

- **What happened:** A Pulse base set to `Europe/Berlin` showed its dashboard status line, chart axes, tooltips, last-good times, and the custom range picker in UTC, so a reader had to convert every time ("utc ist nicht praktisch").
- **Root cause:** The dashboard formatters and the picker hard-coded `timeZone: "UTC"` with a " UTC" suffix, although each base owns a time zone and its day buckets already use it; the published dashboard payload did not carry the zone at all.
- **Error class:** A view formats times in a fixed zone of its own instead of the zone the domain owner stores, so the view and the data's own buckets read different clocks.
- **Guard:** `dashboard-data.test.ts` fails when a dashboard source formats in UTC again and pins day and date buckets to midnight in the base zone, east and west of UTC and across the end of daylight saving time. `date-picker.render.test.tsx` requires an untouched draft to keep its exact instant in a repeated hour. `Dashboard.browser.test.ts` renders private and public dashboards with the browser in another zone and requires base-zone times and no "UTC" text.
