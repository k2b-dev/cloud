### Closing the SQL meter left live rows claimed, and grant changes missed the socket test's deadline

- **What happened:** In the Mail document socket integration test, a revoked grant and a removed assignment did not close the open socket within 5 s. Every later test in the file failed with `Access denied`, because the first test puts the fixture grant back only at its end (#3941).
- **Root cause:** The SQL budget test opened and closed `meterSql()` while the Mail live outbox ran. Each rebind closes the platform pool. An outbox pass that had already claimed and published its rows lost its connection before the `DELETE` ("Outbox reconcile failed: Connection closed"). The rows stayed claimed for 30 s, and the busy-key probe held every later row of `room.access:<mailbox>` behind them.
- **Error class:** A test fixture swaps a shared resource of the process (here the database pool) while background work still uses it, and the work fails between two statements of one step.
- **Guard:** The socket test stops the live outbox around both rebinds and checks that no Mail live row is still claimed while the outbox is stopped. The `sql-meter.ts` header names the rule for every other caller.
