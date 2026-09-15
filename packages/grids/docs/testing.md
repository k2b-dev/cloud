# Run all Grids tests

From the repository root:

```bash
bun run --cwd packages/grids test:all
```

Use the Bun version in the root `packageManager` field. The command needs local
PostgreSQL with permission to create databases, NATS with JetStream, Valkey,
Gotenberg and Poppler's `pdftotext` executable. It reads the root `.env` and uses:

- `DATABASE_URL` for PostgreSQL;
- `REDIS_URL` for Valkey;
- `SYNC_TEST_SERVERS` for NATS (default: `nats://127.0.0.1:4222`);
- `GRIDS_PDF_URL` for Gotenberg (default: `http://localhost:3001`);
- `PDFTOTEXT` for an optional executable path (default: `pdftotext` on `PATH`).

The runner rejects remote PostgreSQL, NATS and Gotenberg URLs. It checks database,
JetStream and renderer readiness before creating the test database. Missing
infrastructure fails verification.

Use dedicated test services when the development stack is busy. CI supplies its
own services and uses the same PostgreSQL limit of 300 connections as the
repository's Compose files. Separate test databases do not isolate connection
capacity from other applications using the same PostgreSQL instance.

The runner creates a temporary database, migrates it, and seeds a synthetic user.
It never runs tests against the database named in `DATABASE_URL`. It removes its
temporary database after success or failure; Sync tests use disposable namespaces.

Every phase must pass without skipped tests. The runner includes the shared
workflow store and runtime tests, database-wide outbox tests, remaining standard
and DB tests, Sync tests, evidence exports, browser bundling, real PDF rendering
and text extraction, isolated recovery/cleanup tests, and DOM interaction tests.
The DOM phase uses the shared Solid preload; it does not launch a browser.

Each phase retains JUnit and complete process logs, including module-load errors.
The printed `grids-verification-*` directory also records the commit, dirty state,
lockfile hash and runtime versions in `environment.json`. Set
`GRIDS_VERIFY_REPORTS_DIR` to choose the parent directory. Reports remain after
success or failure.

## Release gate

The `Grids certification` workflow runs the same command and an unfiltered Grids
typecheck on pull requests affecting Grids or its shared dependencies. It retains
reports and logs as a workflow artifact. The shared workflow database tests use
`CLOUD_DATABASE_TEST=1`; with this flag, database setup errors fail the tests.
The full runner sets this flag automatically and rejects skipped tests.

The Docker workflow calls certification from the same commit whenever its image
selection contains Grids. No image in that selection is published unless
certification succeeds. A failed, cancelled or unexpectedly skipped certification
blocks that release. Releases selecting only other applications do not run it.

`bun test` is the fast subset, not proof that integrations pass. `test:db` and
`test:coverage` use the configured database directly; use only a disposable test
database for those commands.

Linting, coverage measurement, load tests and
[visual browser checks](browser-regression-checklist.md) are separate checks.
Passing certification does not prove recovery after a process crash or a complete
backup restoration. Those require separate acceptance runs against disposable
infrastructure, including durable data and document files.
