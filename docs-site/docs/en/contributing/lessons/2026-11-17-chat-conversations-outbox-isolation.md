### Integration fixtures left a shared Core outbox backlog

- **What happened:** The Chat conversations integration suite left Core live outbox rows in the shared test database. A later suite in the same shard had to dispatch those rows before delivering its own live events.
- **Root cause:** Fixture cleanup deleted Chat outbox rows before deleting grants, groups, service accounts, and users. Core triggers on those later deletes enqueued live rows that remained in the shared database.
- **Error class:** Outbox backlog shared between integration suites.
- **Guard:** Convention: suites whose bulk fixtures enqueue outbox work use `useMigratedDatabase()` before authorization setup and drop the private database in `afterAll`, including after test failures. Verify isolation by counting shared Core live outbox rows before and after the suite.

The original conversations suite left 70,794 Core live rows after cleanup.
The same measurement found 1,636 rows after Chat notification delivery, 313
after Spaces assignee presentation, and 150 after notification batch claims.
Each suite now uses its own migrated database.

A global teardown assertion that the shared outboxes are empty cannot attribute
rows to a suite: other processes may use that database, dispatchers may consume
existing rows, and the outbox also holds future-dated invalidations. A count
delta can therefore miss a leak or blame another process. A reliable common
guard needs suite ownership or exclusive database use; this change keeps the
existing fixture model and documents the isolation convention in the testing
guide.
