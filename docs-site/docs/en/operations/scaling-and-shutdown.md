---
title: Scaling and shutdown
navTitle: Scaling and shutdown
section: Operations
order: 1150
description: Run multiple application instances and shut them down without losing work.
tags: [scaling, lifecycle, shutdown]
updated: 2026-11-02
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

## Upgrade Help and Skill publication

Core 0.68 introduces registry-based catalog retention. Upgrade Core first to
reduce catalog writes immediately. Third-party applications may also update
`@k2b/cloud` before the operator upgrades Core: their publishers automatically
keep the legacy once-per-minute timestamp renewals while the retention column
is absent. This prevents old Core from deleting healthy catalogs after six
minutes and avoids repeatedly rebuilding their Help search documents.

Each renewal checks for the new column. Once Core's schema upgrade adds it,
the process automatically returns to publication at startup, on content
changes, on replica takeover, and when repairing missing sources. Unchanged
heartbeats then perform indexed existence reads without catalog writes; no
application restart is needed to leave legacy mode. Core before 0.68 still
uses timestamp expiry, so upgrade all Core replicas together before completing
the rollout of the new retention behavior.

Rolling Core back to a release before 0.68 keeps the added column, so updated
publishers stay in registry mode while old Core expires catalogs by timestamp.
Each publisher's heartbeat finds its missing source and publishes it again, so
Help and Skills can be missing for up to one heartbeat at a time until Core is
upgraded again. Core also reconciles all catalogs once a day, so a catalog that
a failed startup published without registering is removed after its day of
grace.

New Core accepts the existing catalog tables and renewal statements from
older applications, including published `@k2b/cloud 0.55.0`. Their
minute-by-minute writes remain compatible. It retains the registered app/hash
pair indefinitely. Other hashes
and sources of removed apps receive one day of grace before bounded deletion,
including all localized Help documents. An older replica taking over rewrites
its sources before advertising them. A returning publisher clears pending
deletion in its publication transaction, before Core sees its registration.

A missing source produces a publisher warning and is restored on its next
heartbeat. Restarting the application republishes immediately. Catalog cleanup
uses registry changes and pending deletion deadlines; an early timer firing
re-arms the remaining grace period.

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
| Gateway (`gateway`) | Yes | No registry entry; each process builds its route table from the shared registry. Each process uses a random ID for its operations snapshots. Remove the deprecated `GATEWAY_INSTANCE_ID` override; `HOSTNAME` is no longer used as an ID | None |
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

PDF rendering and outgoing SMTP have installation-wide admission budgets in
Valkey: **2 Gotenberg requests** and **8 SMTP sessions**, shared across apps,
replicas, immediate mail, bulk mail, and profile test sends. These preserve the
previous single-process PDF and immediate SMTP limits as the baseline, rather
than multiplying them by the replica count. Keep the same `SYNC_NAMESPACE` and
Valkey service on every replica. During the upgrade, older replicas do not take
these slots; the fleet budget applies once all callers run this release.

Admission makes one attempt without queuing and uses the operation's existing
deadline. Gotenberg saturation or unavailable Valkey returns `busy`; Notebooks
and Tools return HTTP 503. SMTP saturation leaves mail queued with a visible
busy error and the existing retry policy; profile test sends return 503. A slot
is released after response consumption or SMTP transport cleanup. If a process
crashes, its slot expires after twice the operation timeout, allowing time for
cancelled sockets to close. Local PDF counters remain in place to bound each
process's memory.

The other limits in the table deliberately remain per process:

- AI turn workers bound active conversations, tools, and approval waits; they
  do not count model requests or tokens. Configure provider quotas for the
  combined load of the replicas and all other model clients.
- Notification workers bound delivery orchestration; their email uses the
  shared SMTP budget. Push delivery has its own provider retries.
- Files' four upload places reject overload before reading request bodies and
  bound process memory and query-pool use. They are not a Filegate capacity
  setting; size Filegate for concurrent transfers across all replicas.
