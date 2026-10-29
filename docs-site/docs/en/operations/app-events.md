---
title: Operate app events
navTitle: App events
section: Operations
order: 585
description: Inspect event subscriptions and deliveries, diagnose blocked handlers, and redeliver retained work.
tags: [events, operations, retries, retention]
updated: 2026-10-27
---

# Operate app events

Use `cld events` with an administrator profile to inspect the declared event
catalog, subscription readiness, and retained deliveries. The corresponding
Core endpoints under `/api/app-events` require administrator access.

## Roll out the next release

Deploy the updated Core first and let its migrations finish before deploying
event producers or subscribers. Check `cld events status` and the catalog before
enabling automatic provisioning. Producers require the Postgres event outbox and the updated platform
app-ID publisher binding;
Core needs the existing NATS JetStream service and storage for the budget below.

For Files, configure its Filegate URL, token and provider-specific roots before
enabling automatic homes. The Filegate integration was verified with version
7.1.0. Local users require the existing Linux identity configuration; IPA users
require FreeIPA availability and complete POSIX data. Enable `cloud.autoCreate`
and `freeipa.autoCreate` independently for the intended areas.

During rollback, stop event producers before rolling Core back. Keep the event
tables and stream: older code does not process the new event deliveries, and
stream retention continues to expire. Restore the compatible Core and producers
within the retained window, then inspect backlog and failures. If status reports
`gap_detected`, run the subscriber's domain reconcile; redelivery cannot restore
events that have expired. Rolling back code does not remove homes already
created or reverse completed handler effects.

## Inspect readiness and failures

Open **Administration → Apps** (`/admin/apps`) and select an app to inspect
its access rule, requested platform permissions, sent events, subscriptions,
and active notification definitions. Deploying an app approves its declared
subscriptions; the detail view makes them visible rather than asking for a
second approval. Subscriptions first observed in the last seven days are marked
**New**. Blocked subscriptions show their reason and failed deliveries offer
**Deliver again** after the underlying problem is fixed.

The same administrator read is available from the CLI:

```sh
cld apps show filesv2
cld apps show filesv2 --json
```

`GET /api/app-events/apps/:appId` returns `{ app, access, sends, hears,
notifications, totals }`. It requires the administrator role and, for OAuth,
the `admin` scope. Unknown app IDs return 404. Offline apps remain inspectable
while Core has declarations, subscriptions, notification definitions or access
records for them. Their saved, non-retired declarations remain visible; metadata
Core does not hold is unknown, with the app ID used as its name. An offline app's unknown
access rule is `null`; a live app without an access declaration is `legacy`.

Each detail list contains at most **100 entries**; `totals` shows each full
count so a truncated list is visible. `cld apps show` reports how many entries
each list omits; use `cld events subscriptions --app <app-id>` for the full
subscription list. Subscriptions appear newest first, sent events by type and
version, and notifications by ID. Each subscription includes
delivery counts for every state and at most **five** recent failed deliveries,
ordered by last attempt. Error text is limited to **1000 characters**. Their
delivery IDs work with `cld events redeliver <id> --yes` and the existing
redelivery endpoint. Subscriber counts include active and blocked subscriptions,
excluding cancelled ones. Notification labels and event titles use the request
locale where translations are available.

```sh
cld events ls
cld events subscriptions --app filesv2
cld events status
cld events deliveries --app filesv2 --state failed --limit 50 --offset 0
```

`ls` returns `{ events: [...] }`. Each event includes its full `type`, version,
title, description, full subject Type ID, place Type ID or `null`, automation
metadata, `dataSchema`, and subscribers, including their persisted state and
`firstSeenAt`. Offline applications remain in this administrative catalog. `--app` selects the publisher.

`subscriptions` shows subscription readiness and blocked reasons; `--app`
selects the subscriber. Applications receive service events only. An application's
subscription to a resource event stays blocked with `resource_events_unsupported`
by design; retrying or redelivering does not change that. Resource events go only
to subscriptions a person stands behind with a mandate, and each delivery checks
that this person may read the place.

`deliveries` accepts `--app`, `--state`, and `--event-type`.
Use `--offset` and `--limit` to page through retained work. Structured output
preserves `{ items, pagination: { offset, limit, total } }`, including in
`--jsonl` mode, where each page is one JSON line. Text output shows delivery
IDs, subscription IDs, states, attempt counts, and `heldBy`. A non-null `heldBy`
is the earlier unresolved delivery holding this subscription and subject;
retry or reconcile that predecessor first.

These commands call the matching administrative endpoints:

