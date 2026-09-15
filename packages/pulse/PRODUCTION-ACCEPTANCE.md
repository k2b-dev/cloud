# Pulse alpha cut: production acceptance

Maintainer evidence recorded on 2026-09-15. Pulse remains undeployed. Capacity
fixtures, fault injection, and destructive lifecycle checks used disposable
local databases; they do not establish the performance of a production host.

## Current decision

The Cloud migration to Bun 1.4.2 resolves the previous runtime prerequisite.
Bun 1.3.14 reproduced a PostgreSQL pipelining defect that misassigned results
and stalled requests. Those observations are retained as historical evidence.
No compatibility parser was added to conceal the defect.

**The measured workload passed sustained acceptance after the concurrency fixes.**
All 15 fleet cycles met their 60-second deadline against the complete accumulated
dataset, with exact stored counts, concurrent reads, normal retention, and
controlled overload/recovery. This supports a controlled initial deployment for
the stated workload. It does not establish capacity for arbitrary exporter output
or the eventual production host. Monthly visitor queries can still take tens
of seconds; the final browser-tool limitation is recorded below.

The alpha cut has no internal schema upgrade or compatibility path. A fresh
installation is required. This assessment authorizes no release, deployment,
or removal of existing application data.

## Workload and measured environment

The operator specified 20–50 servers, approximately 10 websites, 60-second
sampling, and 30-day raw retention. Website backends send authenticated batches
with source-bound credentials; Pulse has no anonymous browser collector.

The capacity scenario assumes 50 servers with 20 gauge series each, plus 10
websites producing 10 events each per minute. These series and event rates are
explicit test assumptions, not confirmed traffic estimates or product limits.
They produce 1,000 metric series and 60 resources: 1,440,000 samples and
144,000 website events per day. This does not validate an unfiltered
`node_exporter` fleet, arbitrarily large event payloads, unbounded dimensions,
or arbitrary visitor cardinality. More series, identities, or traffic require
a representative rerun; the observed counts are not new product limits.

- Application: actual production build in a Linux ARM64 container, limited to
  2 CPUs and 1 GiB RAM, running Bun 1.4.2.
- Database: PostgreSQL 17.6 / TimescaleDB 2.23.1 in a separate Linux ARM64
  container, limited to 4 CPUs and 8 GiB RAM.
- Coordination: NATS JetStream and Valkey in the disposable test environment.
- Host: Apple M1 Max, 10 CPUs, 64 GiB RAM, shared Docker Desktop environment.
- Application connections to the database, NATS, and Valkey traverse published
  host ports. This networking differs from direct production service networking.
- Sources, users, sessions, credentials, and telemetry are synthetic fixtures.

Container limits describe the tested setup, not measured peak use or a
production sizing recommendation. Other host workloads can affect these results.

## Complete accumulated dataset

The guarded `scripts/volume-fixture.ts` prepared the UTC interval
2026-08-16 12:00 through 2026-09-15 12:00, with no preexisting rows in that interval.
Real HTTP ingestion first created the source and metric catalogs. Chronological
SQL seeding then inserted 43,200,000 metric samples and 4,320,000 events in
720 bounded hour transactions, preserving the real schema, indexes, and normal
PostgreSQL durability settings. The actual hourly rollup service produced
720,000 rollup rows and 720 clean hours; rollup sample totals matched raw data.

SQL preparation took 2,405.49 seconds; rollup preparation and its final checks
took 187.85 seconds. **SQL seeding speed is not HTTP ingest throughput.**

Storage after the event-index changes and retention checks, including hypertable
table/index/TOAST storage, was:

| Data | Bytes |
| --- | ---: |
| Raw metric samples | 7,503,544,320 |
| Events | 2,879,750,144 |
| Hourly rollups | 140,689,408 |
| Total | 10,523,983,872 |

This is approximately 10.52 GB (9.80 GiB), compared with 10.47 GB immediately
after preparation. It includes index allocation and later synthetic writes,
not just newly live rows. It excludes other application tables, WAL, backups,
database-wide overhead, and future vacuum/write growth. It is not a complete
disk allocation or a 365-day rollup sizing result.

