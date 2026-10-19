---
title: Pulse
navTitle: Pulse
section: Operations
order: 420
description: Collect metrics, events, and states through HTTP ingest and Prometheus sources.
tags: [pulse, telemetry, metrics]
updated: 2026-10-19
---

# Pulse

Pulse collects metrics, events, and states in bases. Add sources, send batches
through HTTP ingest, or let Pulse scrape Prometheus endpoints. Measurements go
to one ClickHouse database per base; Postgres keeps control data.

Dashboards and questions return with SQL in the next update. Their place in the
base shows **Dashboards and questions are coming back**, explains the upcoming
SQL workflow, and offers **Go to sources**. Source collection remains available.

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

Each base is a tenant with its own database, read user, and six restricted read
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

| Per-base setting | Default or fixed profile |
| --- | --- |
| Values per minute | 2,000 metrics, events, and states combined |
| Bytes per minute | 5 MiB |
| Storage threshold | 5 GB |
| Metric series | 50,000 across the base; at most 10,000 per metric |
| Event kinds / state keys | 2,000 each |
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
arrived. Their newer current states remain current.

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
using quota again. Batches larger than the allowance need splitting.

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

ClickHouse TTLs expire events and state history by raw retention, hourly values
by their own retention, and sensitive fields by a separate column TTL.
Physical removal follows storage merges. Current states have no TTL.

Raw metric samples use daily partitions. The nightly retention job at 03:17
UTC removes a partition only when its whole day is past raw retention and all
recorded metric hours in that day are sealed. Late data and corrections inside
retention mark hours dirty again; the hourly job resumes unfinished hours
after downtime. **Hourly values are lagging** under
**Administration → Pulse → Bases** indicates dirty hours more than three hours
old awaiting processing, or sealing that delays partition removal by more than
a day. Check the hourly and retention jobs before discarding data.

Retention also removes expired request keys and scrape history, and unused
series, metric definitions, event kinds, and state keys. Keys with a current
state remain.

## Check source status and credentials

Open **Sources** or run `cld pulse sources list --json`. Status shows the
newest data timestamp, recent throttling, refused histogram families, skipped
summary samples, and the last error and its time. Scrape history adds success,
counts, duration, and finish time; push requests do not create scrape history.

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
