---
title: NATS operations
navTitle: NATS operations
section: Operations
order: 1165
description: Inspect NATS infrastructure, investigate Sync failures, and configure independent outage monitoring.
tags: [nats, sync, observability, operations]
updated: 2026-09-08
---

# NATS operations

Use **Observability → NATS** (`/admin/observability/nats`) to inspect broker
infrastructure. Use **Observability → Sync** (`/admin/observability/sync`) to
investigate application work and perform supported recovery actions. Both
pages require administrator access.

For cluster provisioning, persistence, payload limits, and coordinated
upgrades, follow [Deployment requirements](/en/docs/operations/deployment-requirements).
The NATS page is read-only: it does not change configuration, delete resources,
or acknowledge work.

## Give Gateway Ops access to diagnostics

Gateway Ops uses the installation's application-account connection to inspect
JetStream streams and consumers. Cluster-wide server diagnostics use a
separate system-account connection:

| Variable | Purpose |
| --- | --- |
| `NATS_ADMIN_SERVERS` | Bootstrap URLs for the separate diagnostics connection |
| `NATS_ADMIN_CREDS_FILE` | Mounted credentials for the NATS system account |
| `NATS_ADMIN_NKEY_SEED_FILE` | Mounted system-account NKey seed, as an alternative to the credentials file |
| `NATS_ADMIN_TLS_CA_FILE` | Trusted CA file for the diagnostics connection |

Set these only on Gateway Ops. Do not distribute system credentials to other
Cloud applications or replace their `NATS_CREDS_FILE` with an administrator
credential. Mount credential files through the deployment's secret system;
never place their contents in Compose, Git, or support reports.
Choose either a credentials file or an NKey seed file, not both.

The diagnostics identity needs permission to request
`$SYS.REQ.SERVER.PING.JSZ` and `$SYS.REQ.SERVER.PING.VARZ` and receive inbox replies.
The node table shows process RAM from VARZ, including buffers and caches.
JetStream memory-storage metrics measure memory-backed streams separately;
these can be zero when streams use file storage.
Storage columns combine usage, the configured limit, and percentage used.
Metadata replication status comes from the elected leader: followers omit the
replica list. Green means synchronized, orange means behind or unknown, and red
means a reported missing leader, missing replica, or offline replica. If the
leader snapshot is unavailable, replication is unknown and cluster snapshot
metrics report incomplete diagnostics. JetStream inspection uses
the application account's `$JS.API.STREAM.LIST` and
`$JS.API.CONSUMER.LIST.*` requests. The page does not display payloads,
subject filters, credentials, or raw broker errors.

See [Runtime configuration](/en/docs/operations/runtime-configuration) for
the complete environment contract. If cluster diagnostics are not configured,
the page distinguishes that state from an unavailable broker.

In the monorepo, `bun run dev:infra` prepares a local system identity under
`.local/nats` before starting the infrastructure. The seed stays outside Git
and is mounted only in Gateway Ops. Existing application streams remain in
the global `$G` account; the system account remains `$SYS`. When invoking
infrastructure Compose directly, first run
`bun packages/gateway-ops/scripts/dev-nats.ts`.

## Inspect a failing deployment

Start with the responding NATS nodes, then inspect the affected stream and its
consumers. Check storage usage and limits, stream leadership and replicas,
pending acknowledgments, redeliveries, and consumer backlog. A consumer with
pending work is not by itself evidence of failure; compare progress over time
and inspect the owning application's logs.

Stream and consumer lists are paginated; select a stream to inspect its
consumers. Unknown measurements remain unavailable rather than becoming zero.
An incomplete or unavailable
inventory does not prove that no resources or failures exist. The Sync page
reports the runtime of the responding application process, not every replica
of that application. Handles created on first use appear there only after
that use.

Keep streams and application data when investigating errors. Removing a
stream deletes retained work and can make unsnapshotted notebook edits
unrecoverable. For `ResourceDriftError`, follow the release's specific recovery
instructions rather than deleting a namespace to make readiness pass.

## Alert on dead letters and broker health

Configure health webhooks under **Observability → Webhooks**. The existing
`gateway.health_check_schedule` setting controls evaluation; its default is
every five minutes. The webhook's scope, minimum status, change behavior, and
repeat settings still apply.

A nonempty Sync dead-letter store raises an error for its owning application.
Failures without an identified application owner affect infrastructure health.
Missing stream leadership or an offline replica raises an error; lagging or
not-current replicas raise a warning. An incomplete or unavailable inventory
raises a warning instead of reporting zero failures. Broker infrastructure
signals also apply to webhooks scoped to particular applications. Leaving the
optional system-account connection unconfigured is not itself an alert.

The checks and webhook delivery use NATS. During a complete broker outage,
Cloud cannot guarantee delivery until the broker recovers. Run an external
monitor on its own schedule and alert on failed scrapes, broker availability,
storage pressure, and replication health. Cloud's `/metrics` endpoint uses
the credentials managed under **Observability → Metrics**; monitor collection
failures as well as the returned measurements.

Useful scrape signals include:

| Metric | Meaning |
| --- | --- |
| `cloud_nats_cluster_configured` / `cloud_nats_cluster_up` | Whether system diagnostics are configured and complete |
| `cloud_nats_inventory_up` | Whether the account stream inventory is complete |
| `cloud_nats_consumer_inventory_up` | Whether consumer pagination completed within the scrape budget |
| `cloud_nats_node_storage_bytes` / `cloud_nats_node_storage_limit_bytes` | Physical node usage, including replicas and all accounts |
| `cloud_sync_dead_letters` | Retained transport failures, grouped by namespace, owner, and kind |
| `cloud_sync_streams_replication_unhealthy` | Streams with missing or lagging replicas |
| `cloud_sync_consumers_pending` / `cloud_sync_consumers_ack_pending` / `cloud_sync_consumers_redelivered` | Consumer delivery counters, grouped without per-note labels |

Incomplete inventories omit aggregate totals instead of presenting partial
counts as complete. Node storage and logical stream storage measure different
things and must not be added together.

## Recover failed application work

On **Sync**, inspect a dead letter and the owning application's error before
retrying. Fix the cause first. Transport recovery does not replace an
application's separate recovery process for failed workflows or database
outbox entries.

Queue and job recovery submits another attempt. Topic recovery invokes only
the original consumer's handler; it does not republish the event to every
subscriber. The original event identity is retained so the receiving handler
can deduplicate effects. Delivery remains at least once.

Topic replay requires retained original sequence and timestamp metadata and
an active consumer that supports recovery. Older entries without that metadata
remain available for inspection and deletion, but cannot be replayed through
Sync. Failed or timed-out recovery retains the dead letter. Inspect the result
and the application's durable state before trying again; deleting an entry
removes recovery evidence without repairing the failed effect.

## Accept an updated installation

After the coordinated deployment, verify application readiness, NATS resource
health, normal domain operations, and restart recovery. Confirm that the
external monitor detects a broker outage and that configured health webhooks
reach their intended destination. Code checks and a healthy local development
stack do not constitute production acceptance.

Retain the recovery point and old broker resources until the deployment's
migration checks pass. See the
[notebook snapshot cutover](/en/docs/operations/notebooks-snapshot-cutover)
before removing historical notebook streams.