The read-only `scripts/volume-http-probe.ts` checks a 29-day absolute interval,
excluding the oldest day to avoid retention-boundary drift during preparation.
Expected results are 4,176,000 events, 50,000 source-local visitors, and 100,000
source-local sessions. It also verifies source-specific counts, Berlin calendar
days, and every hourly CPU value from independent fixture arithmetic.

## Failed first acceptance and resulting changes

The first full HTTP run on accumulated data did not pass. Fleet cycle 10
(zero-based) took 64.44 seconds and violated the explicit 60-second deadline.
Retention work was active during the run. This is failure evidence, not a
successful capacity result with an inconvenient outlier removed.

The initial long-range HTTP probe returned the correct calendar counts in
16.46 seconds, total count in 1.92 seconds, and visitor count in 113.21 seconds.
The following session query exceeded its 120-second diagnostic timeout. The
probe therefore did not complete its repeated query rounds.

The investigation led to focused changes:

- `7f68ad1fd` and `0041daf15`: skip raw samples already covered by complete
  rollups and prune hourly storage outside the requested interval, retaining
  fallback behavior for partial hours and missing per-series rollups.
- `40c0dd152`: prune retention scans and index recent event reads.
- `183dcd2be`: deduplicate source-local identities with typed grouping before
  counting, preserving null-only groups, empty results, and calendar semantics.
- `3b32790d4` and `d01acb1df`: reuse unfiltered metric data during page rendering
  and aggregate event counts once for a complete resource inventory; selective
  and paginated reads retain their existing behavior.
- `e9941c1bf`: reclaim genuinely empty historical Timescale chunks while yielding
  to readers and writers. Dirty or shared-base data must remain intact.
- `979d4b9d6` and `6ca2073ef`: compatible locks for existing dirty hours,
  immutable definition inserts followed by fresh-snapshot validation, and
  cardinality locking only when creating new series. Existing writers can overlap;
  rollup exclusion, whole-batch rollback, and the concurrent series cap remain.
- `19f35453e` and `571690ddb`: preserve unchanged dashboard controls across
  refreshes and reserve public display windows during the original click.

A second sustained run also failed: cycle 7 took 61.83 seconds, despite low
observed CPU use. A diagnostic rerun sampled PostgreSQL activity and found
4–7 ingestors waiting on the same base/hour row. The row lock serialized
independent server batches for their entire transactions. This is a separate
correctness-preserving concurrency issue, not evidence of CPU exhaustion.
The diagnostic run was stopped after confirming that cause.

A direct service preflight after identity aggregation changes returned exactly
50,000 visitors in 31.81 seconds and 100,000 sessions in 10.96 seconds. These are
individual service observations, not HTTP timings, a final latency distribution,
or a replacement for the final HTTP measurements below.

## Final sustained HTTP acceptance

The final run executed 15 fleet cycles at absolute 60-second intervals. Its
measured fleet/burst phase lasted 849.12 seconds (14 minutes 9 seconds): the
first cycle starts at time zero, so 15 cycles do not mean 15 elapsed minutes.
Every cycle completed before its next deadline. Cycle duration ranged from
0.40 to 23.59 seconds; the previous failed runs remain recorded above.

- 900 normal authenticated batches returned 200.
- 1,728 simultaneous baseline queries returned 200: 576 each for minute metric
  averages, calendar event counts, and source-local visitor counts.
- 16,020 metric samples and 1,570 events were accepted and committed exactly,
  including the replay proof, accepted burst batches, and recovery write.
- The catalog retained exactly 1,000 series and 60 resources. Exact event totals,
  100 source-local visitors, 100 sessions, and latest CPU values were checked.
- The 120-request burst returned 56 successes and 64 rate-limit responses;
  six concurrent query responses succeeded. A normal write then succeeded in
  20.09 ms after the probe's 1.5-second pause.
- Identical replay succeeded without duplication, changed replay returned 409,
  invalid credentials returned 401, and source injection returned 400.

| Request class | Requests | p50 (ms) | p95 (ms) | p99 (ms) |
| --- | ---: | ---: | ---: | ---: |
| Normal ingest batches | 900 | 442.29 | 2,572.57 | 7,076.16 |
| Baseline queries | 1,728 | 250.51 | 1,359.18 | 2,431.56 |
| Burst, accepted and limited combined | 120 | 246.02 | 1,793.72 | 1,830.14 |

