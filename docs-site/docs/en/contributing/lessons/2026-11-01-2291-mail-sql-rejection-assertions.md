### Execute SQL before testing database rejections

- **What happened:** One Mail integration case timed out before checking its database constraint; a directory-lock case rejected with the expected error but failed its assertion.
- **Root cause:** Bun SQL queries are lazy Promise subclasses. A rejection matcher does not start them. Bun reports PostgreSQL SQLSTATE in `errno`, rather than `code`.
- **Error class:** Observing an unstarted lazy query and matching a database error through the wrong driver property.
- **Guard:** The Mail Code-access integration file executes both constraint queries explicitly, matches SQLSTATE `23514` and `55P03` through `errno`, and verifies the last mailbox administrator remains protected. The directory overlap case must complete grants and removal while its writer transaction remains open.
