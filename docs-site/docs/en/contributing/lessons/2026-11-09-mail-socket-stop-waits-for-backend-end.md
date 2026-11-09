### Wait for Postgres to end a cancelled backend before asserting its state

- **What happened:** The Mail socket stop test failed at random on main and in unrelated PRs (#3039): right after the socket stopped, the cancelled backend still showed `active` or `idle in transaction (aborted)` instead of `idle`.
- **Root cause:** The socket cancels the waiting statement and closes its reserved connection without waiting. Postgres ends that backend asynchronously, and the test read `pg_stat_activity` once, immediately.
- **Error class:** A test asserts on server-side state that another process changes asynchronously, with a single read.
- **Guard:** `expectTransactionEnded` in `draft-document-socket.integration.test.ts` (used by the delivery and the admission case) waits with a one-second deadline until the backend is gone or idle, then asserts as before. A backend that really stays in a transaction still fails the test.
