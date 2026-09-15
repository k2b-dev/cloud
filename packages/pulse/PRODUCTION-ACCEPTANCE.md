# Pulse alpha cut: production acceptance

This is the maintainer evidence for the alpha hard cut, recorded on 2026-09-15.
Pulse has not been deployed. All destructive checks used disposable local databases.
The existing development installation was not reset.

## Deployment decision

**Do not deploy Pulse with Bun 1.3.14.** The real HTTP
probe reproduced PostgreSQL decoder failures, wrongly shaped query results, and
stalled requests under concurrent reads and writes. These match the upstream
[Bun SQL pipelining defect](https://github.com/oven-sh/bun/issues/33665).
The [upstream fix](https://github.com/oven-sh/bun/pull/33627) is included in Bun
1.4.2. An isolated Bun 1.4.2 run passed the same HTTP workload. No JSON parser
fallback was added to hide incorrectly decoded results.

Cloud's shared Docker, CI, and package-manager pins have since been updated
to Bun 1.4.2. The Bun 1.3.14 results below remain historical comparison evidence.
The Pulse query readers also establish repeatable-read, read-only isolation
in `BEGIN`, rather than issuing a separately prepared `SET TRANSACTION`.

## Confirmed workload and explicit assumptions

The intended initial fleet is 20–50 servers and approximately 10 websites,
with 60-second sampling and 30-day raw retention. Website backends send to
source-bound authenticated ingest; there is no anonymous browser collector.

The measured scenario uses 50 server sources, 20 gauge series per server,
and 10 website sources with 10 events per website per minute. The series count
and website event rate are test assumptions, not product limits or confirmed
traffic estimates. This gives 1,000 series and 60 distinct resources.

At that assumed continuous rate, 30 days would contain 43.2 million metric
samples and 4.32 million website events. Those are arithmetic projections;
the short HTTP run does not prove the latency or storage cost of that dataset.
Counter/reset semantics, retained hourly history, and lifecycle behavior have
separate integration coverage.

## Environment

- Host: Apple M1 Max, 10 CPUs, 64 GiB RAM; Docker Desktop, shared with other work.
- Application: actual production server and 17 browser bundles, built with the
  repository build command; isolated local proxy and Core session/JWKS authority.
- Runtime comparison: Bun 1.3.14 (`0d9b296a`) and Bun 1.4.2 (`744846f84`).
- Fixed runtime archive SHA-256:
  `90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f`.
- PostgreSQL 17.6 with TimescaleDB 2.23.1; Valkey 8; NATS 2.14.3 JetStream.
- Separate databases: `pulse_schema_test`, `pulse_analytics_test`,
  `pulse_runtime_test`, `pulse_load_test`, and `pulse_volume_test`.
- Sources, credentials, user sessions, and telemetry were synthetic local fixtures.

## HTTP acceptance result

Run `84b37ec0-6cec-497f-95ea-ed08748fac28` on Bun 1.4.2 lasted 159.7 seconds
for three scheduled 60-second cycles and a bounded overload/recovery phase.
The concurrent query profile combines metric averages, event counts in Berlin
calendar days, and unique actors. Every successful response was parsed against
the API result schema. Final absolute-interval queries additionally checked
counts and unique identities against the known fixture, plus the latest metric
value against SQL. Other fixture event kinds are excluded from the probe counts.

| Check | Result |
| --- | --- |
| Normal ingest | 180/180 HTTP 200 responses |
| Complete fleet cycle durations | 46.35 s, 59.97 s, 28.68 s |
| Concurrent queries | 201/201 HTTP 200 responses |
| Bounded burst | 58 accepted; 62 rejected with HTTP 429 |
| Recovery after burst | HTTP 200 in 27 ms |
| Accepted vs committed metric samples | 3,960 = 3,960 |
| Accepted vs committed events | 420 = 420 |
| Identical idempotent replay | 200, no duplicate events |
| Same key with changed body | 409 |
| Missing and invalid credentials | 401, 401 |
| Source identity injected in payload | 400 |
| Series and resources after the run | 1,000 and 60, asserted |
| Final event count | 420, matching the accepted events |
| Final source-local visitors and sessions | 100 each |
| Latest CPU value | Matches the stored SQL value |

| HTTP operation | p50 | p95 | p99 |
| --- | --- | --- | --- |
| Normal ingest batch | 3.71 s | 18.36 s | 25.37 s |
| Mixed metric/analytics query | 846 ms | 2.82 s | 5.52 s |
| Burst, including rejected requests | 236 ms | 7.60 s | 9.07 s |

During the earlier HTTP run, sampled application RSS was approximately 174 MiB, with the Timescale
container using approximately 490 MiB. These are observations, not measured
peak memory or production resource recommendations. Query tail latency is
material on this shared development machine and must be rechecked on the
intended deployment host with its actual series counts and accumulated data.
One cycle used nearly the entire 60-second interval. This run establishes no
reliable capacity headroom; it is a functional acceptance result, not a fleet
capacity guarantee.

The reusable probe is `scripts/http-load.ts`. It requires a loopback application,
`DATABASE_URL` ending in `pulse_load_test`, and `PULSE_LOAD_FIXTURE` pointing to
an owner-only temporary JSON file. That file contains the test URL, a test-user
cookie, the base UUID and short ID, and exactly 60 source descriptors
(`id`, `token`, `kind`, `index`). Keep it outside Git and remove it after testing.
The probe never prints fixture credentials. Run it with the same Bun version
as the application.

## Separate SQL volume result

A bounded run with 100,000 events completed. It contained 100,000 distinct
actors, sessions, and IP hashes. Direct SQL seeding of the 99,500 rows after the
writer seed took 42.6 seconds (2,335 rows/second). This is **not HTTP ingest
throughput**. Table and index storage together occupied 104,964,096 bytes.
Grouped event-count p95 was 848 ms; unique-actor p95 was 2,863 ms, with five
measured repetitions after warm-up.

Reducing raw retention from 30 days to one day converged in two batches over
42.1 seconds, leaving 3,813 events, of which 635 retained sensitive fields.
The Pulse Valkey key count stayed at zero. A 1,000-event smoke run also passed.

A separate ten-million-event attempt was stopped after approximately 14 minutes
while still seeding; statistics estimated approximately 894,000 committed rows
at that point. That estimate is not an exact count or a completed benchmark.
The guarded disposable volume schema was then reset for the bounded run above.
Neither run proves the full projected 30-day dataset or production resource needs.

## Verified boundaries

- Fresh installation is transactional and serialized; failed installation rolls
  back; old populated alpha schemas fail explicitly without data modification.
- Resource/source identity, JSON primitives, immutable metric type/unit,
  idempotency, disabled/foreign source checks, and ordered state transitions.
- Counter reset correction, predecessor boundaries, observed elapsed time,
  single-connection scraper execution, timeout/body budgets, and exact cadence.
- Real NATS retry after a rolled-back write, at least 29 seconds between attempts,
  repeated catch-up for three hours older than 48 hours, and active-scrape drain.
- Timescale chunk-safe clear/delete, dirty/clean/sealed hour lifecycle,
  raw/rollup boundary selection, catalog pruning, and writer/retention races.
- Exact event intervals, calendar/timezone behavior including DST, and
  source-local visitor/session identities surviving source deletion.
- Browser: create base/dashboard, edit/preview/save source DSL, settings save,
  direct editor/view reload, calendar display, missing-value gauge, time control,
  public display without the test-user cookie, and public-link revocation.
- During a real application restart, the private dashboard kept its last complete
  values, showed a refresh failure, and recovered automatically after restart.
  Replaying the same ingest key before and after restart left exactly one event.
- Workspace CLI: capabilities, successful query compilation, metric execution,
  and authenticated ingest. The temporary CLI credential was revoked.
- Gateway hot path: live Pulse registration exposes only `/api/pulse` and
  `/app/pulse`; OpenAPI, SSR, and readiness returned 200, and an internal-only
  capability path returned 404. This used the real gateway router/proxy with the
  registered container address replaced by the disposable loopback app address.
  It is not a full production gateway deployment test.
- Capability integration checks execute only data visible to the access subject.
- Production browser build excludes server-only imports from shared query helpers.
  The production server, 17 browser bundles, and Core assets also build on Bun 1.4.2.

Bun 1.4.2 verification at this checkpoint: **239 passed, 6 skipped, 0 failed**
with database and lifecycle NATS flags enabled. The six skips are three fresh
installer tests, the separately isolated runtime fault test, and two tests
requiring browser export conditions. Fresh installer tests separately passed
**3/3**. The isolated runtime fault test passed **1 test / 8 assertions** on
Bun 1.4.2, including injected rollback, actual retry, catch-up, and graceful drain.
Browser export-condition tests separately passed **10 tests / 45 assertions**.
Package TypeScript checking passed without filtering.

## Remaining acceptance work

- Resolve the shared Bun runtime pin before the final deployment recommendation.
  A candidate patch updates the package-manager, Docker, documentation/PWA
  runtime, and CI pins consistently to 1.4.2. It has not been applied. Its broader
  validation must cover the shared platform and affected consumers.
- Recheck accumulated-data latency and resource use on the intended deployment
  host. The short functional HTTP test does not establish 30-day fleet capacity.

The SQL volume script deliberately uses `pulse_volume_test`, distinct from the
HTTP fixture database. It drops only its guarded Pulse schema. Its throughput
field is `sqlSeedRowsPerSecond`; bulk SQL seeding is not HTTP ingest performance.
It queries within 30-day retention, then reduces retention to one day to prove
cleanup, including a shorter sensitive-field window.
