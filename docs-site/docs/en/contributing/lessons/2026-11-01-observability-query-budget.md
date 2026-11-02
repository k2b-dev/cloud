### Diagnostics must not scan unlimited history after the caller leaves

- **What happened:** An observability page exceeded the gateway response timeout while its SQL continued running for more than 58 seconds.
- **Root cause:** Retained-row and source counts scanned whole logging tables, the stuck-span count removed its time filter, and readers had no server-side cancellation tied to the HTTP request.
- **Error class:** Unbounded diagnostic reads and orphaned database work.
- **Guard:** `logging/read.integration.test.ts` exercises public readers over 100,001 historical rows and cancels a running PostgreSQL query through an aborted HTTP request, then verifies the backend is idle and the pool remains usable.
