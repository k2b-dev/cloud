### A transaction that swallowed a failed statement reported success

- **What happened:** On Bun 1.4.4, restoring a Grids table into a name conflict and a failed workflow query capture rejected with `ERR_POSTGRES_COMMIT_ROLLED_BACK` instead of returning their conflict or input errors.
- **Root cause:** Both caught a failed statement inside `sql.begin` and returned a result, so `COMMIT` ran on an aborted transaction. Postgres rolled it back, and Bun before 1.4.3 did not report that. Table restore lacked the savepoint its siblings use, and the capture committed its failed read snapshot.
- **Error class:** A recoverable statement failure inside a transaction without a savepoint or a rollback.
- **Guard:** Since Bun 1.4.3 such a `COMMIT` rejects, so `named-refs.integration.test.ts` and `workflow-query-data.integration.test.ts` fail on this mistake, as does any integration test that reaches the same pattern.
