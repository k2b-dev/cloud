---
title: Scaling and shutdown
navTitle: Scaling and shutdown
section: Operations
order: 1150
description: Run multiple application instances and shut them down without losing work.
tags: [scaling, lifecycle, shutdown]
updated: 2026-10-20
---

# Scaling and shutdown

Cloud can run multiple replicas behind one stable service address. Cloud
registers one logical entry per application ID, and the gateway routes to that
service address.

Each gateway process sticks to one resolved address per service name. Behind
Docker Compose DNS with several A records, one gateway sends all its traffic to
one replica; the other replicas get traffic only from other gateway processes.
A per-connection balancer, such as a Kubernetes ClusterIP service through
kube-proxy, is expected to spread connections between replicas. Cloud has
measured the Docker Compose behavior, not the ClusterIP behavior. When the
replica a gateway uses stops, the gateway's next requests reach another
replica.

The nightly [scale acceptance](/en/docs/contributing/testing#scale-acceptance)
runs Core, Mail, Chat, and Notebooks with two replicas each in a disposable
stack. It checks live updates, draft leases, and delivery after one replica is
killed. It also restarts one Mail replica and stops and surges Chat replicas
while requests run through the gateway, and fails on any registry gap. Run it
locally with Docker:

```bash
bun run --cwd packages/ui build
bun --no-env-file scripts/scale-acceptance.ts
```

## Allow synchronous capability responses

Synchronous capability Queries now have a shared 45-second dispatch budget,
including preparation and response reading. Reviews remain at 15 seconds and
Actions at 30 seconds. See [Deadlines and cancellation](/en/docs/platform/capabilities#deadlines-and-cancellation).

The framework's JSON invocation handlers keep their request idle timeout at
the operation budget plus 10 seconds of transport headroom and restore the
normal 10 seconds after answering or failing. The gateway still waits up to
240 seconds for upstream response headers; its client-side idle maximum stays
255 seconds. An operator-owned reverse proxy must allow the synchronous
response to arrive. App-owned query limits, queues, and cancellation cleanup
still bound the underlying work; the larger transport budget adds no SQL
execution time and requires no new environment variable.

Execution-history inserts remain best effort with a 10-second wait budget
and a database statement timeout. A connection acquired too late cannot start
the insert. A Query response does not wait beyond its dispatch
budget for that insert; history may appear shortly after the response.

## What scales horizontally, what must stay single and why

Every application can run several replicas, except Assistant. The table names
what coordinates the replicas of each application and which per-process limits
grow with the replica count.

| Application | Several replicas | Coordinated by | Per-process limits that multiply |
|---|---|---|---|
| Gateway (`gateway`) | Yes | No registry entry; each process builds its route table from the shared registry. Give each replica its own `GATEWAY_INSTANCE_ID` or `HOSTNAME`, or their operations snapshots overwrite each other | None |
| Core (`core`) | Yes | NATS schedulers and keyed jobs with Postgres claims for AI turns, outgoing mail and notifications | 8 AI turn workers, 8 SMTP send workers plus 4 bulk send workers, 4 notification workers, 2 chat PDF conversions |
| Accounts (`accounts`) | Yes | Postgres draft rows and recipient claims | None |
| API Docs (`api-docs`) | Yes | Specs built per request from the shared registry | None |
| Assistant (`assistant`) | **No, one replica** | Code Mode hosts and their approval waits live in the Assistant process ([#47](https://github.com/k2b-dev/cloud/issues/47)) | +1 Postgres connection per replica |
| Capabilities (`capabilities`) | Yes | Catalog read from the shared registry and cached for 30 seconds | None |
| Chat (`chat`) | Yes | Postgres outbox to a NATS live topic; NATS scheduler for maintenance | None |
| Contacts (`contacts`) | Yes | Postgres outbox to a NATS live topic; NATS scheduler for retention | None |
| Dashboard (`dashboard`) | Yes | Postgres rows per person | None |
| FAQ (`faq`) | Yes | Postgres only | None |
| Files (`filesv2`) | Yes | NATS mutexes and Postgres reservations for operations and uploads | 4 uploads |
| Gateway operations (`gateway-ops`) | Yes | NATS scheduler and slot-keyed jobs; one durable NATS consumer for telemetry | Metrics collected by every replica |
| Grids (`grids`) | Yes | Postgres outbox claims, NATS mutexes and schedulers | Workflow slots (`grids.workflow_concurrency`, default 10); extra Postgres pools for queries (`grids.query_pool_size`, default 12 connections), workflow effects (10) and number series (4) |
| Hosts (`ipa-hosts`) | Yes | NATS scheduler and slot-keyed sync job | None |
| Mail (`mail`) | Yes | NATS lease for IMAP IDLE, NATS draft leases, NATS jobs and Postgres claims | 4 provider jobs per kind, 2 workflow slots |
| Notebooks (`notebooks`) | Yes | Shared NATS document log; snapshot job partitioned by note | 2 PDF conversions |
| OAuth (`oauth`) | Yes | Valkey consent state; Postgres consumes codes and refresh tokens atomically | None |
| Proxy Auth (`proxy-auth`) | Yes | Postgres reads per verification; Valkey return state | None |
| Pulse (`pulse`) | Yes | NATS scheduler and keyed scrape jobs; Postgres lock per source | Scrape, rollup and retention workers |
| Cloud app (`pwa`) | Yes | Core's Postgres pairing locks | None |
| Quotes (`quotes`) | Yes | Valkey cache | None |
| Spaces (`spaces`) | Yes | Postgres locks and outbox; Valkey link previews | None |
| Tools (`tools`) | Yes | Postgres rows for webhook endpoints | 2 PDF conversions |
| Venues (`venue`) | Yes | NATS scheduler for shift notices | None |
| Weather (`weather`) | Yes | Valkey forecast cache | None |

Keep **one Assistant replica** for now. Code Mode hosts and their approval
waits live in the Assistant process, so a poll or an approval that reaches
another replica marks the call lost. This limit belongs to the Code Mode host
work in [#47](https://github.com/k2b-dev/cloud/issues/47).

A per-process limit protects one process, not the service behind it. With
several replicas, Gotenberg, Filegate, the SMTP relay, model providers and
Postgres see the limit once per replica: two Core replicas run up to 16 AI
turns and 24 SMTP sessions. Every replica also opens its own Postgres pool of
up to 10 connections, plus the extra pools in the table. Size those services
for the replica count. A shared budget is tracked in
[#1626](https://github.com/k2b-dev/cloud/issues/1626). Live updates allow 16
sockets per viewer on each replica. Workflow slots also count per replica; see
[Emit events and start runs](/en/docs/automation/emit-events-and-start-runs).

Where availability matters, run at least **two Mail replicas** from the release
that contains the registry fix for
[#1561](https://github.com/k2b-dev/cloud/issues/1561) and the Mail memory bound
from [#1571](https://github.com/k2b-dev/cloud/pull/1571). Give each Mail replica
a container memory limit of at least 1.5 GiB; see
[Size Mail for large messages](/en/docs/operations/deployment-requirements#size-mail-for-large-messages).
While a single Mail
replica restarts, for example after an out-of-memory kill
([#1549](https://github.com/k2b-dev/cloud/issues/1549)), Mail pages and API
requests return **Bad Gateway**. The number of replicas in production is your
decision.

## Scale stateless request handling

Application processes may keep caches and clients in memory. Domain state must
remain in shared services such as Postgres, Valkey, or Filegate.

Do not use process memory for:

- sessions;
- durable jobs;
- cross-request locks;
- application records;
- authoritative presence.

Use [Data](/en/docs/data) and
[Automation](/en/docs/automation) for shared state.

## Application registration

Every reader uses one logical application entry and one capability manifest per
application ID. Use the same stable `baseUrl` for every replica.

Each process also keeps a small liveness key for its instance. A running
replica renews its keys every 60 seconds. All keys have the same 180-second TTL.
Liveness keys share the application registry under `instances/`, so read
application entries with the `apps/` prefix (`APP_REGISTRY_PREFIX`), as
`listApps()` and the gateway do.

A clean stop removes only its own liveness key. It removes the shared entries
only when no other live instance remains. Stopping one replica keeps the app
registered; the last replica's clean stop removes it at once. A crashed
instance stops renewing its liveness key, which ages out after 180 seconds.
Until then, the crashed instance counts as live. If the last running replica
stops cleanly in that time, the shared entries stay until their own 180-second
TTL ends, and the gateway answers the app's routes with 502 upstream errors.
Shared entries also expire after 180 seconds if no replica renews them.

During a rollout, the most recently started live instance's entry wins.
Starting writes the entry. Refresh renews it and writes it again only when it
is missing, when the instance that wrote it has stopped, or when that instance
started earlier. So a newer replica takes the entry back within 60 seconds
after an older one repaired it. When the instance that wrote the current entry
stops while others run, a remaining replica replaces the entry with its own on
its next refresh, within 60 seconds. After a crash, this happens once the
crashed instance's liveness key has aged out. Until then, the departed
instance's routes and capability manifest stay published. A replica always
writes its application entry and capability manifest together. If a delayed
write still leaves the two from different replicas, the next refresh restores a
matching pair. Start order uses each host's clock, so keep host clocks
synchronized.

The registry has no conditional delete. If NATS applies a stopping replica's
delete only after its lock lease ended, the delete can remove an entry that a
new replica has just written. That replica writes it again within 60 seconds.

The gateway rebuilds its route table when registry entries change. It renews
its own operations snapshot every five seconds, including when the registry is
idle, so its 30-second presence lease and request counters stay current.

Use the orchestrator, not the Cloud registry, to measure replica health and
count.

During a rolling deployment, old and new instances may both receive traffic.
Keep database changes backward-compatible until the rollout completes.

## Roll out replicas

A clean stop of one replica keeps the application routed while another replica
runs. Short windows remain; see
[Application registration](#application-registration) and the upgrade note in
[Verify readiness and upgrades](/en/docs/operations/deployment-requirements#verify-readiness-and-upgrades):

- within 180 seconds after a replica crashed, a clean stop of the last running
  replica keeps the shared entries until their own 180-second TTL ends, and the
  gateway answers the app's routes with `502` meanwhile;
- while replicas of the previous version run, during the rollout to this
  release and during a rollback, a stopping replica can delete the shared entry
  once; surviving replicas restore it within 60 seconds;
- a delete that NATS applies late can remove the entry a new replica has just
  written; that replica writes it again within 60 seconds.

Replicas of one application can boot together: setup runs on one replica at a
time, and the later ones wait for it; see
[Use lifecycle hooks](#use-lifecycle-hooks).

A stopping process does not drain HTTP yet. On `SIGTERM` it runs its stop
hooks, stops Sync, and exits while its HTTP server still accepts requests, and
its readiness still reports ready. Requests that reach it during this time can
fail when they need NATS. Requests in flight and open SSE streams are cut at
exit. If the replica had not sent response headers yet, the gateway answers
with `502` and `Retry-After: 3`. A response or SSE stream that had already
started keeps its status and ends with a broken body, so the client must retry
or reconnect. Live sockets close and reconnect. Graceful HTTP shutdown is
tracked in
[#1625](https://github.com/k2b-dev/cloud/issues/1625).

Until then:

- drain at the ingress: take the replica out of the service before it receives
  `SIGTERM`, for example with a Kubernetes `preStop` delay that is longer than
  the endpoint update. This stops new connections; connections a gateway
  already holds can still reach the replica until it exits;
- size the termination window; see
  [Set the termination window](#set-the-termination-window).

## Use lifecycle hooks

```ts
await app.start({
  fetch: router.fetch,
  lifecycle: {
    setup: async () => {
      await migrateInventory();
    },
    start: async () => {
      await workers.start();
    },
    stop: async () => {
      await workers.stop();
    },
  },
});
```

`setup` runs before background work, on one replica of an application at a
time. Use it for idempotent migrations. Later replicas wait until it finishes,
logging `waiting for setup on another replica`. If a replica crashes or is
stopped during setup, its turn expires after about a minute. A replica that
loses its turn during setup fails its start and restarts, so setup runs again.

`start` begins workers and subscriptions.

`stop` releases them. Cloud calls it on `SIGTERM` and `SIGINT`, then stops
notification registration, the runtime watcher, and the registry heartbeat.

## Drain background work

Stop accepting new work before waiting for in-flight work.

Sync tracks each accepted worker handler and owns its drain and cancellation.
Call the domain operation directly from the handler; a second task tracker can
reject an already accepted delivery during shutdown and let it be acknowledged
without running.

Use `createRuntimeTaskTracker()` only for work outside Sync handlers, such as
recovery scans and publishers. `stopRuntimeJobs()` stops
new pulls, then drains workers and tracked tasks concurrently. Both have a
30-second deadline by default; pass `{ timeoutMs }` as the third argument to
match the application's shutdown budget. Starting the worker drain immediately
allows Sync to abort unfinished handlers at that deadline. Cleanup reports an
error when tracked work exceeds the deadline, including work that ignores its
abort signal. `stopRuntimeResources()` attempts every cleanup function and
combines failures.

Background frameworks may also provide leases and retry. Follow their shutdown
contract. See [Lifecycle background work](/en/docs/automation/lifecycle-background-work).

## Set the termination window

The process exits after lifecycle shutdown finishes. Give the container enough
termination time for:

- request draining at the ingress;
- current database transactions;
- worker lease release;
- tracked tasks;
- registry removal.

Make stop hooks idempotent. A startup failure can require cleanup before the
service fully starts.

Test shutdown with real `SIGTERM`, not only a local process kill.
