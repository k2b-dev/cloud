### A streaming deadline expired during connection setup

- **What happened:** The slow-response transport test failed before obtaining its response on a busy runner.
- **Root cause:** Its 80 ms caller deadline included connection setup, so it did not reliably reach the body-read assertion.
- **Error class:** Test deadline expires before the asserted boundary.
- **Guard:** `allowed-network-fetch.test.ts` starts the same caller deadline after headers arrive and forwards its original timeout reason to the in-flight request. The server continues sending bytes until cancellation; neither the deadline nor the test timeout is increased.