These are empirical nearest-rank percentiles from this run, not service-level
guarantees. The burst distribution combines successful and rejected requests.
Long-range queries and retention overlapped the run; the complete test suite
started afterward.

Docker reported 132 resource samples between 13:40:29 and 13:55:48 UTC. The
sampling began after the first fleet cycle and continued briefly after the
load ended. Maximum observed application use was 51.53% CPU (about 0.52 CPU)
and 183.2 MiB reported memory; database use reached 391.47% CPU (about 3.91 CPUs)
and 2.39 GiB reported memory. These periodic samples are not continuous peaks
or total host memory measurements. Database CPU approached its four-CPU limit;
the figures do not establish spare capacity for larger analytics workloads.
The test used one application container and one database, not a multi-node
failover or long-duration soak test.

## Completed long-range HTTP check

All 36 requests against the optimized Linux application returned 200 and exact
expected values. Nine query cases ran once, then three more times with at most
three requests in flight. The range contained 4,176,000 events, 50,000
source-local visitors, 100,000 source-local sessions, and 696 hourly metric
buckets. The probe independently checked calendar boundaries and metric values.

| Query | First (seconds) | Three repeats, min–max (seconds) |
| --- | ---: | ---: |
| Berlin calendar event counts | 3.74 | 3.11–17.81 |
| Total event count | 8.31 | 2.00–2.80 |
| Unique visitors | 11.46 | 5.75–54.09 |
| Unique sessions | 3.97 | 3.74–4.68 |
| One website, count | 1.87 | 0.45–1.05 |
| One website, visitors | 1.78 | 1.36–3.80 |
| Another website, sessions | 5.09 | 0.81–3.60 |
| Fleet hourly CPU averages | 2.08 | 0.24–2.34 |
| One server, hourly CPU averages | 0.77 | 0.05–0.63 |

These are observed requests under concurrent ingestion, browser work, and
retention. Three repeats are not a reliable p99 estimate. Monthly visitor analysis reached 54.09 seconds in this run; do not promise
subsecond reporting or tightly timed dashboard refreshes for broad event ranges.

A direct retention-service probe also converged with the unchanged 30-day policy: a 14.76-second
run removed the remaining 10,000 expired metric samples and 8,100 expired events;
all 720,000 hourly rollups remained. An earlier interrupted retention run had
already committed removal of 50,000 expired samples. The final run therefore
does not claim to have deleted the entire oldest hour itself. A later run against
the final concurrency build removed 2,300 newly expired events in three passes
and 15.81 seconds. Chunk cleanup yielded to active readers/writers before
converging; expired raw counts reached zero and all historical rollups remained.
These direct batch calls do not measure the production job backoff schedule.

## Verified contracts

Existing acceptance evidence covers atomic fresh installation and rejection of
populated alpha schemas; source/resource identity; strict telemetry types;
transactional idempotency; counter resets and observed elapsed time; and bounded
scraping. Further checks cover rollback, retry, catch-up, and drain through real
NATS; retention and clear/delete isolation; exact analytics intervals and
source-local identities. Permission-aware capabilities, CLI ingestion and queries,
and browser creation, editing, public links, revocation, and restart behavior
also have earlier acceptance evidence.

The current verification logs additionally show:

| Verification | Result |
| --- | --- |
| Final Pulse suite, explicit 30-second per-test budget | 253 passed, 8 skipped, 0 failed; 1,129 assertions |
| Separate installer suite | 3 passed; 13 assertions |
| Final separate NATS fault/retry/catch-up/drain test | 1 passed; 8 assertions |
| Final browser export-condition suites | 16 passed; 66 assertions |
| Unique-identity regression suites | 4 passed; 32 assertions |
| Resource count regression test | 1 passed; 10 assertions |
| Empty-chunk retention test after setup retry fix | 1 passed; 14 assertions |
| Rollup gap regression test | 1 passed; 7 assertions |

The eight main-suite skips are the three separately isolated installer tests,
the isolated runtime fault test, and four entries requiring browser export
conditions. The final main suite completed in 19.46 seconds; the separate NATS
runtime test completed in 41.92 seconds and the browser suites in 6.84 seconds.

