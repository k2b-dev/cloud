### Start Spaces constraint queries before matching PostgreSQL errors

- **What happened:** The Spaces Code integration assertions passed lazy SQL queries to rejection matchers, which can wait without executing the query. The directory-lock assertion also matched the wrong error property.
- **Root cause:** Bun SQL queries need explicit execution when a rejection matcher observes native promise state. PostgreSQL SQLSTATE is exposed as `errno` rather than `code`.
- **Error class:** An integration assertion that does not execute its operation or identify its database error correctly.
- **Guard:** `packages/spaces/src/service/code-access.integration.test.ts` starts constraint queries with `.execute()`, matches SQLSTATE through `errno`, and verifies rejected admin grants leave Code permissions unchanged. Its directory-overlap case checks `55P03` and then verifies the Cloud-admin path can complete.
