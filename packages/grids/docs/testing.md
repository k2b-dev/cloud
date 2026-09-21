# Run all Grids tests

## Lightweight performance diagnosis

From the repository root, run `bun packages/grids/scripts/diagnostics.ts` with `CLOUD_TEST_DATABASE_URL`, `CLOUD_TEST_NATS_SERVERS`, and `CLOUD_TEST_GOTENBERG_URL` set.
It uses the same local PostgreSQL, NATS, Gotenberg and `PDFTOTEXT` prerequisites
as verification below, plus Docker with the local `valkey/valkey:8-alpine` image.
It reuses those services and starts one small, temporary Valkey cache. Settings
cache keys are global, so a separate database alone would mix diagnostic settings
with the development stack. It creates a disposable database; the configured
application database is never used for fixtures. The database, cache container and
diagnostic Sync namespace are removed afterwards, including after a worker timeout.

The runner measures three permission-aware GQL paths at 100 and 1,000 records,
five real Inventory issue-position workflows, two Billing invoice/PDF workflows,
and one further invoice with a concurrent GQL query and Inventory action. GQL has
one warmup and five serial samples per query and size, plus three setup validation
queries. Setup is outside the measured window. The
parent stops the diagnostic worker after three minutes of measured work; setup
also has a finite timeout. This is a small backend diagnosis, not a stress test
or a browser/gateway latency measurement.

The printed output directory contains `report.html`, `summary.md`, raw
`results.json`, environment details, process logs and the three verified PDFs.
Set `GRIDS_DIAGNOSTICS_DIR` to choose its parent directory. Reports retain all
individual timings, including warmups. GQL spans separate context, parsing,
resolution and execution; the diagnostic tracer does not persist production GQL
traces. Workflow records separate queue and execution time. Admission time can
overlap queue time, and control steps can contain child steps; do not add these
overlapping spans together.
PDF HTTP timing includes transport up to response headers, not only rendering.
The first PDF uses the existing renderer and is not a guaranteed cold start.
Median and range describe these small samples; they are not release thresholds.

## Full verification

From the repository root:

```bash
bun run --cwd packages/grids test:all
```

Use the Bun version in the root `packageManager` field. The command needs local
PostgreSQL with permission to create databases, NATS with JetStream, Valkey,
Gotenberg and Poppler's `pdftotext` executable. It reads the root `.env` and uses:

- `DATABASE_URL` for PostgreSQL;
- `REDIS_URL` for Valkey;
- `CLOUD_TEST_NATS_SERVERS` for NATS (for example `nats://127.0.0.1:4222`);
- `CLOUD_TEST_GOTENBERG_URL` for Gotenberg (for example `http://localhost:3001`);
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

The `workflow-concurrency` phase runs before other suites enqueue fixtures. It
checks ten shared execution/dry-run slots, an eleventh queued run, validation of
the setting, and a changed limit after restart. Ten simultaneous atomic writes
must finish with the expected records; saturating the effect pool must not
starve reference reads in the normal pool.

Worker acceptance includes bounded parallel claims while one action is blocked,
once-only effect charges, local and NATS wake notifications, recovery after a
lost notification, and stopping without new claims. Custom App status checks
revalidate actor and launcher access after waiting; client tests cover immediate
status reads and refreshing committed changes before the workflow finishes.
These behavior checks are release gates; laptop timing samples are diagnostic.
Record guards verify access and identity without reading unused values; deleted
records still fail. Document GQL failures retain their engine reason in the
operator log (`grids:documents`) while consumers receive the generic document
error. The focused integration tests cover both boundaries.

The separate `process-crashes` phase carries a finalized-record document workflow
through real child-process failures. It runs whenever `CLOUD_TEST_DATABASE_URL`,
`CLOUD_TEST_NATS_SERVERS`, and `CLOUD_TEST_GOTENBERG_URL` are set and refuses
databases outside its `grids_verify_` namespace.
It kills workers after number reservation, during artifact storage, after the
document commit and after a local HTTP receiver accepts an effect. A fifth worker
is suspended and resumed after another worker takes over, before the new owner
renders its document. Two fresh workers race
to recover each run after the real 120-second lease expires.

Acceptance checks immutable finalization, one number and document, PDF contents
and artifact hashes, atomic storage rollback, repeated and independent invocation keys, delivery
of the committed finalization event and no repeated HTTP effect. An interrupted
HTTP response must produce `needs_attention`. The test retains worker logs, PDFs,
and a JSON result in the printed `grids-crash-*` directory. Its HTTP transport is
routed to a disposable loopback receiver; production network restrictions remain
covered by the HTTP client tests.

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

`bun test` without `CLOUD_TEST_*` is the fast subset, not proof that integrations
pass. With `CLOUD_TEST_DATABASE_URL` set, `bun test` and `test:coverage` use that
database directly; its name must end in `_test`.

Linting, coverage measurement, load tests and
[visual browser checks](browser-regression-checklist.md) are separate checks.
Process-crash acceptance covers this document workflow and its declared failure
boundaries. It does not prove recovery from database or broker outages, every
workflow, or a complete backup restoration. Restore acceptance remains a separate
check against disposable infrastructure, including durable data and document files.