The first final-suite invocation used Bun's default five-second test timeout;
three lifecycle smoke tests timed out while the other checks passed. The entire
suite was then rerun with an explicit 30-second per-test budget and passed.
The lifecycle assertions were unchanged. This integration-test budget is separate
from the load probe's unchanged 60-second fleet deadline.

An intermediate fixture run failed because setup encountered transient locks.
Fixture preparation now retries within a bounded deadline; deliberate writer-lock assertions
remain immediate. The focused rerun passed. This fixes test setup without
weakening the product's contention checks.

The final unfiltered Pulse TypeScript check passed, including all three
acceptance scripts. The production build includes 17 browser components and
built successfully with matching Core assets. This is a Pulse verification,
not a claim that every independently changing application in the workspace
passed its release checks.

The final backend public-link probe obtained anonymous API and rendered-page
responses with status 200, then 404 for both after revocation. Restart replay
kept exactly one persisted event. The real gateway proxy preserved gzip and
Brotli bytes, verified by decoding them and comparing with the built island.
Earlier registry/OpenAPI/SSR/hidden-route checks and actual CLI compile/query/
ingest checks passed; the temporary CLI credential was revoked.

Browser interaction before the final build verified dashboard creation, DSL
editing, CPU/event values, missing-data states, range changes, and URL-preserving
reload. During the application stop, it retained the last CPU/event values and
showed a refresh error. The final browser navigation was blocked by the browser
tool (`ERR_BLOCKED_BY_CLIENT`). Therefore automatic recovery in that final
journey and the final popup behavior are not claimed as browser-verified.
Focused browser-condition tests cover stale snapshots, owner disposal, stable
controls, refresh scheduling, and popup reservation/error cleanup. Backend HTTP
success does not replace a browser hydration or interaction check.

The initial fixture proxy also mishandled compressed asset forwarding. Browser
checks used the same production JavaScript served without its compressed sidecar
files; the sidecars were subsequently restored. Encoded transport was tested
separately through the actual gateway proxy, not through that fixture proxy.

## Reproducing the probes

Use Bun 1.4.2 and an isolated Cloud test installation with TimescaleDB, NATS,
Valkey, an authenticated test session, and a base retaining raw data for 30 days.
Provision 50 server Sources followed by 10 website Sources through supported
application APIs. Store their IDs and tokens, the session cookie, the base IDs,
and the loopback application URL in an owner-only fixture file matching the
schema at the beginning of `scripts/http-load.ts`. Do not commit this file.

All three probes require a loopback `DATABASE_URL` targeting `pulse_load_test`.
Set `PULSE_LOAD_FIXTURE` to the credential fixture. Run the HTTP probe first to
create its 1,000 series through the real writer. The SQL volume probe requires
positive database statement and lock timeouts, at most 120 and 30 seconds.
Set `PULSE_VOLUME_OUTPUT` to an output path outside the repository, then run
`bun packages/pulse/scripts/volume-fixture.ts` once without concurrent ingestion
or retention. Its durable claim refuses both completed and partially failed
restarts; use a new disposable fixture after failure.

For sustained acceptance, set `PULSE_LOAD_ROUNDS=15` explicitly; the HTTP script
otherwise defaults to three cycles. Run
`bun packages/pulse/scripts/http-load.ts`, then run
`bun packages/pulse/scripts/volume-http-probe.ts` concurrently against the same
completed fixture. Keep unrelated telemetry writers out of the fixture during
HTTP acceptance: it compares all new rows with accepted requests. Apply the
normal retention service concurrently without changing the 30-day policy.
The scripts deliberately fail on missed deadlines, unexpected response statuses,
incorrect query values, or accepted-versus-stored count differences.

## Before a production rollout

Use a fresh Pulse schema and the migrated Cloud runtime. Keep the first workload
within the measured assumptions or rerun the probes with actual series, event
rates, payloads, and visitor cardinality. Budget separately for database WAL,
backups, longer rollup retention, and the surrounding Cloud/NATS/Valkey services.

The production host and network remain unmeasured. The final browser navigation
was tool-blocked, so a browser check of popup opening and automatic recovery
remains part of rollout verification. Neither limitation changes the measured
HTTP results or removes the need for the normal Cloud release preflight.
