---
title: NATS operations
navTitle: NATS operations
section: Operations
order: 1165
description: Inspect NATS infrastructure, investigate Sync failures, and configure independent outage monitoring.
tags: [nats, sync, observability, operations]
updated: 2026-10-30
---

# NATS operations

Use **Observability → NATS & Sync** (`/admin/observability/nats`) to inspect broker
infrastructure. Use **Observability → NATS & Sync → Sync** (`/admin/observability/nats/sync`) to
investigate application work and perform supported recovery actions. Both
pages require administrator access.

For cluster provisioning, persistence, payload limits, and coordinated
upgrades, follow [Deployment requirements](/en/docs/operations/deployment-requirements).
The NATS page is read-only: it does not change configuration, delete resources,
or acknowledge work.

## Find the affected work

Both pages show the snapshot time and a **Refresh** action. They do not
continuously monitor the installation. Reload after a recovery action or when
comparing whether a backlog is shrinking.

On NATS, filter by app owner, namespace, resource name, or problems. Filters
apply to a bounded account scan before pagination. An incomplete scan is marked
partial; its counts describe only the resources that were inspected. Metadata
replication is the cluster's state, while RAM and storage usage belong to each
node. Select a stream to inspect consumer backlog and acknowledgments.

On Sync, filter by app ID, resource ID, or problems. The overview samples failures
per store. Open a store to page through older retained failures without deleting
newer entries. Store pages are ordered by broker sequence, oldest first. Each
page is a new snapshot: concurrent processing or deletion can change the list.
Open **Details** to read the message ID, tenant, original topic consumer and event,
error, and a bounded payload preview. The stored message is unchanged.

For schedules, check handler availability and the last completed run. **Run now**
asks for confirmation, reports acceptance, and waits briefly for the outcome.
If the run is still pending, use **Check result**; this does not start another
run. An unavailable result is not reported as success. The UI reuses the request
ID when retrying an unconfirmed submission within the current page.

## Read diagnostics with the CLI

Use the same administrator identity as the UI. OAuth callers also need the
`admin` scope. JSON diagnostics use `/api/gateway/nats` and `/api/gateway/sync`;
the CLI handles authentication and URL encoding.

```bash
cld admin nats status --json
cld admin nats streams list --app mail --namespace dev --problems --limit 20 --json
cld admin nats consumers list <stream> --json
cld admin sync status --json
cld admin sync resources list --app mail --problems --json
cld admin sync dead-letters list <app> <queue|job|topic> <store> --limit 20 --json
cld admin sync dead-letters get <app> <queue|job|topic> <store> <message> --sequence <streamSequence> --json
cld admin sync schedules list --app mail --json
cld admin diagnose --include sync,nats --json
```

Pass the returned `nextOffset` as `--offset` for NATS, or `nextCursor` as
`--cursor` for a Sync store. Queue and job detail lookups require the entry's
`streamSequence`; topic details use the message ID. `--json` retains snapshot,
completeness, and pagination metadata. List commands also support `--jsonl`:
a typed `snapshot` record precedes the selected records. Do not treat incomplete
or unavailable results as an empty, healthy installation. Diagnostic bundles
omit Sync payload previews.

Recovery commands require `--yes`. Queue/job requeue creates a new idempotency
key; topic replay targets its original consumer. Check the failure first.

```bash
cld admin sync dead-letters requeue <app> <queue|job> <store> <message> --yes
cld admin sync dead-letters replay <app> <store> <message> --consumer <consumer> --tenant <tenant> --yes
cld admin sync dead-letters delete <app> <queue|job|topic> <store> <message> --yes
cld admin sync schedules run <app> <scheduler> <schedule> --request-id <stable-id> --yes
cld admin sync schedules runs get <app> <scheduler> <schedule> <run-id> --timeout-ms 5000 --json
```

Reuse the same schedule request ID after an uncertain response. A returned run
ID means accepted work; `completed: false` means it has not settled yet.

## Give Gateway Ops access to diagnostics

Gateway Ops uses the installation's application-account connection to inspect
JetStream streams and consumers. Cluster-wide server diagnostics use a
separate system-account connection:

Open **Administration → Observability → NATS → Diagnostics access** and configure:

