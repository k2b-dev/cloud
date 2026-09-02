---
title: Verify identity performance
navTitle: Identity performance
section: Contributing
order: 1310
description: Compare legacy and JWT search latency with real authentication and database access.
tags: [identity, jwt, performance, testing]
updated: 2026-09-03
---

# Verify identity performance

Use the repository benchmark to check whether JWT authentication and delegated
search stay within the agreed latency budget. A passing crypto microbenchmark
alone does not establish this: the active-key transaction and current-user
queries must also run.

## Run the isolated benchmark

From the repository root, with dependencies installed and Docker running:

```bash
bun scripts/bench-identity.ts
```

The runner requires the existing local images `cloud-app-core:latest`,
`postgres:15-alpine`, and `valkey/valkey:8-alpine`. It never pulls images or
starts the development stack. The Core image supplies Bun; a read-only mount
supplies the current working tree, including uncommitted code.

Three temporary containers share one offline network namespace. PostgreSQL
uses temporary in-memory storage; Redis persistence is disabled. No host port
is published, and no development database, Redis key, or running Cloud service
is modified. Normal completion and assertion failures remove these containers.
If the runner is forcibly terminated, inspect and remove only the containers
with that run's exact `cloud-identity-bench-<UUID>` prefix.

The output directory contains:

- `environment.json`: image IDs, source revision, and topology;
- `report.json`: raw samples, percentiles, query counts, stage timings, and the
  acceptance result. Incomplete runs are marked `completed: false` and cannot
  establish acceptance.

Keep the artifacts from every measured run, including failures. Retain the
working-tree diff alongside the source revision when testing uncommitted code.

## Understand the measurements

The default run takes 200 samples per mode for each of six cases: dispatcher
and end-to-end search with 1, 8, and 30 providers. Each case has 20 warm-up pairs.
Legacy and JWT run alternately, reversing their order on each pair. A shorter
smoke test can use `IDENTITY_BENCH_SAMPLES=20`; do not use it for acceptance.

Both modes use the real search router and authentication implementation. Legacy
uses the current compatibility branch with an opaque session and forwarded
credential. JWT uses a real session family, current-actor query, guarded signing
transaction, and target-bound invocation tokens. This is a same-checkout
comparison, not a measurement of a historical release binary.

| Case | Included work |
| --- | --- |
| Dispatcher | HTTP into Core, authentication, signing guard, token creation, request construction, validation, and merging; provider work returns immediately. |
| End-to-end | All dispatcher work plus HTTP to providers, real target authentication and current-user queries, and 5 ms of controlled provider work. |
| Crypto microbenchmark | Cached production RS256 signing and verification, measured separately without the database guard. |

Every provider must contribute one valid merged resource; an error or omitted
provider cannot masquerade as a faster result. Provider concurrency remains
bounded at eight. The benchmark uses fixed in-memory discovery and shared-process
HTTP handlers, not separate deployed application processes. Real domain queries,
gateway routing, production load, and cross-host network latency are outside its
scope.

This is explicitly a warm-cache check. It refreshes the real signer and runtime
configuration caches outside timed requests every 30 seconds, before their
60-second expiry. It does not discard slow samples or retry failed measurements.
Cold starts, cache refresh costs, and rotation require separate operational
observations. Stage timings are diagnostic: guarded signing includes the signing
batch, so those durations must not be added together.

## Apply the acceptance gate

For **every** provider count and both search cases:

```text
JWT p95 - legacy p95 <= max(legacy p95 × 0.10, 10 ms)
```

Percentiles use nearest rank without rounding before comparison or removing
outliers. The runner exits unsuccessfully when any case exceeds the bound or an
I/O assertion fails. For acceptance, run three independent full runs on the
same unchanged checkout and require all three to pass; never select only the
best run. A failed run leaves the performance gate open.

PostgreSQL protocol instrumentation checks every measured request. Redis client
observers are independently checked against Redis server command counters;
telemetry reads happen outside the timed interval.
Asynchronous writes to `logging.entries`, such as the periodic legacy-use
notice, are counted separately from request identity queries. Logging remains
enabled and its timing effects are not removed from the samples.

| JWT work | Required measured count |
| --- | --- |
| Core session and actor resolution | One PostgreSQL query |
| Shared signing guard | One `BEGIN`, one transaction-local timeout statement, one active-key query, one `COMMIT` |
| Target authentication | One current-user query per provider in the end-to-end case |
| Mandate queries, Redis session reads, and warm JWKS requests | Zero |
| Per-provider signing queries or network requests | Zero |

The signing guard is constant per search, not zero-cost: its four database
commands are included in the gate. If a run fails, inspect the raw samples,
authentication/signing stages, and host load before changing the implementation.
Do not weaken revocation, remove the database timeout, or relax the threshold to
obtain a pass. A local pass is not a production latency guarantee or permission
to remove compatibility paths. Deployment verification still follows
[Identity key operations](/en/docs/operations/identity-key-operations).
