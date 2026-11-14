### Count complete tests at their shared admission boundary

- **What happened:** A transfer request budget could stop one fast test while allowing many slow tests, so it could not express a complete-test allowance.
- **Root cause:** Each stream request consumed the allowance independently of the measurement lifecycle.
- **Error class:** Accounting at the wrong unit of work.
- **Guard:** `admission.test.ts` covers rolling-window starts, canonical source networks, expiry, capacity and aggregate bytes. `server.test.ts` verifies that raw transfers require admission and hundreds of chunks consume one test start. `engine.test.ts` bounds admission inside the ping deadline.
