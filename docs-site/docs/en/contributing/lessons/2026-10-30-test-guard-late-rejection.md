### Cancelling timed-out SQL produced an unhandled rejection between tests

- **What happened:** Integration hooks and tests timed out while PostgreSQL statements kept running. The fixture cancelled their work, then Bun reported a second, unhandled `57014` rejection between tests.
- **Root cause:** Bun stopped observing the timed-out async callback, so the guard's later database error escaped its original test boundary. Observing the same promise with an additional catch did not prevent Bun's report.
- **Error class:** Cancellation outlives the async owner that reports its failure.
- **Guard:** `tests/integration/test-infra-cancellation.integration.test.ts` forces active statements, a per-test hook, and an idle transaction past their callback deadlines. It verifies that timeouts remain failures, cancellation stays handled, ordinary SQL errors still fail, and the next test can use the database.