| Command | Endpoint |
| --- | --- |
| `ls` | `GET /api/app-events/catalog` |
| `subscriptions` | `GET /api/app-events/subscriptions` |
| `deliveries` | `GET /api/app-events/deliveries` |
| `status` | `GET /api/app-events/status` |
| `acknowledge-gap --yes` | `POST /api/app-events/status/acknowledge` |
| `redeliver <id>` | `POST /api/app-events/deliveries/:id/redeliver` |
| `record <type> --shape-only` | `GET /api/app-events/record/:eventType` |

Spaces now publishes `spaces.item.created` and `spaces.item.completed`.
Notebooks publishes `notebooks.notebook.created`, `notebooks.notebook.updated`,
`notebooks.note.created`, and `notebooks.note.updated`. All are version 1
resource events with public refs and empty data. They are retained through the
normal event pipeline, but **are not delivered to app subscribers**. Retrying,
redelivering, or restarting does not remove the authorization block.

Note updates are trailing, bounded batches: Q = **30 seconds** quiet time,
W = **five minutes** until eligibility despite continuous edits, T = **one minute**
between sweeps, M = **four notes** per sweep across all replicas. A durable
Postgres tick claim prevents concurrent ticks and retries from spending a
second batch. Pending rows have a partial index; the sweep selects oldest
pending rows with `FOR UPDATE SKIP LOCKED` and atomically publishes and clears
each marker. Locked notes remain eligible. An outbox failure rolls back the
batch and tick claim, leaving markers for retry. Backlog and skipped row locks
can delay delivery beyond W; W bounds coalescing, not queueing time.

Creates and completions are discrete facts retained in their domain
transactions. Their rate equals the domain write rate. Both APIs install the
shared `rateLimit()` middleware: by default 60 requests/s per session user or
client IP, configurable through `security.rate_limit_per_second`. That is not
an installation-wide event bound, and direct services and capability Actions
do not acquire that API throttle. Ordinary creates/completions affect one
item; notebook creation can also seed a welcome note, and missing note paths
can create up to 64 missing parents plus the requested note in one call
(2,000-character parent-path limit). Repeated
agent calls and multiple callers remain unbounded in aggregate. Notebook
metadata updates affect one notebook without note fan-out, so they remain
transactional too. Operators must budget all these writes together with Core
and other producers; the note sweep does not enforce the overall stream budget.

## Recover a delivery

First fix the handler or its dependency and verify that the subscription is
ready. Inspect the retained delivery before redelivering it:

```sh
cld events deliveries --app filesv2 --event-type core.user.created --state failed --json
cld events redeliver <delivery-id> --yes
```

`--yes` is required because the handler can repeat effects. Redelivery is
bounded by retained state and the current subscription contract; it does not
repair an unsupported subscription. After the request, inspect the delivery
again to see whether it completed or failed. A successful redelivery request
starts a fresh 30-day retention window for unresolved work. Its event remains
available while the delivery still references it; completion uses the normal
seven-day cleanup window.

The worker makes at most **8 attempts**, with delays of **1 second, 5 seconds,
30 seconds, 120 seconds, 600 seconds, 1800 seconds, and 3600 seconds** between
attempts. The worker reads batches of **32** and runs at most **4** deliveries
concurrently. Handlers must be idempotent: delivery acknowledgement and a
subscriber's domain effect are not one transaction.

An offline subscriber keeps its active subscription and pending deliveries.
Core also creates deliveries for it while it is offline. Unreachable checks
wait 30 seconds, then double up to one hour without spending one of the eight
handler attempts. Only absence from the registry or a failure before connecting
counts as unreachable. A request timeout or a lost connection spends an attempt
and ends in `failed` after eight attempts (`handler_timeout` or `connection_lost`).
A stale subscriber answering HTTP 410 retries within the same eight-attempt
budget as `subscription_unavailable`. The subscriber answers after a 30-second
handler deadline; Core waits up to 45 seconds. A successful delivery wakes that
application's other unreachable deliveries immediately.

Only a live manifest that removes or replaces a subscription
cancels its backlog with `subscription_removed`.

Core persists event declarations after observing a live publisher. Publisher
restarts therefore do not block ingestion or subscribers. A declaration never
seen by Core gets two registration retries (1 and 5 seconds), then the event
is stored as `rejected` with `event_not_declared`. A live publisher removing an
event declaration retires it: existing subscriptions become blocked with
`event_not_declared`, and new events of that type are rejected. Offline
publishers keep their declarations. Reintroducing the declaration makes eligible
subscriptions active again.

