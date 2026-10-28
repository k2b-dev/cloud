### Private integration schemas omit a new identity table

- **What happened:** Filesv2 integration tests failed with `relation "auth.personal_groups" does not exist`, blocking merge queue checks.
- **Root cause:** Filesv2 creates a private empty database for each integration file. Its hand-written POSIX tables bypassed the Core migration that creates durable personal-group ownership, which account identity inventory now queries. The shared integration bootstrap migrates a different database.
- **Error class:** A private integration fixture copies a dependency schema and drifts from the code under test.
- **Guard:** All Filesv2 fixtures with POSIX identity data and the account identity fixture run Core's real `migratePosix()` migration. Existing inventory, version deletion, and trash deletion tests exercise the queries against these private databases; the identity tests also exercise the production ownership trigger. Local POSIX seeds satisfy the real constraints, and per-test resets clear durable ownership rows.