- Mail's four provider jobs per kind bound local worker occupancy. Distributed
  mailbox leases serialize work on each remote mailbox, while separate
  mailboxes can progress on different replicas.

Every replica also opens its own Postgres pool of up to 10 connections, plus
the extra pools in the table. Live updates allow 16 sockets per viewer on each
replica. Workflow slots also count per replica; see
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

### Notebooks reader presence

Opening a note joins its participant list through the existing notebook
workspace socket, including in Read mode and for locked notes. Editing starts
a separate collaboration connection only when needed. Both connections count
as one browser tab for that person; another tab counts separately. The detail
panel shows other readers as reading until cursor awareness reports writing.

Each workspace socket watches one opened note. Switching replaces that note;
leaving or closing the socket removes its presence. Connections renew their
shared presence leases every 10 seconds, and an abandoned lease expires after
30 seconds. Access is checked before joining and rechecked on permission
invalidation and the existing 10-second backstop. A workspace socket cannot
watch a note in another notebook, even when its user may read both. If the
opened note is deleted or moved, its reader watch ends while workspace updates
continue.

Upgrade all Notebooks replicas for reader presence. This requires no database
migration or new service; presence remains transient shared NATS state.

## Application registration

Application registry reads use a process-local view of the shared NATS entries.
Each reading process opens one watch on first use. Heartbeats update the view;
removal and access-rule revisions arrive through that watch. Readers also check
the 180-second lease locally, so a missing expiry event cannot keep an app live.

A lost watch, a resync request, or a NATS disconnect invalidates the view. The
next read shares one fresh NATS snapshot with concurrent readers and reopens
the watch. A failed refresh fails the read instead of serving the previous
view. A successful local write also checks watch progress: if the watch does
not cover its acknowledged revision within one heartbeat interval (60 seconds),
the view is invalidated and the next read recovers it. Subsequent writes cannot
postpone that deadline. Local lease expiry also triggers recovery in processes
that only read the view: a fresh snapshot retains renewed entries and removes
those that really expired.
Registry records do not cache permission decisions: SQL grants and
owner resource checks still run for each request. Discovery allows three
seconds per owner within a shared six-second budget, below the ten-second
request idle timeout. No migration, new service, or operator setting is required.

Treat registry content returned by `getApp`, `listApps`, `getCapability`, and
`listCapabilities` as read-only. `getApp()` and capability entries are deeply
frozen. `listApps()` retains flat copies with frozen nested content and the
current `updatedAt`, `expiresAt`, and `version` lease metadata. Use `structuredClone()`
on a result when you need a mutable local copy. Passing your own app snapshot
to `listCapabilities(snapshot)` does not freeze or modify that input.

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

Gateway route and request-counter snapshots renew every 30 seconds with a
90-second presence lease. Registry changes refresh routes immediately; committed
app-domain assignments wake every gateway. A 30-second reconciliation repairs
missed domain hints. With an older Core that does not publish hints, every
domain change waits for reconciliation, up to 30 seconds. Changes to `app.url`
and `gateway.ingress_cert_resolver` also take up to 30 seconds to reach gateways.

Gateway Ops stores app metadata only when its content changes or an app
reappears. Live status comes from the registry. Registry notifications also
checkpoint each app's last observed heartbeat at most once every five minutes:
20 unchanged apps average four timestamp updates per minute, with no content
upserts. On departure, Gateway Ops persists the final observed heartbeat once.
After a restart that misses the departure, offline durations use the saved
checkpoint and can overestimate downtime by one checkpoint interval plus the
registry heartbeat cadence. Database write failures can extend this gap.

Use the orchestrator, not the Cloud registry, to measure replica health and
count.

During a rolling deployment, old and new instances may both receive traffic.
Keep database changes backward-compatible until the rollout completes.

## Background delivery recovery