`status` includes `rejectedCount` for retained rejected events and `rejections`
with the latest ten rejections (`rejectionLimit: 10`). Each entry contains only
`type`, `source`, `code`, and receipt `time`; no payload is returned. Use the code
to diagnose `invalid_envelope`, `event_too_large`, `invalid_declaration_schema`,
`schema_mismatch`, `reference_mismatch`, or `event_not_declared`. Malformed input
without a usable event ID is logged and acknowledged. Unknown fields at the top
level of an otherwise valid envelope are stripped for publisher compatibility.
Deterministic rejection does not hold up later ingestion; registry refresh
failures use persisted declarations. Gap checks run periodically, outside event
acceptance.

Status reports `gap_detected` when stream retention passes an unseen ingestion
sequence. `lastSequence` is the highest observed sequence; persisted holes can
predate it. Replayed and dead-lettered sequences count as seen.
After reconciling affected subscribers, clear the signal with:

```sh
cld events acknowledge-gap --yes
```

This administrator action records the acknowledged sequence range in the
audit trail and returns the broker to `ready`. It does not restore expired
events. Core ingests serially under normal operation; deliveries are ordered
by acceptance within each subscription and subject. Replaying ingestion dead
letters can accept older events later, so handlers must tolerate that order.

## Plan retention and outage capacity

The stream budget is shared by **all producers**. The producer fixture tests
measure compact JSON envelopes at **241 bytes** for `spaces.item.created`,
**243 bytes** for `spaces.item.completed`, **256 bytes** for either note event,
and **264 bytes** for either notebook event (six-character public IDs, a UUID
event ID, fixed ISO timestamp, empty data, no cause). PostgreSQL `jsonb::text`
adds 21 bytes of whitespace to these fixtures: **262–285 bytes**. Longer refs
or an optional cause increase the size; the platform maximum remains
**4096 bytes** in PostgreSQL `jsonb::text`.

The shared JetStream has a **256 MiB** byte limit and a **7-day** maximum age.
Before transport overhead, 264-byte thin envelopes fit at
`268435456 / (264 × 604800) = 1.68 events/s` for seven days. This is an
upper bound, not an operating rate: Sync wrapping, subjects, headers, and NATS
storage consume bytes too. The fixture test also publishes through Sync:
notebook events occupy **692 retained bytes/message**, note events **684**,
including broker accounting in that test namespace (64-character ordering key
and UUID deduplication key). These values vary with namespace and headers;
692 bytes would allow only `268435456 / (692 × 604800) = 0.64 events/s`.
Retaining the conservative **1024-byte transport
allowance** and using the largest measured database representation gives
`268435456 / ((285 + 1024) × 604800) = 0.339 events/s`.
Use **0.3 events/s aggregate** (25,920/day) as the thin-envelope planning rate,
with roughly 12% of stream space left beyond that allowance. At the full
4096-byte envelope limit plus the allowance, only 52,428 events fit: about
two days at 0.3 events/s. Byte pressure can shorten history before seven days.
JetStream reserves the byte limit on every replica; replication multiplies
physical storage. The stream buffers events until Core stores them, so this
outage budget matters when Core cannot ingest.

Allocate at most 25% of the 0.3 events/s planning rate to coalesced note updates.
The existing Sync scheduler has minute resolution, so T = 60 s and
`M = floor(0.25 × 0.3 × 60) = 4`. Thus sustained `note.updated` throughput is
at most `M/T = 4/60 = 0.0667 events/s`, **22.2%** of the shared planning rate
(with an initial burst of at most four). Q = 30 s merges short editing bursts;
W = 300 s lets continuous editing become eligible within five minutes. The
remaining 0.233 events/s is a planning allowance for all other events, not a
publisher limit. Sustained discrete writes above it require more capacity or
a shorter outage target. A missed or expired event requires domain reconciliation.

Core retains unresolved deliveries for **30 days** from creation or the latest
administrator redelivery, then marks them
`cancelled` with `retention_expired`. That cancellation remains visible for
**7 days**. Completed and cancelled deliveries are retained for **7 days**;
failures are not silently discarded. Events are retained for at least
**30 days**, and longer while deliveries still reference them. After cleanup
removes the retained records, `redeliver` cannot recover them.

## Check Files home provisioning

Files consumes `core.user.created` for home provisioning and also reconciles
users through its existing `directory-maintenance` job. Startup and
configuration changes request `runNow`; periodic reconciliation processes at
most **50 users per run**, with a persisted cursor and configuration revision.
It starts no next user after a 30-second soft budget, finishes any in-flight
provisioning operation, and persists partial results. A running indicator
expires after 120 seconds without renewal, so a crashed worker does not
remain displayed as running.
This lets a changed configuration or a missed event converge through the same
provisioning service.

