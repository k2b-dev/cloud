# Move Cloud from Sync 5 to Sync 6

Sync 6 moves queues, jobs, topics, schedules, locks, and presence from Redis to
NATS JetStream. This requires a coordinated maintenance deployment. A Sync 5
process cannot see Sync 6 registrations or work, and the new workers do not
consume the old Redis queues.

This checkout carries a reviewed Bun patch on Sync 6.3.2 for consumer-specific
topic dead-letter recovery and its shutdown cleanup. Frozen installs and
Docker builds apply it. No new Sync version has been published for this slice.
Before publishing the Cloud npm library, publish and adopt the corresponding
Sync version; downstream npm consumers do not inherit workspace patches.
See [the patch instructions](patches/README.md).

Keep Redis for Cloud caches, authentication flows, and Cloud-owned rate
limits; those live outside the `sync:*` prefix. Do not flush Redis or delete
`sync:*` keys before acceptance: unreviewed durable v5 work (queues, jobs, pump
checkpoints, and scheduler definitions) can still matter for recovery.

Already running Sync 6.2.0? Use the
[coordinated 6.3.2 upgrade](docs-site/docs/en/operations/deployment-requirements.md#upgrade-from-sync-620)
instead of repeating the Redis migration. Also follow the
[notebook snapshot cutover](docs-site/docs/en/operations/notebooks-snapshot-cutover.md),
[Grids runtime cutover](packages/grids/SYNC_RUNTIME_CUTOVER.md), and
[FreeIPA backfill checks](docs-site/docs/en/operations/freeipa.md#backfill-account-expiry-dates).
Retain existing broker resources and application data until those checks pass.

## Prepare the release and recovery point

1. Choose one immutable `CLOUD_IMAGE_TAG=sha-<git-sha>` whose complete image
   release set succeeded. Render production Compose and pull every application
   image before stopping services. Include application variants outside the
   standard Compose profile in the maintenance plan.
2. Prepare NATS 2.14.3 or later with JetStream, three replicas, persistent
   storage, and `max_payload` of at least 16 MB. Configure one `SYNC_NAMESPACE`
   for the installation and `NATS_SERVERS` for every process. Follow the
   [deployment requirements](docs-site/docs/en/operations/deployment-requirements.md)
   for credentials, TLS, and mounted files. Provisioning drift or an undersized
   payload limit blocks readiness.
3. Record active jobs, delayed work, queue failures, pump checkpoints, and
   scheduler definitions. Decide how each unfinished v5 operation will finish
   or be recovered from its owning application's Postgres state. A new Sync 6
   scheduler registers its definition again; it does not import v5 ticks.
4. Take consistent Postgres and Redis backups and record the previous image
   tag. Keep those backups through acceptance. New notebook snapshots and
   domain writes make an image-only rollback unsafe.

## Prove notebook snapshots cover the old document streams

Close notebook editing connections and stop new producers while the old v5
snapshot worker can still finish. Wait for its ready, active, delayed, and
failed snapshot work to settle. Then run the read-only legacy inventory with
`REDIS_URL` and `DATABASE_URL` supplied through the designated secret system:

```sh
bun scripts/legacy-sync-inventory.ts > sync-v5-inventory.before.json
```

The report keeps v5 durable keys, older durable keys, scheduler keys, and
non-durable keys separate. It compares each retained notebook document stream
high-water cursor with the note's Postgres snapshot cursor and checks that the snapshot is
nonempty. `snapshot_required` blocks the cutover; a snapshot that v5 saved
without a stream cursor reports the same status because it cannot prove
coverage. Finish that snapshot with the v5 worker and repeat the check; do not
save a partial replay after a retention gap. `deleted_note` identifies a
retained stream whose note row no longer exists, and `invalid_note_id` a
document stream whose identity is not a note UUID. Both require an explicit
review before removing the stream.

The inventory stops after 10,000 keys by default. For a larger, reviewed Redis
database, set `SYNC_INVENTORY_MAX_KEYS` to the required bound. This changes only
the read limit. The command cannot establish whether previously expired
history was lost, and a covered Yjs head does not prove other durable work is
drained. Inspect those queues, jobs, and pumps separately.

Rerun this inventory after all v5 producers are stopped and immediately
before starting v6. Preserve the report with the backups. The notebook
migration retains the old cursor columns and introduces an opaque v6 cursor;
do not reset notebook content or invent a new cursor for old data.

The v6 document log retains events for seven days within its per-note storage
limit. Snapshots persist the opaque cursor and numeric sequence together, and
replay stops at a captured head before reporting the client ready. Snapshot
requests for different target sequences remain distinct so a later unload
cannot disappear behind an older in-flight save. A retention gap must stop
the save and trigger recovery; it must never replace content with partial
replayed state.

Resource declarations are drift-checked. A namespace that already ran an
earlier v6 build (a development cluster or a 6.2.0 deployment) may hold
streams and consumers with older delivery or retention settings; readiness
then fails with `ResourceDriftError` naming the resource. A fresh v5 to v6
cutover is unaffected. Keep the NATS data; repair only the named resource, and
distinguish the two cases:

- Consumer drift: delete only the durable consumer (`nats consumer rm
  <stream> <consumer>`). The stream and its retained, unacknowledged work
  survive; the new build recreates the consumer and resumes.
- Stream drift: deleting a stream drops everything it retains. Only do this
  where the release notes below say the work is ephemeral or recoverable from
  Postgres.

Resources this release changes, and how their work is recovered:

- `cloud-ai-turn-controls` topic (`max_bytes`): stream drift. Delete the
  stream; it carries short-lived turn abort events only.
- Job consumers `auth:ipa:sync`, `auth:reminder:daily`, `auth:guest:cleanup`,
  `auth:local-user:cleanup`, `auth:lifecycle:audit:cleanup`, `app:logs:cleanup`
  (`ack_wait`, `backoff`): consumer drift. A slot in flight during the cutover
  re-runs at the next schedule slot.
- `cloud-notification-deliveries` job (consumer drift): the Postgres recovery
  scan re-enqueues deliveries that were queued at the cutover.
- `core-ai-chat-task-occurrence` stream (`duplicate_window`): stream drift.
  Delete the stream; the recovery cron resubmits occurrence rows still queued
  in Postgres.

## Start the v6 fleet

1. Stop every v5 Cloud process and verify the final drain evidence. Do not use
   a rolling deployment across this boundary.
2. Start the selected v6 images together. Let their normal migrations and
   lifecycle hooks register resources, start workers, recover durable domain
   work, and create schedules. Every application must become ready with a
   connected NATS client and no pending or drifted resources.
3. Run the v6 fleet preflight. Set `CLOUD_CORE_URL` to the trusted Core origin,
   `CLOUD_ADMIN_TOKEN` to an administrator token with the admin OAuth scope,
   `SYNC_NAMESPACE` to the installation namespace, and `CLOUD_IMAGE_TAG` to the
   selected immutable release. Keep the token in the environment, not a command
   argument or report.

   ```sh
   bun run prod:preflight
   ```

   The command reads the complete admin app inventory through Core, then each
   app's Sync resources through Core's invocation broker. It checks the
   production Compose release set, missing applications, Sync generation,
   the pinned Sync version, runtime readiness, namespace, provisioning state,
   and dead-letter depths.
   An unavailable application blocks the check. The command does not read
   Redis or mutate containers or NATS resources.
4. Inspect **Gateway Ops → Sync** and application logs. Investigate every
   dead-letter entry before requeueing it; application database failures and
   transport dead letters are different recovery paths. Resource summaries
   cover handles the running processes have declared, not every historical
   resource in the NATS account. A handle created on first use (`lazySync`)
   stays invisible until that use, so a purely on-demand handle is not missing
   when it does not appear before its first request.
5. Inspect **Gateway Ops → NATS** for broker nodes, storage, stream replicas,
   and consumer backlog. Configure the separate Gateway Ops diagnostics
   credential and independent broker monitoring using
   [NATS operations](docs-site/docs/en/operations/nats-operations.md). Verify a
   configured health webhook reaches its destination. Cloud's scheduled
   checks and delivery depend on NATS and cannot cover a complete broker
   outage without an external monitor.

## Verify behavior and recovery

Use HTTP requests, focused integration tests, and container logs to verify:

- A submitted job completes, a scheduled tick executes, and retries reach the
  application's expected terminal state.
- Notebook edits survive saving, reconnecting, and application restart. The
  Postgres v6 snapshot cursor and sequence cover the latest document event.
  Old browser cursors trigger a fresh snapshot instead of partial replay.
- Mail, Spaces, Grids, Contacts, AI streams, and notifications deliver their
  normal domain results and live invalidations. Start notification batch
  recovery and confirm pre-cutover batches resume.
- Stop all application processes, leave the broker running across a scheduled
  minute, then start the same release again. Confirm retained consumers resume,
  schedules apply their configured misfire policy, and all applications return
  to ready. A broker health check alone does not prove these outcomes.

Run `bun run prod:preflight` again after recovery. Only after acceptance may
an operator remove v5 Redis state. From then on, every key the inventory
enumerates is v5-only: Sync 6 neither reads nor writes Redis, so the whole
`sync:*` prefix family and the legacy `cloud:*` Sync prefixes can be deleted
in bulk. Keep the inventory report with the backups, and keep keys outside the
enumerated prefixes; neither preflight command performs cleanup.

## Rollback

Before v6 accepts new work, stop all v6 processes and restore the coordinated
v5 images against the recorded recovery point. After any v6 writes, restore
the matching Postgres and Redis backups as part of the rollback, or continue
with a forward repair that preserves new work. Never run v5 and v6 workers
concurrently against the same Cloud installation.