| Setting | Value |
| --- | --- |
| `gateway.nats_admin_servers` | System-account server URLs; empty disables cluster diagnostics |
| `gateway.nats_admin_access_kind` | `creds` for .creds file content, or `nkey` for a user NKey seed |
| `gateway.nats_admin_access` | **System access**: paste the complete .creds content or seed, stored as an encrypted secret |
| `gateway.nats_admin_tls_ca` | Trusted CA certificate or certificate bundle as PEM text; empty uses the default trust store |

Changing the server list discards saved system access and keeps cluster diagnostics off until you enter access again (or explicitly clear it for an anonymous connection), including changes through the settings API, CLI, or environment import.
Re-enter existing access once after updating so it is bound to the current server list.

Changes apply to the next diagnostics connection, including **Refresh**, CLI
reads, metrics collection, and health checks. When changing the access format,
replace System access too; a mismatched format keeps cluster diagnostics off.
Use `tls://` server URLs when using TLS with the default trust store. A custom
CA enables TLS on the diagnostics connection.

If the saved settings cannot be read, cluster diagnostics report unavailable
and omit `cloud_nats_cluster_configured` until the configuration is known.
Application-account inventory and consumer metrics continue independently.

System credentials belong only to Gateway Ops. Do not distribute them to other
Cloud applications or replace application-account credentials with system
credentials. Never place their contents in Compose, Git, or support reports.
The secret is hidden in administration responses and cannot be read back there.

For this release, `NATS_ADMIN_SERVERS`, `NATS_ADMIN_CREDS_FILE`,
`NATS_ADMIN_NKEY_SEED_FILE`, and `NATS_ADMIN_TLS_CA_FILE` are deprecated startup
imports. Missing settings import server URLs and **file contents**, including
the access format. Stored rows always win, including empty or unreadable rows.
Unreadable files produce a warning naming the variable and path and prevent
an incomplete bootstrap from enabling diagnostics. Correct the mount and
restart Gateway Ops, or save the settings in Administration. Remove the old
environment values and mounts after checking the imported settings and
refreshing the NATS page. Resetting a setting while the old environment is
still present allows it to be imported again at the next startup.

The diagnostics identity needs permission to request
`$SYS.REQ.SERVER.PING.JSZ` and `$SYS.REQ.SERVER.PING.VARZ` and receive inbox replies.
Grant only these diagnostics permissions; do not use an unrestricted system identity.
The node table shows process RAM from VARZ, including buffers and caches.
JetStream memory-storage metrics measure memory-backed streams separately;
these can be zero when streams use file storage.
Storage columns combine usage, the configured limit, and percentage used.
Standalone JetStream nodes have no metadata Raft group. A complete standalone
snapshot is healthy and emits no metadata replication metrics.

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

For development credentials and Compose setup, see
[Monorepo development](/en/docs/operations/monorepo-development#configure-local-nats-accounts).

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

## Restart NATS and applications together

Applications and the gateway do not need to start after NATS. They wait for
NATS and JetStream when they start: after a host restart, a process that
comes up before NATS logs `NATS or JetStream is not ready; retrying` with the
reason, such as a refused connection, an unknown host, or
`JetStream system temporarily unavailable`, and continues once JetStream
answers. It reports readiness only after that. Rejected credentials and a
missing credentials or CA file are retried the same way, because an
authorization service or a mounted secret can still be starting; check the
logged reason when the wait does not end.

A process that gets no answer within five minutes exits with status 1. Give
every service a restart policy, such as `restart: unless-stopped` in Compose
or the default `Always` in Kubernetes. Repeated restarts with this error mean
that NATS or its JetStream cluster is not recovering; inspect the NATS nodes
before the application.

After a successful start, the NATS client keeps reconnecting for the life of
the process. When an outage keeps the application from renewing its
180-second registry lease, it exits shortly before the lease expires, about
165 seconds after its last successful renewal. Its next start waits for NATS
again.

A broker can also stall briefly without an outage, for example while a
snapshot backup freezes its file system. Requests then time out until the
broker answers again. Short-lived work that hits such a timeout fails and is
retried as its job or queue allows.
Mail's IMAP push listeners retry lease renewals that got no answer. They
stop only when the lease could run out before a renewal succeeds, or when
NATS answers that the lease could not be extended, for example because
another process holds it. Stalls that repeat at the times of a backup
schedule point to that schedule.

## Alert on dead letters and broker health

Configure health webhooks under **Observability → Alerts & webhooks**. The existing
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
before removing historical notebook streams. Notebooks retires its per-note
document topics itself; the
[Notebook document log](/en/docs/operations/notebooks-document-log) describes
how to observe that migration and how to recover an exhausted account.
