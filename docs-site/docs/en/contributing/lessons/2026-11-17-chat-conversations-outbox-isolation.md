### Conversation fixtures left a shared Core outbox backlog

- **What happened:** The Chat conversations integration suite left Core live outbox rows in the shared test database. A later suite in the same shard had to dispatch those rows before delivering its own live events.
- **Root cause:** Fixture cleanup deleted Chat outbox rows before deleting grants, groups, service accounts, and users. Core triggers on those later deletes enqueued live rows that remained in the shared database.
- **Error class:** Outbox backlog shared between integration suites.
- **Guard:** Convention: suites whose bulk fixtures enqueue outbox work use `useMigratedDatabase()` before authorization setup and drop the private database in `afterAll`, including after test failures. Verify isolation by counting shared Core live outbox rows before and after the suite.
