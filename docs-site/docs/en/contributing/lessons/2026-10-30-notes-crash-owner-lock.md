### Restart checks wait for Postgres to release the crashed owner

- **What happened:** The Notes crash-after-commit integration test failed in CI with `notes_already_running`, although its child process had exited.
- **Root cause:** A process exit does not mean Postgres has observed EOF on every connection and released its session advisory locks. The successor raced that cleanup.
- **Error class:** A cross-process test treats local termination as confirmation that remote resource cleanup has completed.
- **Guard:** Both Notes crash tests acquire and release the database owner lock in a short transaction before starting the successor. A two-second database lock deadline stays inside the existing test budget; no test timeout is extended.
