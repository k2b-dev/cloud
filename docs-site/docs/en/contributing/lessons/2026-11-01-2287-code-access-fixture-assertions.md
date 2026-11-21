### Execute constraint queries and keep reader claims consistent in fixtures

- **What happened:** The Code access account-deletion test timed out, and an app-query manifest test expected a view after removing its reader query.
- **Root cause:** The rejection matcher observed an unstarted Bun SQL query. The manifest schema correctly removed the view claim when its reader was absent, but the fixture expected the full manifest's claim.
- **Error class:** Unstarted lazy promises in rejection assertions and fixture expectations that ignore dependent declarations.
- **Guard:** `packages/cloud/src/code/access.integration.test.ts` explicitly executes the DELETE and checks the live-grant foreign key's SQLSTATE and constraint. `packages/cloud/src/_internal/app-queries.test.ts` checks both the full manifest's view and its removal when the reader is missing. Start lazy queries before rejection assertions, as recorded in the earlier lazy-SQL lesson.
