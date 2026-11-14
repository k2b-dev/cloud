### A new Grids table left the migration inventory stale

- **What happened:** Grids certification failed its concurrent migration test after adding transactional record-event batch counts.
- **Root cause:** The migration created 57 tables, but the schema inventory assertion still expected 56.
- **Error class:** Stale schema assertions after adding a durable owner.
- **Guard:** `packages/grids/src/migrate.integration.test.ts`, “serializes concurrent setup and remains idempotent”, checks the updated table inventory and compares the schema before and after another migration.
