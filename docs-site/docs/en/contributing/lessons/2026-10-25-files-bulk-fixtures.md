# Files history checks

## Empty-table statistics survive a bulk fixture load

- **Class:** Empty-table statistics survive a bulk fixture load.
- **What goes wrong:** A concurrent ANALYZE sees uncommitted inserts as an empty table, so later bounded maintenance can use repeated full scans.
- **Guard:** Convention: [analyze bulk fixtures before measuring their queries](/en/docs/contributing/testing). Files `share-access.integration.test.ts` analyzes both 10,001-row backlogs and keeps the same shared budget assertions and default deadline.
- **Evidence:** The focused tests named above.
