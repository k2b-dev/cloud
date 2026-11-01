### A finished cancellation response can still occupy an admission slot

- **What happened:** Pulse maintenance sometimes returned `MAINTENANCE_BUSY` when replacing a query that `KILL QUERY ... SYNC` had already stopped. The server integration test failed on an unrelated CSS pull request.
- **Root cause:** ClickHouse counts the same-user KILL request toward `max_concurrent_queries_for_user`. Its HTTP response can finish before its own process entry is removed. A `finished` target cancellation therefore does not prove that the user's execution slot is available for the replacement.
- **Error class:** A control response was mistaken for completion of server admission cleanup.
- **Guard:** `packages/pulse/src/store/maintenance-server.integration.test.ts` deterministically returns code 202 after a finished KILL response, then admits the replacement. It verifies that the lease remains held and the execution budget decreases. Further cases cover the original admission deadline, cancellation, unconfirmed termination and ambiguous HTTP failures. Only explicit admission refusals are retried; uncertain execution is never replayed.
