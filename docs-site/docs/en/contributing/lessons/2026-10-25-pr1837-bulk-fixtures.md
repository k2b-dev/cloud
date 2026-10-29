### Empty-table statistics survive a bulk fixture load

- **What happened:** Bounded share-access maintenance could repeatedly scan the full fixture backlog.
- **Root cause:** A concurrent ANALYZE saw uncommitted inserts as an empty table and left stale statistics after the bulk load.
- **Error class:** Empty-table statistics survive a bulk fixture load.
- **Guard:** Convention: [analyze bulk fixtures before measuring their queries](/en/docs/contributing/testing). Files `share-access.integration.test.ts` analyzes both 10,001-row backlogs and keeps the same shared budget assertions and default deadline.
