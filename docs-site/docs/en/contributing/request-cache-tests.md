---
title: Verify request caches
navTitle: Request cache tests
section: Contributing
order: 1315
description: Run isolated cache, session-policy, migration, and Valkey disconnect checks.
tags: [testing, cache, settings, identity]
updated: 2026-09-21
---

# Verify request caches

From the repository root, with Bun, workspace dependencies, and Docker available:

```bash
CLOUD_TEST_DATABASE_URL=postgres://…/<name>_test CLOUD_TEST_VALKEY_URL=redis://127.0.0.1:6379 bun test --preload ./scripts/fixtures/test-infra.ts packages/cloud/test/integration/request-cache
```

The runner starts disposable `postgres:17-alpine` and `valkey/valkey:8-alpine`
containers, pulling the images if needed. It publishes random loopback ports,
creates the required Core schemas through their real migrations, and runs each
suite in a separate process. It overrides database/cache URLs and the settings
encryption key with test-only values, excludes other application environment
variables, and disables automatic `.env` loading in child processes. Existing
development services and data are not used.

The same command runs in the pull request `gate` and in the nightly workflow. A failed migration or assertion
fails the command. Successful runs execute all five integration suites; they
must not report skipped tests.

The checks cover:

- Cache-fill leases, concurrent invalidation, and expired or superseded fills.
- Missing settings, local environment fallbacks, old JSON values, and cache
  clearing for registered Core and discovered application keys.
- Announcement mutation invalidation, scheduling, expiry, and cookie state.
- Live account-category policy and consolidated group projection semantics.
- Post-commit migration invalidation and preservation of existing overrides
  and migration receipts across restarts.
- Real TCP disconnection through a local proxy, database fallback, and cache
  reconnection/refill. The proxy removes the listening port and closes the
  established sockets; it does not close the client under test.

The disconnect probe reports how the default Bun Redis client behaves, then
asserts that the request-cache path completes within its test deadline. This
is a connection-loss check, not a latency benchmark or a simulation of a
half-open connection silently dropping packets.

## Isolation and cleanup

The individual suites remain opt-in because they modify global settings and
cache keys. Use the runner instead of setting `CLOUD_CACHE_TEST` against an
existing database. A plain `bun test` does not replace this integration job.

The runner removes its exact generated containers after success or failure.
If it is forcibly terminated, inspect and remove only that invocation's
`cloud-cache-test-<UUID>-pg` and `cloud-cache-test-<UUID>-redis` containers.
