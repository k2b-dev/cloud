---
title: Verify request caches
navTitle: Request cache tests
section: Contributing
order: 1315
description: Run isolated cache, session-policy, migration, and Valkey disconnect checks.
tags: [testing, cache, settings, identity]
updated: 2026-09-29
---

# Verify request caches

The request-cache suites need the test database and the test Valkey
([Run integration tests](/en/docs/contributing/testing#run-integration-tests)).
From the repository root:

```bash
export CLOUD_TEST_DATABASE_URL=postgres://…/<name>_test CLOUD_TEST_VALKEY_URL=redis://127.0.0.1:6380
bun run test --integration --filter cache
bun run test --integration --filter settings/store
```

The runner prepares the test database through the real Core and application
migrations, then runs each of the six suites in a process of its own, without
the checkout's `.env`. The pull request `gate` and the nightly workflow run
them as part of `bun run test --integration`. A failed migration or assertion
fails the command; with both variables set, no suite may report skipped tests.

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

## Isolation

The suites modify global settings and cache keys, so they run only against
the test database and the test Valkey, never against the development
services. The fixture refuses a database whose name does not end in `_test`;
point `CLOUD_TEST_VALKEY_URL` at the test Valkey, not at the stack's.
