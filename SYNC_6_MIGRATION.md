# Move Cloud from Sync 5 to Sync 6

Sync 6 moves queues, jobs, topics, schedules, locks, and presence from Redis to
NATS JetStream. This requires a coordinated maintenance deployment. A Sync 5
process cannot see Sync 6 registrations or work, and the new workers do not
consume the old Redis queues.

Keep Redis for Cloud caches, authentication flows, and Cloud-owned rate
limits. Do not flush Redis or delete every `sync:*` key: existing rate-limit
windows and unreviewed durable work can still matter.

Already running Sync 6.2.0? Use the
[coordinated 6.3.1 upgrade](docs-site/docs/en/operations/deployment-requirements.md#upgrade-from-sync-620)
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
nonempty. `snapshot_required` blocks the cutover. Finish that snapshot with the
v5 worker and repeat the check; do not save a partial replay after a retention
gap. `deleted_note` identifies a retained stream whose note row no longer
exists and requires an explicit review before removing the stream.

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
   cover handles declared by the running processes, not every historical
   resource in the NATS account.

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
an operator remove exact v5 namespaces proven drained or superseded. Keep
unexplained keys and data; neither preflight command performs cleanup.

## Rollback

Before v6 accepts new work, stop all v6 processes and restore the coordinated
v5 images against the recorded recovery point. After any v6 writes, restore
the matching Postgres and Redis backups as part of the rollback, or continue
with a forward repair that preserves new work. Never run v5 and v6 workers
concurrently against the same Cloud installation.