Local accounts provision the Cloud area under the existing
`cloud.autoCreate` setting. IPA accounts provision the FreeIPA area only when
the independent **`freeipa.autoCreate`** setting is enabled and the user's
POSIX identity is complete and agrees with the live FreeIPA identity check. `freeipa.autoCreate` defaults to **off** and uses
the same Files settings mechanism beside `cloud.autoCreate`. It does not
change the meaning of the Cloud-area option. Enabling it lets reconciliation
pick up eligible IPA users.

Administrators can inspect the result at:

```text
GET /api/filesv2/admin/provisioning?area=freeipa&after=<uuid>&state=failed
```

The success response contains `{ items, nextCursor, counts, reconcile }` inside the normal
`ok` result. Each item has `userId`, `username`, `area`, `state`, `operationId`,
`eventId`, `errorCode`, and `updatedAt`. Pass `nextCursor` as `after` for the
next page. `counts` groups all recorded users by area and state, independently
of the page filters. `reconcile` contains `lastRunAt`, `running`, and
`lastResult: { processed, done, pending, failed }` (or `null` before the first run).
The admin overview also includes this selected-area summary and the first
page of non-done users in its initial SSR snapshot. Paging uses the endpoint
above. The optional `area` filter accepts `cloud` and `freeipa`. The state filter accepts `not_configured`,
`auto_create_off`, `posix_incomplete`, `done`, `failed`, and `inactive`.

Check both the state and area before retrying. `auto_create_off` with
`area: "freeipa"` means the independent FreeIPA option is off; enable
`freeipa.autoCreate` when that provisioning is intended. Configure the storage
area for `not_configured`, complete the user's POSIX identity for
`posix_incomplete` (including an absent or mismatched live FreeIPA identity), and inspect `errorCode` for `failed`. The next maintenance
reconciliation uses the current configuration and recorded provisioning state.

The server-side user projection is
`accountIdentities.provisioningUsers({ provider?, id?, after? })`; omitting
provider scans both areas with one global user-ID cursor. It selects active accounts with profile
`user`, returns at most 50, and
exposes only their ID, provider, username, POSIX fields, and availability.
It is a trusted server-only projection for provisioning, not a general
user-directory API. `accountIdentities.provisioningIdentity({ kind: "users",
provider, name, identityId, signal? })` performs the same live identity check
as administrator provisioning, using the service's identity. Files requires
that the live FreeIPA name, UID and GID agree with the stored projection
before creating a home. An absent, incomplete or mismatched result remains
visible as `posix_incomplete`. A user's completed Cloud-area home does not
prevent provisioning after migration to FreeIPA.

## Create fixtures without exporting payloads

```sh
cld events record core.user.created --shape-only --limit 10 --out ./fixtures.jsonl
cld events replay ./fixtures.jsonl --handler ./local-handler.ts
```

Core samples the last `--limit` accepted stored events of the selected type
(at most 100) and writes one synthetic JSONL fixture per distinct shape.
Shapes contain version, present object keys, and array length buckets (0, 1,
2–4, 5–16, 17 or more); scalar values never determine the shape. Fixture IDs
are deterministic and distinct per shape. Values are synthesized from the
persisted declaration. Recording requires `--shape-only`. `--out` refuses to
overwrite an existing file. Replay validates against the current catalog and
calls only a local handler; it does not send fixtures to a server delivery
endpoint.

See [App events](/en/docs/platform/app-events) for the declaration, envelope,
and handler testing contract.

The status endpoint also lists up to 100 ingestion dead letters, with message
and event IDs, consumer, attempts, failure time, and reason. Inspect and recover
these through Core's existing Sync administration for `cloud:app-events` and
the durable consumer `core-app-events-v1`. Recovery uses the same idempotent
broker handler. No event payload is included in the status response.

At four matching subscribers and handlers averaging at most 500 ms, four
worker slots provide about eight attempts/s against 1.2 new deliveries/s at
the aggregate planning rate. This leaves retry and burst headroom. Slower
handlers or greater fan-out require a capacity review; backlog and failures
remain visible. There is no global publisher rate limiter for app events.

At 0.3 events/s, 30 days of Core history contain 777,600 envelopes: about
0.21 GiB at 285 bytes or up to 2.97 GiB at the 4096-byte limit, before table
and index overhead. At four subscribers and a conservative 4 KiB per delivery,
allow 2.77 GiB for seven days of completed rows, or 11.87 GiB for 30 days of
unresolved deliveries. Provision indexes and operational headroom separately.
The bounded cleanup removes at most 1000 rows from each retention class per
minute, above the planning rate of 72 new deliveries per minute.
