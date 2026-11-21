### A frozen test clock expired against the real Postgres clock

- **What happened:** The Code bridge integration suite passed in the morning and failed for every pull request from 12:05 UTC on 1 November 2026.
- **Root cause:** The test froze JavaScript time at a fixed date close to today, while the SQL fences it exercised compare token expiry and retention with `clock_timestamp()`. Five minutes after the fixed date, the token had expired for Postgres.
- **Error class:** A test compares a frozen application clock with a real database clock, so its result depends on the day it runs.
- **Guard:** `packages/cloud/src/code/bridge.integration.test.ts` starts its frozen clock from the real time of the run, marked `// real clock:`. No check can tell which SQL a test reaches, so this stays a review convention for tests that freeze time around database clocks.
