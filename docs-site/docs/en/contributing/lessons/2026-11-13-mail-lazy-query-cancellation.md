### Cancelling a lazy SQL query before starting it strands its transaction

- **What happened:** Mail socket tests sometimes finished their assertions but timed out while tearing down SQL, with an open transaction whose last statement acquired the draft coverage lock.
- **Root cause:** A socket could close between statements. Mail called `cancel()` on the next lazy Bun SQL query before starting it with `then()`, then awaited a query that never settled. The reserved connection could not reach rollback and release.
- **Error class:** Cancellation before asynchronous work starts leaves its owner waiting for a completion that cannot arrive.
- **Guard:** `awaitDraftDocumentQuery` rejects an already aborted signal without starting the query and starts other queries before registering cancellation. The real PostgreSQL regression tests in `packages/mail/src/service/draft-document-socket-sql.integration.test.ts` abort between statements and during execution and assert rollback and pool reuse. The real socket suite also asserts no idle transaction remains before fixture deletion.
