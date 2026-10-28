### Assistant sidebar test broke every gate

- **What happened:** From 2026-10-14, the Assistant sidebar behavior test failed on every gate run, also on `main`, and blocked the merge queue ([#1121](https://github.com/k2b-dev/cloud/pull/1121)).
- **Root cause:** The sidebar switches from the server's render time to the browser clock in `onMount`. The fixture chat had a fixed date, so 30 days later it moved from "this month" to "older".
- **Error class:** Time.
- **Guard:** The test sets the system time to the render time before each test. The `test-clock` check rejects new unpinned clock reads in UI tests and their fixtures, harnesses, and suites.
