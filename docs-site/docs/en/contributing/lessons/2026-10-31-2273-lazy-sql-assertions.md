### Start lazy SQL queries before asserting their rejection

- **What happened:** An approval constraint test timed out after 30 seconds and left its file waiting during cleanup, although the other cases passed.
- **Root cause:** Bun SQL queries are lazy Promise subclasses. Bun's rejection matcher waited for the native promise without starting the query. An in-memory SQLite reproduction confirmed `query.active` remained false until explicit execution; explicit execution started it and delivered the constraint error immediately.
- **Error class:** Passing an unstarted lazy promise to an assertion that observes native promise state.
- **Guard:** The recipient and confirmation constraint test in `packages/cloud/src/services/approvals/code-version.integration.test.ts` starts each SQL query with `.execute()` and checks PostgreSQL SQLSTATE `23514`, then verifies the row remains unchanged. Convention: start lazy SQL queries before passing them to rejection matchers.
