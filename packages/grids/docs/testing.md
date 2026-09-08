# Run all Grids tests

From the repository root:

```bash
bun run --cwd packages/grids test:all
```

The command needs local PostgreSQL with permission to create databases and local
NATS with JetStream. It reads `DATABASE_URL` from the root `.env` and uses
`SYNC_TEST_SERVERS` (default: `nats://127.0.0.1:4222`). Remote hosts are rejected.

The runner creates a temporary database, migrates it, and seeds a synthetic user.
It never runs tests against the database named in `DATABASE_URL`. It removes its
temporary database after success or failure; Sync tests use disposable namespaces.

Every phase must pass without skipped tests: the database-wide outbox tests run
first, followed by the remaining standard and DB tests, Sync tests, isolated
recovery/cleanup tests, and the DOM interaction test. The DOM phase uses the shared
Solid preload; it does not launch a browser. JUnit reports remain in the temporary
`grids-verification-*` directory printed with failures.

`bun test` is the fast subset, not proof that integrations pass. `test:db` and
`test:coverage` use the configured database directly; use only a disposable test
database for those commands.

Typechecking, linting, coverage measurement, load tests, external PDF rendering,
and [visual browser checks](browser-regression-checklist.md) are separate checks.
