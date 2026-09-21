---
title: Testing
navTitle: Testing
section: Contributing
order: 1304
description: Run unit, render, and integration tests locally, and understand what the pull request gate and nightly run check.
tags: [contributing, testing, ci]
updated: 2026-09-21
---

# Testing

Cloud has two kinds of tests. Unit, render, and behavior tests run anywhere.
Integration tests need real infrastructure and run only when you point them at
it explicitly.

## Run the fast checks

```bash
bun run check
bun run test
```

`bun run check` verifies dependencies, import boundaries, package cycles,
service API contracts, localization, CSS architecture, formatting, the
application set, and every package typecheck. `bun run test` runs every
workspace in its own process and reports the integration files it skipped.

For one package:

```bash
bun run --cwd packages/grids typecheck
bun test packages/grids
```

## Run integration tests

Integration tests gate themselves on `CLOUD_TEST_*` variables through
`scripts/fixtures/test-infra.ts`, which is loaded as a `bun test` preload:

| Variable | Example |
| --- | --- |
| `CLOUD_TEST_DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5432/cloud_test` |
| `CLOUD_TEST_NATS_SERVERS` | `nats://127.0.0.1:4222` |
| `CLOUD_TEST_VALKEY_URL` | `redis://127.0.0.1:6379` (no database index) |
| `CLOUD_TEST_FILEGATE_URL` | `http://127.0.0.1:4000` |
| `CLOUD_TEST_GOTENBERG_URL` | `http://127.0.0.1:3001` |
| `CLOUD_TEST_RSQL_URL` | `http://127.0.0.1:8080` |

A suite runs when its variables are present and fails loudly when the target
is unreachable. When a variable is absent, the suite is skipped and the
matching runtime variables (`DATABASE_URL`, `NATS_SERVERS`, `REDIS_URL`, and
so on) point at a closed loopback port (`redis://127.0.0.1:1`,
`postgres://127.0.0.1:1/unset`, `nats://127.0.0.1:1`), so an ungated test that
reaches for infrastructure fails with a connection error instead of touching
the stack configured in `.env`.

Run integration tests through `bun run test`: it exports those runtime
variables into every test process before Bun starts, which is the only moment
Bun's default `redis` handle reads `REDIS_URL`. A direct `bun test` applies
them from the preload, too late for that handle; export `REDIS_URL` yourself
before running it. `tests/integration/test-infra-redis-binding.integration.test.ts`
proves the binding against a disposable Valkey on a non-default port.

The database name must end in `_test`. Integration tests create and delete
rows; the fixture refuses any other name. Never point them at the development
database.

```bash
CLOUD_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cloud_test \
CLOUD_TEST_NATS_SERVERS=nats://127.0.0.1:4222 \
CLOUD_TEST_VALKEY_URL=redis://127.0.0.1:6379 \
bun run test --integration
```

`--integration` first prepares the test database by running Core setup and every application migration (idempotent, a few seconds), then runs only the integration files, one fresh global per file. `--shard <n>/<total>` splits
the suites across parallel jobs, which is how the gate runs them; `--exclude <name>`
leaves out suites whose name or path matches, and `--filter <name>` keeps only those.

Suites that exercise sessions, tokens, or access against a real Core identity
authority additionally import `scripts/fixtures/authorization-preload` right
after the gate; it starts the authority only when database and NATS targets are
configured.

A new integration test needs no configuration of its own: import nothing
special, use the resolved runtime variables, and name the file
`*.integration.test.ts`.

## Request cache checks

The request-cache suites modify global settings and cache keys, so they run
through their own runner with disposable containers. See
[Verify request caches](/en/docs/contributing/request-cache-tests).

## What CI runs

The pull request `gate` runs `bun run check`, `bun run test`, the integration
suites against PostgreSQL 17, NATS JetStream, and Valkey, Grids certification,
and an image boot smoke when `packages/cloud` or the `Dockerfile` changed.
Run the same commands locally before opening a pull request.

The nightly workflow repeats the integration suites against PostgreSQL 15, the
oldest supported version, and runs the longer acceptance checks that are too
slow for every pull request.
