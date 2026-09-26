---
title: Testing
navTitle: Testing
section: Contributing
order: 1304
description: Run unit, render, and integration tests locally, and understand what the pull request gate and nightly run check.
tags: [contributing, testing, ci]
updated: 2026-09-26
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
bun run test --filter packages/grids
```

## Write behavior tests

A behavior test renders Solid components into a
[happy-dom](https://github.com/capricorn86/happy-dom) document and drives them
like a user. Name it `*.behavior.test.ts` or `*.behavior.test.tsx` and put it
anywhere in a workspace package. `bun run test` finds every such file and runs
each package's behavior tests in a suite of their own, `<package> behavior`,
with browser conditions and the Solid DOM preload
(`packages/ui/test/solid-dom-preload.ts`), started from the repository root so
a package's server-rendering preload does not apply. Package `test` scripts
leave these files out with `--path-ignore-patterns '**/*.behavior.test.*'`.

To run one file directly:

```bash
bun --no-env-file test --isolate --conditions=browser \
  --preload ./packages/ui/test/solid-dom-preload.ts \
  ./packages/core/src/pages/admin/CacheNotice.behavior.test.ts
```

Guard browser-only tests with `isServer` from `solid-js/web`, so a plain
`bun test` skips them instead of failing. `bun run check` fails when a test
that branches on `isServer` is not named `*.behavior.test.*`, or when the
runner would not pick up a behavior test.

Import heavy components once at module scope, not inside the first test: the
first import runs the Solid transform over the component's source graph, and
that time otherwise counts against the 5 s test timeout.

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

The ports are the development stack's defaults. If you moved them with
`CLOUD_DEV_POSTGRES_PORT`, `CLOUD_DEV_VALKEY_PORT`, or `CLOUD_DEV_NATS_PORT`
([Change host ports](/en/docs/operations/monorepo-development#change-host-ports)),
use the same ports here.

A suite runs when its variables are present and fails loudly when the target
is unreachable. When a variable is absent, the suite is skipped and the
matching runtime variables (`NATS_SERVERS`, `GOTENBERG_URL`, and so on) are
removed, because unset is the off switch for those clients. `DATABASE_URL` and
`REDIS_URL` instead point at a closed loopback port
(`postgres://127.0.0.1:1/unset`, `redis://127.0.0.1:1`): Bun's default `sql`
and `redis` handles would otherwise dial `localhost`, so an ungated test that
reaches for them fails with a connection error instead of touching the stack
configured in `.env`.

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