Platform live updates and application events wake outbox dispatchers across
instances after their database transaction commits. Core wakes event delivery
across its instances after accepting an event. Grids and Mail workflow workers
also use distributed wake signals. Outbox dispatchers and Core event delivery
retain a **five-second safety scan** for missed signals. Workflow workers use a
**30-second safety scan** for missed signals, due retries, deadlines and expired
claims. Under idle conditions this means twelve scans per minute per outbox
and two per workflow worker, plus startup. Workflow workers probe their execution
slots before and after recovery. With C free execution slots, this costs at
most 4 × C slot probes per idle minute. Grids probes both execution and dry-run
queues, so its claim-query budget is 8 × C; Mail probes execution only.
Local and distributed workflow hints still wake workers immediately. A lost
hint, a due retry or deadline, or an expired claim may wait up to 30 seconds
for the next workflow recovery scan, before backlog and execution time.
This counts safety scans, not all database queries. Core also reconciles
declarations and wakes delivery on registry updates, including each app
instance's minute heartbeat. Near idle, those heartbeats add roughly one wake
per app instance per minute; concurrent wakes can coalesce. The frozen-clock
guard covers the delivery dispatcher without the registry watcher.
Outbox dispatchers also schedule a wake at known retry and claim deadlines.
Commit notifications wake locally and signal other instances; the originating
process ignores its own signal. Shutdown drains accepted producers before
stopping their outbox.

A missed signal can delay discovery of committed work until the next safety
scan. Backlogs, claims, and unavailable dependencies can add delay. Postgres
retains the work, and the existing claim and retry rules still apply. Core's
event gap and retention checks run once per minute, independently of signal
volume. No new service or operator setting is required.

Grids starts its 32 record-event workflow partition readers only while at least
one enabled record-event workflow exists in a base outside the trash. Workflow
changes and base trash/restore actions wake the runtime across replicas; the existing minute reconciliation
recovers missed hints. Readers drain when the last such workflow is disabled,
removed, or its base is trashed. A drain runs outside the runtime topic reader,
so it does not hold up schedule changes or subsequent hints.

The PostgreSQL record-event outbox also supplies the change feed and snapshot
anchors. These rows keep their existing retention even without workflows.
Before forwarding an event to NATS, the dispatcher checks committed workflow
demand for its base and occurrence time in its existing database read. Without
an eligible workflow, it completes that outbox entry without publishing workflow
work. Enabling a workflow before writing records guarantees that its first
event can be queued even before any replica starts the readers. An activation
still in an uncommitted transaction does not claim events already dispatched
without it; activation does not replay earlier record changes.

The durable queue, partition positions, delivery budgets, and per-record
ordering remain. During a mixed-version rollout, older publishers can still
queue idle events. On activation, readers acknowledge historical messages
without a workflow SQL query when both their occurrence and publication times
precede the earliest active workflow's activation. Recently published events,
delayed outbox publications, and manual replays still query current definitions;
this also covers activations not yet reflected in a reader's cached minimum.
Existing backlogs still require transport reads and acknowledgments.
The existing 30-day / 1 GiB queue limit remains, and older
publishers must finish rolling out before idle writes stop adding queue work.

