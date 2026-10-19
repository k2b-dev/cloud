---
title: Pulse
navTitle: Pulse
section: Operations
order: 420
description: Collect metrics, events, and states from your sources.
tags: [pulse, telemetry, metrics]
updated: 2026-10-17
---

# Pulse

Pulse collects metrics, events, and current states from sources. It can describe infrastructure,
application behavior, or business activity without requiring one fixed domain
model.

## Set up the data store

A Cloud admin connects an operator-provided ClickHouse instance in
**Administration → Pulse → Data store**. The page shows three steps: provide
a dedicated ClickHouse 26.9 or newer instance, run the setup script as its
admin, then enter the service address and credentials and choose **Check and
connect**. Pulse checks the connection, version, rights and read-profile limits
before saving. A failed check names the problem and how to fix it; the saved
connection stays unchanged.

Operators can use `cld pulse admin store get|set|check|setup-sql` for the same
workflow. Password input uses a private file or stdin. See
[Provide ClickHouse for Pulse](/en/docs/operations/deployment-requirements#provide-clickhouse-for-pulse)
for memory, isolation and backup requirements.

Without a saved connection, Pulse shows “not set up” and its data API returns
`PULSE_STORE_NOT_CONFIGURED`. Cloud and the Pulse administration pages remain available.

## Bases and administration

Each base is a tenant with its own ClickHouse database, read user and six SQL
views. Read access excludes internal tables, sensitive fields, payloads and
other bases. Base admins manage members, sources, tokens
and retention; they do not need the Cloud admin role. By default, people and
agents with write credentials can create a base and become its admin. A Cloud
admin can restrict creation to people or Cloud admins and set the maximum
(default 200) under **Administration → Pulse → Bases**. The policy judges who
sends the request: a service account counts as an agent, also when it acts for
a person, and the admin grant then goes to that person.

New bases are `provisioning`, then `active`. Only active bases accept changes.
Clearing (`clearing`) keeps sources and tokens. Deleting
(`deleting`) revokes source tokens and read access before removing
the store. A base in deletion stays on its admins' Pulse overview until the
deletion finishes. After five failed runs, the operation is `failed`; a base
admin can choose **Retry** in the base settings or on the overview, and a Cloud
admin can retry from the Bases page.

Cloud admins see state, amounts and limits, without measurement contents. They
choose a read profile (small: 1 GB/10 s; normal: 2 GB/10 s; large: 4 GB/30 s),
each limited to 10,000 rows and 4 MiB per query. Defaults per base are 2,000
values/minute, 5 MiB/minute, 5 GB storage, 50,000 series, 2,000 event kinds and
2,000 state keys. Pulse measures each base's storage every five minutes and
shows it, with the free space of the store, to base admins and Cloud admins.

Raw retention is 1–730 days by default (Cloud admins can raise the maximum to
3,650); rollups allow 1–3,650 days and sensitive fields 1–8,760 hours. Shortening
any period returns a cutoff and affected-row preview with estimated bytes; for
sensitive fields it counts the non-empty fields that are cleared, while their
rows stay. Confirm it to apply the change. Sensitive fields use column TTL; physical
removal follows ClickHouse merges. Current states have no TTL.

Hourly checkpoints compare Postgres and ClickHouse. A missing database or a
mismatch blocks measurement writes, and a base admin cannot clear the base
while it is blocked. After restoring matching backups, a Cloud admin chooses
**Recheck** to verify and recreate read access, or **Recreate** to discard
measurements and start empty. When Pulse starts, it re-creates missing read
users of bases whose checkpoints match. Databases without a base appear as
orphans and can be deleted separately.

## Use Pulse

Open a base to manage its sources. Check Sources when expected data is missing
or stale. Earlier dashboards and saved queries were removed with this update;
existing view URLs explain the change and link to Sources.

## Understand the Pulse model

| Concept | Purpose |
| --- | --- |
| Base | Access, retention, and sources for one telemetry context |
| Source | Metrics endpoint or HTTP ingest connection |

Dimensions distinguish stable variants such as region, route, mount, or
service. Put unique request IDs, sessions, full URLs, and protected details in
event fields rather than metric dimensions.

## How Pulse fits Cloud

Pulse owns ingestion, retention, and source management inside each base. Cloud supplies identity, resource access,
application routing, lifecycle hooks, and operational primitives. A source
credential belongs to one source and does not grant access to unrelated bases.

## Find detailed product help

Open **Help** inside Pulse for the data model, source health,
retention, access, HTTP ingest, and troubleshooting. Developers can
read [Observability](/en/docs/operations/observability),
[Resource authorization](/en/docs/identity/authorization), and
[Resource API keys](/en/docs/identity/resource-api-keys) for adjacent Cloud
contracts.

## Inspect Pulse from the terminal

The native module can inspect a deployment before a script chooses a base:

```bash
cld pulse list --json
cld pulse capabilities --json
```

Run `cld pulse help` for bases, sources, ingest, and access. Run `cld pulse <command> --help` before ingesting data or changing a
base.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.

Pulse initializes its tables atomically in a fresh `pulse` schema. Later starts
reuse that installation without changing its data. Existing Alpha schemas are
rejected: there is no automatic upgrade or data repair. Before replacing a
disposable Alpha installation, explicitly remove only its Pulse schema; the
application never deletes it on startup.

## Server collection before deployment

Metrics support gauges and nonnegative counters. Type and unit are fixed per metric name within a base; conflicting input rejects the entire batch. Histogram and summary aggregation is not supported.

Prometheus sources accept declared gauge/counter families and expose skipped samples in source diagnostics. Scrapes use whole-minute intervals (minimum 60 seconds), one collection timestamp, and a 15-second timeout covering lookup, connection, headers, and body. Sources with no instance, host, or node label use the endpoint host and port as their target resource.

Public endpoints work for every base. A Cloud admin releases internal targets per
base under **Administration → Pulse → Internal targets**: a host or IP for all
ports, `host:port` or `[ipv6]:port` for one port, or a CIDR range for all ports.
`/0` is refused. Reserved names need an exact host entry. Pulse checks on save,
every scrape and every redirect (at most three), resolves again and pins the
connection. Revoking an entry blocks the next scrape and names the repair path.
Responses must use identity encoding.

The initial operator scenario is 20–50 servers, approximately ten websites, 60-second sampling and 30-day raw retention. Website backends send events using secret source tokens. This is a test scenario, not a measured production capacity guarantee.

## Retention and complete metric hours

Pulse records whether each metric hour is dirty, complete or sealed. The hourly
worker resumes unfinished hours after downtime without a fixed lookback limit.
Late samples and corrections inside raw retention mark the hour dirty again.

Raw metric retention preserves the entire boundary hour. Older raw hours are
removed only after successful rollup and sealing. Sealed hours reject later
writes, including after an operator extends retention: deleted samples cannot be
reconstructed. Metric ingestion rejects timestamps older than raw retention.
Rollup retention also applies to full hours.

Hourly rollups retain sample count, sum, minimum, maximum and the last value with
its actual timestamp.

Retention also removes expired scrape history and unreferenced metric series,
definitions, resources and field metadata. Current state persists until replaced
or explicitly cleared, independently of history retention. A resource or field
still needed by current state or retained observations remains in its catalog.
Continuously creating new state identities therefore requires an explicit
operator lifecycle; raw retention does not bound that inventory.

## Website analytics from your backend

Create one HTTP ingest source per website and keep its source token in the
website backend's secret store. Send to `POST /api/pulse/ingest` with
`Authorization: Bearer <source-token>`. Do not include this token in browser
JavaScript. Token rotation keeps the same source and identity namespace.

Use `page.viewed` for an observed pageview and `conversion.completed` for an
explicit business outcome. For both, use one website resource, for example
`{"type":"website","id":"example.com"}`. Do not create resources for individual
requests or visitors.

| Field | Website convention |
| --- | --- |
| `dimensions.route` | Route template such as `/articles/:slug`, not a unique URL |
| `dimensions.campaign` | Optional controlled campaign name |
| `attributes.referrerHost` | Optional hostname, with URL parameters removed |
| `actorId` | Optional opaque visitor ID supplied by the backend |
| `sessionId` | Optional opaque session ID supplied by the backend |
| `sensitive` | Optional short-lived sensitive fields, under the base's separate policy |
| `payload` | Additional event details that should not become dimensions |

Pulse does not derive identities from IP addresses or user agents and does not
create sessions.

A backend delivery can use this request. Persist the body and delivery ID before
sending if delivery must survive a backend restart:

```ts
const body = JSON.stringify({
  events: [{
    kind: "page.viewed",
    ts: new Date().toISOString(),
    resource: { type: "website", id: "example.com" },
    dimensions: { route: "/articles/:slug" },
    actorId: visitorId,
    sessionId,
  }],
});
const response = await fetch(`${pulseUrl}/api/pulse/ingest`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${sourceToken}`,
    "content-type": "application/json",
    "idempotency-key": deliveryId,
  },
  body,
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Pulse ingest failed: ${response.status}`);
```

On a timeout, connection failure, 429 or server error, retry the unchanged body
with the same delivery ID within 24 hours, using bounded backoff in your backend
queue. Other client errors require correcting the request. A correlation ID is
not a deduplication key. Automatic indefinite retries and durable backend queues
are not provided by this example.
