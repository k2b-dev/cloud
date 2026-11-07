### Query cancellation leaves a reserved transaction blocked

- **What happened:** Socket cleanup cancels its current SQL query but still waits for a row lock held by another transaction.
- **Root cause:** Cancelling a query did not close the transaction’s reserved connection while another transaction held its row lock.
- **Error class:** Query cancellation leaves a reserved transaction blocked
- **Guard:** Mail `api/draft-document-socket.integration.test.ts` holds the row through stop, checks bounded shutdown, confirms rollback through `pg_stat_activity`, and keeps the holder connection usable. Abort closes only the owned reservation and awaits its transaction before release.