Only Core registers the hourly [one-time link cleanup](/en/docs/identity/one-time-links#operations-notes).
Other applications still provision the shared links table before setup.
Cleanup waits for Core to return during an outage; expired links remain invalid.
No migration or new operator setting is required.

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

On `SIGTERM` or `SIGINT`, an application immediately changes readiness to
HTTP 503 and closes HTTP admission. Bun stops accepting new connections and
lets current responses finish for up to **30 seconds**, matching the existing
worker drain deadline. At that deadline, Cloud forcibly closes remaining
connections, including SSE streams and WebSockets; the native request signal
cancels request work. Only after HTTP has drained or been closed does Cloud run
lifecycle stop hooks and release its dependencies, ending with Sync.

An unfinished response body can still break at the deadline, so streaming
clients must reconnect. A request without response headers can still become a
gateway 502 when its connection is forced closed. Drain at the ingress before
sending `SIGTERM` when endpoint propagation would otherwise send new traffic
to the departing replica; new connections to its closed listener cannot be
served. Readiness is 503 as soon as shutdown begins, including requests on an
existing connection that reach the handler during shutdown.

Allow time for both HTTP and subsequent background cleanup; see
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

Core provisions the installation-wide `pgcrypto` extension before other apps
start. Application migrations rely on that prerequisite instead of racing to
create it. Standalone apps using that same database inherit the prerequisite;
start the updated Core first on a fresh database.

`start` begins workers and subscriptions.

`stop` releases them. Cloud calls it after HTTP draining on `SIGTERM` and `SIGINT`, then stops
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

## Upgrade or restart Mail with sends queued

You do not need to empty Mail's send queue before a normal update. Waiting sends,
their frozen content, undo deadlines, and delivery state remain in Postgres;
restarting a Mail process does not discard them. Preserve Postgres, NATS and the
configured message storage, and follow the release's schema compatibility rules.
An update that forbids mixed Mail versions still needs a coordinated stop/start.

Use graceful termination and allow both the HTTP drain and the subsequent worker
drain described above. Mail stops taking new send jobs and lets accepted work
finish within the worker drain budget. A forced kill, or a send that outlasts the worker drain, can leave delivery
unclear even though the send record survives. If you need every current SMTP outcome to
be known before stopping, stop submitting sends and wait for in-flight work to
finish; an empty waiting list alone does not prove this.

### What happens to each send

The states below are outbox states. The associated command has its own state,
which `cld mail command get <command-id>` reports.

| Send at shutdown | What happens after restart | Delivery and duplicate risk |
| --- | --- | --- |
| Waiting, not yet claimed (`scheduled`) | It resumes when due. Startup and a once-per-minute recovery scan submit due sends, up to 500 per scan. Queue and provider contention can add delay. | The queued send is retained; recovery does not create a second send. |
| Still inside Undo (`undo_window`) | The original deadline continues during downtime; it does not restart. Delivery waits for both the undo deadline and dispatch time. Immediate sends with Undo have an additional 10-second dispatch grace. | It remains unsent while Undo is open. If the deadline passes while Mail is stopped, it becomes eligible after restart. |
| Claimed, before SMTP (`sending`) | A caught failure before the provider effect starts can restore the unstarted claim without using an attempt. A crash leaves it executing until its last heartbeat is more than 10 minutes old; recovery then queues a retry, or returns it to Drafts as `failed` if its five-attempt budget is exhausted. | Nothing was submitted by that attempt. Crash recovery uses an attempt and adds retry backoff, so repeated interrupted upgrades can exhaust the budget. |
| SMTP in flight (`sending`) | It may finish during the drain. If the process disappears after recording that SMTP may start, stale recovery changes it to `unknown` and its command to `ambiguous`, then checks provider evidence. This also covers a crash just before SMTP actually starts. | It may have been accepted, or may never have left Mail. Mail does not automatically resend an unclear send. |
| SMTP accepted, Sent copy pending (`sent_sync_pending`, or a stopped copy worker in `accepted`) | Mail retries the Sent copy, not SMTP. A stale `accepted` copy is recovered after 10 minutes; normally copy retries use backoff, and the minute scan also finds pending copies. Exhaustion becomes `needs_attention`. | Recipients were already accepted by SMTP. A missing Sent copy does not mean delivery failed; restarting does not send it again. |
| Outcome already unclear (`unknown`) | Mail checks the saved SMTP answer and looks for the stable Message-ID in Sent. Evidence settles it as accepted; otherwise bounded checks end in `needs_attention`. | No automatic resend. Without evidence, delivery remains unproven and may require operator action. |

These are recovery intervals, not a delivery deadline. A crashed job can retain
its broker claim for the remainder of a four-minute lease, and its provider
mailbox lock for the remainder of five minutes. The ten-minute stale threshold
runs from the last worker heartbeat, not from startup; recovery runs at startup
and once a minute. Pre-SMTP crash retries then wait 30, 60, 120 or 240 seconds
according to the attempt already used. A backlog, unavailable provider or stopped
worker can extend every delay. Sent-copy retries and unknown-outcome checks share
the send's bounded attempt budget; they do not get five new attempts on restart.

### Check delivery after the update

Record the send command IDs from the submitting CLI or script. After Mail is
ready, inspect the mailbox and any commands that were executing before shutdown:

```bash
cld --json mail operator status
cld --json mail command get <command-id>
```

Mailbox administrators can read outbox counts under `queues.outbox` and the
commands that need attention under `attentionCommands`. Waiting sends should
resume; `sending` left over from a hard stop may remain until stale recovery.
Check again after the ten-minute heartbeat threshold, the next recovery scan
and any retry backoff, allowing for queue contention. Investigate persistent
`failed`, `ambiguous` or `needs_attention` commands and their error messages.
`WORKER_LEASE_EXPIRED` identifies an interrupted worker; `SENT_COPY_LEASE_EXPIRED`
or `SENT_APPEND_FAILED` identifies copy work, not another SMTP delivery attempt.
Partial SMTP acceptance also needs attention: some recipients may already have
the message, regardless of whether its Sent copy is present.

For an unclear send, check the provider's Sent folder and SMTP logs for its
Message-ID before deciding to send again. An eligible command can request an
operator check:

```bash
cld mail operator run reconcile --command <command-id> --wait
```

This checks evidence; it does not resend. The retry operator action does not
retry failed sends. A send that failed before SMTP can be edited and sent
again from Drafts after its error is resolved.

There is no exactly-once SMTP guarantee: the server can accept a message just
before Mail loses the connection or stops, before Mail records the answer. Mail
preserves that uncertainty instead of automatically repeating delivery. Sending
a new message manually while the original outcome is unknown can deliver it
twice; a stable Message-ID is evidence for reconciliation, not a promise that
SMTP deduplicates. Hold off on a manual resend until you have checked that
outcome. This uncertainty is a reason to allow graceful draining and inspect
interrupted sends, not to hold back an ordinary compatible update indefinitely.

## Set the termination window

The process exits after lifecycle shutdown finishes. Give the container enough
termination time for:

- request draining at the ingress;
- up to 30 seconds for HTTP responses, followed by background worker draining;
- current database transactions;
- worker lease release;
- tracked tasks;
- registry removal.

Make stop hooks idempotent. A startup failure can require cleanup before the
service fully starts.

Test shutdown with real `SIGTERM`, not only a local process kill.

## IP request budgets

IP-based request limits share one budget across replicas through Valkey. IPv6
clients in the same `/64` also share that budget, including public share pages.
IPv4 remains per address. See [Limit requests](/en/docs/server/middleware#limit-requests)
for address normalization and custom budgets.

When upgrading, existing full-address IPv6 counters are replaced by network
counters. Expect one fresh window at cutover; after all replicas are updated,
changing host addresses cannot obtain a new budget.

## Inspect Mail send progress

Mail's **Outbox** view counts sends waiting for a worker alongside sends scheduled
for later. Sends stay out while Undo or its dispatch grace is still running.
Open mailboxes refresh the count through live updates as sends finish. Readers with
assigned access see only the sends their current conversation access allows.

`cld mail scheduled list` prints the visible total, such as `290 waiting`, with a
paginated list. Under `--json`, use `total` and `nextCursor`. Mailbox administrators
can use `cld mail operator status` for an `Outbox:` line of state counts, including
in-flight and completed states; structured output keeps these in `queues.outbox`.
