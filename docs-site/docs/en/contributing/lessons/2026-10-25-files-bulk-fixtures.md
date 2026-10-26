### Empty-table statistics survive a bulk fixture load

- **What happened:** Bounded maintenance can use repeated full scans after a bulk fixture load.
- **Root cause:** A concurrent `ANALYZE` sees uncommitted inserts as an empty table, so later queries use stale statistics.
- **Error class:** Empty-table statistics survive a bulk fixture load.
- **Guard:** Convention: [analyze bulk fixtures before measuring their queries](/en/docs/contributing/testing). Files `share-access.integration.test.ts` analyzes both 10,001-row backlogs and keeps the same shared budget assertions and default deadline.
