### Cancellation cannot depend on the pool it must release

- **What happened:** Disconnecting collaborative draft editors together could block Mail's database pool and prevent shutdown.
- **Root cause:** Every shared-draft transaction reserved an application connection. Its abort handler queued `pg_cancel_backend` on that same pool, then waited for cancellation before releasing its reservation. When every slot was reserved, cancellation and release waited on each other.
- **Error class:** Resource exhaustion deadlock in a cleanup path that acquires the resource it must release.
- **Guard:** The native PostgreSQL test `aborting every reserved connection settles both helpers, reuses the pool and closes it` in `packages/mail/src/service/draft-document-socket-sql.integration.test.ts` reserves every configured pool slot, aborts the helpers together, checks `pg_stat_activity` for idle transactions, reuses the pool and closes it. The local reproduction uses `CLOUD_DATABASE_POOL_MAX=2`. Cancellation uses a separate lazy control pool with at most one connection, closed after Mail's runtimes drain.
