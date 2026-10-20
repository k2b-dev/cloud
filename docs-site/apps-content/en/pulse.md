---
title: Pulse
navTitle: Pulse
section: Operations
order: 420
description: Collect telemetry and query each base with read-only SQL.
tags: [pulse, telemetry, metrics]
updated: 2026-10-20
---

# Pulse

Pulse collects metrics, events, and states in bases. Add sources, send batches
through HTTP ingest, or let Pulse scrape Prometheus endpoints. Measurements go
to one ClickHouse database per base; Postgres keeps control data.

Use SQL through the API, CLI, or `sql.run` capability to read measurements.
Saved queries keep SQL and parameters for reuse. The live SQL console is a
separate interface for these same operations; dashboards follow later.

## Connect the data store

The operator provides a dedicated, single-node ClickHouse instance, version
26.9 or newer, with its own volume. A Cloud administrator opens
**Administration → Pulse → Data store**, obtains the setup script, and has the
ClickHouse administrator run it. Enter the service address and credentials,
then choose **Check and connect**. Pulse checks the connection, version, access,
and read profiles before saving; failed checks leave the saved connection unchanged.

Without a connection, Pulse shows **Pulse is not set up yet**. Its data API
returns `503 PULSE_STORE_NOT_CONFIGURED`; setup and other Cloud apps remain
available. See [Provide ClickHouse for Pulse](/en/docs/operations/deployment-requirements#provide-clickhouse-for-pulse)
for setup, sizing, and backups, and [Deprecations and migrations](/en/docs/reference/deprecations-and-migrations#pulse-requires-clickhouse-and-starts-empty)
before updating an existing installation. The full
[Deployment requirements](/en/docs/operations/deployment-requirements) cover
Cloud startup dependencies and readiness checks.

## Bases and administration

Each base is a tenant with its own database, read user, and restricted read
views. Read access excludes internal tables, sensitive fields, payloads, and
other bases. A base administrator controls members, sources, tokens, and
retention without needing the Cloud administrator role. Cloud administrators
set installation policy, profiles, limits, and internal scrape targets; their
administration pages show amounts and state, without measurement contents.

By default, people and agents with write credentials can create a base and
receive its `admin` access. For a delegated agent, that access goes to its
person. Cloud administrators can restrict creation to people or Cloud
administrators and change the default maximum of 200 bases under
**Administration → Pulse → Bases**. Every service account counts as an agent
for this policy, including one acting for a person. Source-bound credentials
cannot create bases.

A new base moves from `provisioning` to `active`. Changes require an active
base. Clearing (`clearing`) discards measurements and keeps sources, tokens,
settings, and access. Deleting (`deleting`) revokes source tokens and database
read access before removing the database. The overview keeps a deleting base
visible to its administrators until deletion finishes. After five failed
attempts the operation is `failed`. A base administrator chooses **Retry** in
the base settings or overview; a Cloud administrator can retry from **Bases**.
Open pages check a running operation every five seconds. If that check fails,
the overview card and the **Bases** row say the status is unknown, keep
checking, and offer **Retry** to check again at once.

| Per-base setting | Default or fixed profile |
| --- | --- |
| Values per minute | 2,000 metrics, events, and states combined |
| Bytes per minute | 5 MiB |
| Storage threshold | 5 GB |
| Metric series | 50,000 across the base; at most 10,000 per metric |
| Event kinds / state keys | 2,000 each |
| Questions and SQL per clock hour | 600; Cloud administrators can change this per base |
| Small read profile | 1 GB memory, 10 seconds |
| Normal read profile | 2 GB memory, 10 seconds |
| Large read profile | 4 GB memory, 30 seconds |
| Result limit for each read profile | 10,000 rows and 4 MiB |

Pulse measures storage and instance free space every five minutes. Base
administrators and Cloud administrators can inspect those amounts.

Hourly checkpoints compare Postgres and ClickHouse. A missing database or a
checkpoint mismatch blocks measurement writes and prevents a base
administrator from clearing data. Restore matching backups, then have a Cloud
administrator choose **Check again**. **Start empty** discards measurements and
recreates an empty base store. At startup, Pulse restores missing read users for matching databases.
Databases with no base appear as orphans and can be deleted separately.

## Query one base with SQL

Read access allows SQL execution and saved-query reads. Write access allows
saving, changing, and deleting queries. Readers can inspect base settings and
usage; only base administrators can change them.
An agent with a read grant has the same query access as a person. To answer a
question across two bases, run two queries with separate base IDs.

Use `POST /api/pulse/bases/:baseId/sql` with `{sql, params?, runId?}`. Base IDs
and short IDs work. SQL can read `samples`, `rollups`, `series`, `events`,
`states`, and `sources`. Internal tables, `sensitive`, `payload`, credentials,
and other bases remain inaccessible. SQL cannot select a different base.
Only `SELECT` and `WITH` statements are accepted. A final semicolon is removed;
multiple statements, top-level `FORMAT` or `SETTINGS`, `INTO OUTFILE`, raw
ClickHouse parameter syntax, and unbalanced SQL are refused before admission.
`#` comments and `$` heredoc syntax are unsupported; use `--` or `/* */`
comments and quoted strings.

Editing SQL or parameter values clears the previous result. A response from a
run started before that edit does not appear under the changed query.

The result contains column names and ClickHouse types, compact row arrays,
`rowCount`, `truncated`, execution statistics, and limits. The wrapper applies
`LIMIT 10000`. Exactly 10,000 returned rows sets `truncated: true`: **the
10,000-row limit was reached; there may be more**. This flag does not prove
that another row exists. Results over 4 MiB fail with `RESULT_TOO_LARGE`.

The console charts the first time column against numeric columns, using up to
8 series and the first 480 rows in returned order. It states when the chart is
cut. The time axis uses the column's time zone, or UTC if none is specified.
The axis labels the two ends of the returned time range, or the sole timestamp
if all points share one. For a single day,
labels show times and the axis names the date; longer ranges show calendar dates. Inspect a point for its full date, time, and UTC offset.
Date-only columns show dates without a time.

### Console URLs and Assistant drafts

The console route is `/app/pulse/:baseId/sql`; a saved query adds its ID or
short ID as the final path segment. An unsaved console keeps SQL and parameter
values in the URL. A saved console keeps its query ID, current SQL, and parameter
values, including unsaved edits. Reload restores that draft; opening a plain
saved-query link loads its saved SQL.

Console links have a 4,000-character budget, including percent-encoding. If
SQL and parameters exceed it, the entire console payload is omitted. The
saved query ID and settings tab remain. The full draft stays in that tab's
browser history entry and is restored after reload, including for readers who
cannot save queries. It is not included when you share or open the link in
another tab. To share a long draft, copy its SQL and parameter values or save
the query if you have write access. Result rows are never stored in URLs or
browser history.

The chart adapter uses the first Date, DateTime, or DateTime64 column as X and
numeric columns as series, including Nullable numeric columns. It takes at
most eight series and the first 480 returned rows, without reordering them.
The cut counts refer to the returned result, not rows beyond the server's
result limit. Missing dates, numbers, or rows have separate no-chart reasons.

**Ask AI** opens an unsent Assistant draft containing the current SQL,
parameter values, and base reference. It loads the `cloud-pulse` Skill and
`sql.run`, `base.read`, and `source.list` tools. Launch failure leaves the SQL
unchanged and can be retried. The hourly SQL quota blocks execution until its
reset time; saving remains available.

### Bind parameters

Write `:name` outside strings, identifiers, and comments. Names are
case-sensitive and match `[A-Za-z_][A-Za-z0-9_]*`. Send values as strings in
`params`; Pulse binds values as data, including quotes and SQL-looking text.
Missing values return `PARAMETER_MISSING`. Unused values and reserved names
are refused. `:base_tz` is reserved: Pulse binds the base's IANA timezone.
New bases inherit the Cloud `app.timezone` setting. A base administrator can
change the timezone, icon, and color. The short ID remains read-only.
Icons use the shared `@k2b/ui` icon picker catalog. Colors use its fixed
accent palette: `zinc`, `blue`, `emerald`, `amber`, or `red`.
The CLI exposes `--icon`, `--color`, and `--timezone` on base updates.

| Value | Binding |
| --- | --- |
| ISO date-time with or without a zone, or `2026-10-20` | `DateTime64(3, '<base timezone>')`; zoned instants keep their offset; zone-free dates and times use the base timezone |
| `30s`, `5m`, `1h`, `1d`, `2w` | `UInt32` seconds |
| Finite number | `Float64` |
| Other text | `String` |

Every path permits at most 16 KiB of UTF-8 SQL, 32 parameters, and 2 KiB of
UTF-8 per value. String values are escaped for ClickHouse's parameter format
before URL encoding, preserving backslashes, control characters and Unicode.
In the worst case these steps expand a value sixfold: 32 × 6 × 2 KiB uses
384 KiB of the client's 512 KiB URL budget. The remaining 128 KiB covers names,
types, database, query ID, and other URL overhead. SQL is sent in the body.

### Use time buckets and metric helpers

Buckets use native ClickHouse SQL. For fixed intervals, write:

```sql
SELECT toStartOfInterval(ts, toIntervalSecond(:bucket), :base_tz) AS t,
       count() AS events
FROM events
WHERE ts >= :from AND ts < :to
GROUP BY t ORDER BY t
```

For calendar days, use `toStartOfInterval(ts, INTERVAL 1 DAY, :base_tz)`.
Calendar days follow the base timezone and can contain 23 or 25 hours.
`bucket()` is not a global function.

Three per-base parameterized views provide reset-safe counter calculations:

```sql
SELECT metric, dimensions, increase
FROM increase(metric='http_requests_total', from=:from, to=:to)
```

`increase` and `rate` return one row per series with `series_id`, `metric`,
`dimensions`, `source_id`, `resource_key`, `increase`, and observed `seconds`.
`rate` adds `rate = increase / seconds`, or null when no interval was observed.
A decrease counts the new value as the increase after a reset. The helpers
use raw observations where retained and older hourly increases across the
retention boundary. Windows over expired raw data must contain complete
hours; a partial expired hour returns a SQL error rather than an estimate.

```sql
SELECT dimensions, quantile * 1000 AS p95_ms
FROM histogram_quantile(
  metric='traefik_entrypoint_request_duration_seconds',
  from=:from, to=:to, quantile=0.95
)
```

The histogram metric argument omits `_bucket`. The helper sums counter
increases for equal upper bounds, then calculates the quantile separately for
each source, resource, and label group without `le`. It never combines
quantiles. A changed bucket set returns an error naming the observation time;
for retained hourly evidence, the diagnostic names the affected hour.

### Check limits and recover from errors

`GET /api/pulse/bases/:baseId/sql/limits` returns the profile, memory and time
budget, result limits, hourly usage and reset time, and queue limits.
Three queries can run per Cloud, with one per base. Up to 20 runs can wait
for five seconds. Input errors and admission refusals do not consume hourly
quota. Quota is charged only when a query gets a slot and resets at the next
clock hour. Alerts and dashboards will have separate quotas.

| Code | HTTP | Action |
| --- | --- | --- |
| `INPUT_TOO_LARGE`, `PARAMETER_MISSING`, `SQL_ERROR` | 400 | Reduce input, supply values, or fix SQL; line and column refer to your SQL. |
| `NO_READ_ACCESS` | 403 | Request read access to this base. |
| `TIME_LIMIT`, `MEMORY_LIMIT`, `RESULT_TOO_LARGE` | 422 | Narrow the range, aggregate, or select fewer columns. |
| `QUOTA` | 429 | Wait until the returned reset time; respect `Retry-After`. |
| `BUSY`, `QUEUE_FULL` | 503 | Pulse is busy; wait for `Retry-After` and retry. |
| `STORE_UNAVAILABLE` | 503 | Ask the operator to check ClickHouse or Valkey. |
| `PULSE_STORE_NOT_CONFIGURED` | 503 | Ask a Cloud administrator to connect the data store. |
| `CANCELLED` | 400 | The run was cancelled; start a new run if needed. |

Send a UUID `runId` with a run to cancel before its response arrives. Send that
same ID to `POST /api/pulse/bases/:baseId/sql/cancel`. Only the actor that
started the run can cancel it. Closing the request also cancels the run.

### Save and reuse a query

Use `/api/pulse/bases/:baseId/queries` to list or create queries, and
`/queries/:queryId` to get, update, or delete one. Lists use Cloud pagination.
Saved queries keep a name, SQL, string-valued parameters, and revision.
Names are unique within a base without regard to case. A `PATCH` supplies a
complete snapshot: `name`, `sql`, optional `params`, and `expectedRevision`.
Omitting `params` saves an empty parameter map. A stale revision returns `409`.
An `Idempotency-Key` allows replay of the same saved-query write for 24 hours,
even after later revisions; changing the body with that key returns `409`.
Saving has the same SQL and parameter input checks as execution.
Deletion requires the current `expectedRevision` in its API body and capability
input (CLI: `--expected-revision`). A concurrent edit returns `409`; read the
query again before confirming deletion.

```sh
cld pulse sql --base Ops001 --file requests.sql --param from=2026-10-20 --param to=2026-10-21 --format table
cld pulse queries list --base Ops001
```

Use `--format json` or `--format csv` for export, and `-` to read SQL from
standard input. Ctrl-C sends cancellation. `cld pulse reference sql.md`
describes options and exit codes. `sql.run` and `saved_query.list` need no
approval. The agent result is limited to 100 rows, 500 points, and 256 KiB;
`truncated` marks a shortened result. Points count numeric cells; whole rows
are retained, with 240 KiB reserved for data and 16 KiB for the capability
envelope. `saved_query.save` uses an idempotency
key and revision checks with rememberable approval. Deletion always asks for
approval. There is no capability for tokens or access changes.

## Send a batch with HTTP ingest

Create an HTTP ingest source and a source token. Keep the token in the
collector's secret store. Send JSON to `POST /api/pulse/ingest` with
`Authorization: Bearer <source-token>` and `Content-Type: application/json`.
The credential selects the source; the body cannot override it.

The body has optional `metrics`, `events`, and `states` arrays. Each array
accepts at most 500 entries, with 1,500 entries total and a 5 MiB limit on the
validated batch's encoded JSON. Empty batches are refused. Metrics use finite
numbers and type `gauge` or `counter`; counters must be nonnegative. The first
accepted value fixes a metric name's type and unit within its base. Later
batches must match both. See `cld pulse reference ingest.md` for fields and examples.

**Send an `Idempotency-Key` from the first attempt.** The key is scoped to the
source and accepts at most 200 characters. Pulse reserves the key and its
acceptance time before writing measurements. For its 24-hour lifetime:

- The same key and identical batch return the same successful
  `{ metrics, events, states }` counts.
- A different batch with that key returns `409`.
- An interrupted batch stays pending. Retrying the same batch with the same
  key writes the same row identities with the original acceptance time.

After expiry, reusing a key starts a new batch and keeps earlier events.

Keep the body and key until delivery completes. Without a key, a failed batch
can already be partly stored. The error says **The batch may be partly
stored, and sending it again can store those parts twice**. Adding a key
afterwards cannot deduplicate the first attempt. Send every batch with an
`Idempotency-Key` from the first attempt to retry safely.

Invalid input or registry caps return `400`, missing ingest access `403`, an
unknown source `404`, and a disabled source, busy or blocked base, or conflicting
key `409`. Successful ingest returns `200` with the three counts. Temporary
refusals and their retry delays are described below.

## Timestamps, corrections, and states

Omitting `ts` uses the batch's acceptance time. A supplied timestamp must be an
ISO datetime and can be at most five minutes in the future. A future-time error
names the array, item index, metric name, event kind or state key, and timestamp.
Metric timestamps must also fall within raw retention. A sealed metric hour
refuses writes even if retention is later extended.

For the same metric series and timestamp, the newest accepted value wins. The
restricted read view shows the correction at once, without waiting for storage
merges. A correction marks its hour for recomputation and also updates the
counter increase in the hour of the next observation, even across empty hours.

For each state key, source, and dimension/object identity, a newer timestamp
wins. At equal timestamps, later acceptance wins; input order breaks ties in
one batch. Older states change nothing. Pulse stores history for the initial
value and subsequent value changes, while equal values update the current
snapshot without adding history.

A keyed retry completes its original state history even if newer batches have
arrived. Their newer current states remain current. An unkeyed resend of a
failed state batch still records its change once, with the time of the
observation that first carried the new value. If a different value arrives
before the resend, only the newer change is recorded; send state batches with
an `Idempotency-Key` to keep every change.

Hourly metric values keep count, sum, minimum, maximum, last value and its
timestamp, and counter increase. A counter reset contributes its new value;
otherwise the increase is the difference from the previous observation.
Calculation spans empty hours and can use the preceding hourly value after
raw data expires. Corrections trigger recomputation rather than adding to an
old total.

## Scrape Prometheus metrics

A metrics source needs an endpoint. Intervals are whole minutes from 60 to
86,400 seconds. Only one scrape per source runs at a time. Lookup, connection,
headers, and body share a 15-second timeout. Responses must use identity
encoding and fit 10 MiB. A scrape accepts at most 50,000 selected sample lines;
all stored samples use the same collection time.

Pulse accepts declared gauge, counter, and histogram families. Histogram
`_bucket` samples keep the upper bound in the `le` dimension; finite bounds
are normalized. Buckets, `_sum`, and `_count` are stored as counters. Each
label group must have a `+Inf` bucket and nonnegative cumulative bucket counts.
A supplied `_count` must match `+Inf`, and `_sum` cannot be negative. An invalid
group refuses the whole family. The source shows refused families and reasons
(up to 20), plus the number of skipped summary samples. Summaries, untyped,
malformed, and nonfinite samples are skipped.

**Only these metrics (empty = all)** accepts exact family names or a prefix
ending in `*`, separated by commas or newlines. For example, `node_*` includes
families starting with `node_`. Histogram filters name the family, without the
`_bucket`, `_sum`, or `_count` suffix. Filters apply before sample and series
limits; excluded families consume neither. The filter list allows 100 entries
of at most 128 characters, with only a trailing wildcard. That cap comes from
the source configuration's 16 KiB budget: 100 × (128 characters + 3 JSON bytes)
uses 13,100 bytes and leaves room for other configuration.

The CLI supports repeatable `--metric-filter` on `sources create` and
`sources update`. On update, `--clear-metric-filters` includes all families again.

Public endpoints work by default. A Cloud administrator allows internal targets
per base under **Administration → Pulse → Internal targets**: a host or IP
covers every port, `host:port` or `[ipv6]:port` covers one port, and a CIDR
covers every port in its range. `/0` is refused. Reserved names need an exact
host entry. Pulse checks the current entries on save, every scrape, and each
redirect (at most three), resolves again, and pins the connection. Removing an
entry blocks the next scrape and reports how to repair it.

## Quotas, storage, and outages

Values and bytes share a token bucket per base across replicas, HTTP ingest,
CLI ingest, and scrapes. Buckets hold one minute's allowance and refill
continuously. HTTP ingest counts original body bytes; other paths count their
serialized batch. Completed keyed retries return their stored counts without
using quota again. A batch larger than one minute's allowance can use a full
bucket. Its full cost is charged, so later batches wait until enough quota has
refilled.

| Condition | Response and recovery |
| --- | --- |
| Base value or byte quota exhausted | `429 PULSE_BASE_THROTTLED` with a whole-second `Retry-After`; wait, then retry the same keyed batch. The source shows throttling for five minutes. |
| Quota service unavailable | `503 PULSE_QUOTA_UNAVAILABLE`, `Retry-After: 30`. |
| Measured base storage reaches its threshold | `409 PULSE_BASE_STORAGE_FULL`; reads continue. Shorten retention or ask a Cloud administrator to raise the threshold. |
| Instance disk below 10% free | `503 PULSE_STORE_DISK_LOW`, `Retry-After: 300`; reads continue. Cloud administrators receive a notification. |
| Data store unreachable | `503 PULSE_STORE_UNAVAILABLE`, `Retry-After: 30`; retry with the same key. Scrapes fail and record the error. |

Storage notifications go once per threshold crossing to direct user base
administrators; group access is not expanded. Disk notifications go once per
crossing to Cloud administrators. Store outages notify Cloud administrators
once per outage; a successful disk measurement closes the outage. Delivery
follows notification preferences. A failed or throttled scrape waits for its
next scheduled attempt.

## Retention and complete metric hours

Raw retention allows 1–730 days by default; Cloud administrators can raise the
maximum to 3,650 days. Hourly values allow 1–3,650 days and sensitive event
fields 1–8,760 hours. Shortening any period requires confirming a preview of
the cutoff, affected rows, and estimated bytes. For sensitive fields, the
preview counts nonempty fields to clear; their event rows remain.
A confirmation in the web app applies only to the settings it previewed; if
someone changed retention in the meantime, Pulse asks you to review the
preview again. The CLI flag `--confirm-shorter-retention` confirms against the
current settings.

ClickHouse TTLs expire events and state history by raw retention, hourly values
by their own retention, and sensitive fields by a separate column TTL.
Physical removal follows storage merges. Current states have no TTL.

Raw metric samples use daily partitions. The nightly retention job at 03:17
UTC removes a partition only when its whole day is past raw retention and all
recorded metric hours in that day are sealed. Late data and corrections inside
retention mark hours dirty again; the hourly job resumes unfinished hours
after downtime. An hour whose calculation fails waits one hour before its next
attempt, so other bases continue. **Hourly values are lagging** under
**Administration → Pulse → Bases** indicates dirty hours more than three hours
old awaiting processing, or sealing that delays partition removal by more than
a day. Check the hourly and retention jobs before discarding data.

Retention also removes expired request keys and scrape history, and unused
series, metric definitions, event kinds, and state keys. Keys with a current
state remain.

## Check source status and credentials

Open **Sources** or run `cld pulse sources list --json`. Status shows the
newest data timestamp, series count, today’s count, recent throttling, refused histogram families, skipped
summary samples, and the last error and its time. Scrape history adds success,
counts, duration, and finish time; push requests do not create scrape history.

Today starts at midnight in the base timezone. Counts use a five-minute
cache; when the query queue is busy, today’s count is unavailable (`null`).
Today counts retained metric samples, events, and current state rows updated
since midnight. A state row counts once even if its value was reported
several times; this count is not the number of state submissions.

A metrics endpoint's bearer token is bound to its origin (scheme, host, and
port). Changing that origin deletes the stored token unless you supply a
replacement. A path-only change keeps it.

For HTTP ingest, create a separate labeled token per collector deployment:

```sh
cld pulse source-tokens create --base Base01 Src001 --name collector --output-file ./pulse.token
```

`--output-file` is required. It creates a new file with mode `0600` and refuses
an existing path. Text, JSON, and JSONL output contain only ID, name, and path;
the token is never printed. Move it into the collector's secret store without
copying it into chat, logs, or shell arguments.

Run `cld pulse --help` for current commands and open **Help** inside Pulse for
source setup, data types, and recovery.

### Base settings

Open **Settings** in a base for General, Members, Retention, Usage and limits,
and Clear and delete. Base admins can change the name, icon, color, timezone,
members and retention. Readers can inspect settings and see whom to contact
for changes. Shorter retention asks for confirmation of its cutoff and amount.
Usage shows the query profile, input and concurrency limits, and hourly quota.
Only Cloud admins change quotas and profiles in **Administration → Pulse → Bases**.
After a quota refusal, the console reloads current usage. If that fails, it
keeps the quota block and offers **Retry** for the usage read.
Closing the modal returns to the underlying view.
