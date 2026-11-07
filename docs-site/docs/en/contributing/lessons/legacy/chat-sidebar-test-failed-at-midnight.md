### Chat sidebar test failed at midnight

- **What happened:** The merge queue failed around 22:00 UTC, or 00:00 Europe/Berlin, on 2026-10-15 and 2026-10-17. The sidebar geometry test saw a time label shrink from 45 to 27 pixels ([#1209](https://github.com/k2b-dev/cloud/issues/1209)). [#1404](https://github.com/k2b-dev/cloud/pull/1404) left the queue.
- **Root cause:** Fixtures, initial props, and page code read the real clock separately. Around Berlin midnight, `listTime` compared different calendar days and changed the label width.
- **Error class:** Time.
- **Guard:** The Chat harness stamps fixtures from a flowing clock anchored at `chatTestNow`. Each page gets a `Date` that starts at that clock, and behavior tests pin the process clock. The `test-clock` check rejects new clock reads across UI tests and their fixtures, harnesses, and suites. Durations use `performance.now()`.
