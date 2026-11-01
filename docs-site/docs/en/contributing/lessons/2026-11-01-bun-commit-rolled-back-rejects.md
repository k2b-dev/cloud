### A transaction that swallowed a failed statement reported success

- **What happened:** On Bun 1.4.4, restoring a Grids table into a name conflict and a failed workflow query capture rejected with `ERR_POSTGRES_COMMIT_ROLLED_BACK` instead of returning their conflict or input errors.
- **Root cause:** Both caught a failed statement inside `sql.begin` and returned a result, so `COMMIT` ran on an aborted transaction. Postgres rolled it back, and Bun before 1.4.3 did not report that. Table restore lacked the savepoint its siblings use. Document capture, the custom-app document preview, and the workflow check before an HTTP action turned a caught SQL error into a result inside their transaction.
- **Error class:** A recoverable statement failure inside a transaction without a savepoint or a rollback.
- **Guard:** Since Bun 1.4.3 such a `COMMIT` rejects, so any integration test that reaches this pattern fails. `transaction-rollback.ts` lets a transaction owner roll back and return its result, and `transaction-rollback.integration.test.ts` covers each owner. Other existing cases are tracked in the issue linked from the pull request.
