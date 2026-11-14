### Child integration processes need their own bootstrap

- **What happened:** Running the Mail CLI integration file individually with its required preloads failed inside its child process because `auth.users` did not exist.
- **Root cause:** The parent spawned `bun test` without either preload. The child used the configured test target instead of creating its own migrated database and Mail runtime.
- **Error class:** A subprocess loses the integration bootstrap supplied to its parent.
- **Guard:** `cli.integration.test.ts` passes both the infrastructure preload and Mail preload explicitly to its child, without changing its existing timeout settings. The real CLI scenarios then run against that child's isolated schema.
