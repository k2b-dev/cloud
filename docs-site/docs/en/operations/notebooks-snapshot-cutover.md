---
title: Change the Notebook snapshot worker
navTitle: Snapshot worker cutover
section: Operations
order: 1137
description: Move existing Notebook snapshot work to the ordered worker without losing accepted edits.
tags: [notebooks, snapshots, migration, nats]
updated: 2026-09-08
---

# Change the Notebook snapshot worker

Use a maintenance window when upgrading from the unpartitioned
`notebooks.yjs.snapshot` job to `notebooks.yjs.snapshot.ordered`. Changing the
existing resource's ordering causes provisioning drift. A normal restart also
leaves queued jobs behind: worker drain waits for active handlers, and closing
editing connections can enqueue additional snapshots.

The ordered worker uses eight partitions keyed by note and one handler per
process. Snapshots of the same note stay serialized, and each process still
reconstructs one document at a time, which preserves the previous per-process
reconstruction load without a separate distributed lock. Across the deployment
up to eight notes can be snapshotted concurrently, one per process at most.
The partition count is fixed in the resource declaration; changing it later is
another coordinated resource migration.

## Prepare and drain existing work

1. Record the current application image and take consistent Postgres and NATS
   recovery backups. Keep the same namespace and all existing document topics.
2. Block every Notebook write producer, including browser editing connections,
   API and CLI edits, automation, and restore operations. Flush existing
   connections so their final snapshot requests reach the old queue.
3. Keep an old-version snapshot worker running until its queued, active, and
   retrying work has settled. If shutting down the application also stops that
   worker, run a reviewed one-shot worker from the exact old release against
   the old resource configuration. Do not start the new producers yet.
4. Resolve old snapshot dead letters before switching. Do not acknowledge,
   delete, or purge unfinished work to make the check pass. If retained document
   history is incomplete, recover from a verified snapshot or backup first.

## Run the read-only cutover check

From the release checkout, supply `DATABASE_URL`, `NATS_SERVERS`, and
`SYNC_NAMESPACE` for the exact installation through its designated secret
system. Set `NATS_CREDS_FILE` and `NATS_TLS_CA_FILE` when required. Then run:

```sh
bun packages/notebooks/scripts/snapshot-cutover-preflight.ts > notebooks-cutover.jsonl
```

The command performs reads only. It does not provision Sync resources, consume
jobs, write snapshots, or remove data. Keep producers quiesced for the entire
check; its separate broker and database reads are not a transaction.

The report checks:

- Every existing note topic's last sequence is covered by a stored snapshot,
  including streams whose retained messages have all expired.
- Every note with a saved Sync cursor still has a matching topic in the selected
  namespace. Locked notes are included.
- Old snapshot work and dead-letter streams are empty, and their consumers
  have no pending or unacknowledged messages. Historical mutex and job-claim KV
  records are reported and preserved.
- Topics whose note rows were deleted are reported as `deleted_note`. These
  block the automatic check and need an explicit recovery or ownership review;
  the command never removes them.

Exit status zero and `safeToCutOver: true` mean these checks passed. Any other
result blocks the switch. A cursor beyond the broker's last sequence also
blocks it: investigate a possible namespace mismatch or broker reset. This
check proves current snapshot coverage, not the completeness of earlier
backups or historical versions. Review any notes marked `historyIncomplete`
separately; a recovered cursor does not prove that missing history was restored.

## Switch and verify

Stop all old snapshot workers after the check passes. Start the new release in
one coordinated deployment, then reopen producers. Do not overlap old and new
workers: ordering applies only within the new job resource. Messages still in
flight on the old partition and new partition messages for the same note can
overlap across the switch; that is safe because a snapshot save only advances
a note whose stored sequence is older, so the loser is rejected.

The new job uses the same seven-day work retention, per-note-and-cursor
submission keys, replay coverage checks, contributor history, and restore
revision guard. Transient database or transport failures retry up to twenty
attempts. It continues to read existing document topics and Postgres snapshots.
It does not import or erase the old job or mutex resources.

Missing history and undecodable retained updates trigger recovery instead of
repeating the same failed replay. Recovery captures a fixed topic head and
preserves every decodable update up to that cursor, including unresolved Yjs
dependencies. Later updates remain available for the next snapshot. It retains
the original saved binary as a protected version before saving recovered state;
ordinary version pruning does not remove that original.

Recovery cannot prove that missing updates or deletions were restored. The note
therefore keeps an incomplete-history warning in the editor and Book view, and
its API exposes `historyIncomplete`. Ordinary edits do not clear this flag.
The worker records a failed history-gap or malformed-history trace and a dead
letter; the same recovered boundary does not generate a new failure every hour.
Opening an affected note performs the same recovery and requests a fresh editor
snapshot. Inspect the protected version and available backups before relying on
the recovered content. Recovery does not delete the retained topic.

A note that never stored Yjs state but has retained edits and a purged topic
is re-anchored from its current markdown when the editor next opens it.

A transient live-stream failure, for example a broker failover, closes editing
connections with `STREAM_FAILED`. The editor reconnects with backoff and its
last cursor, so an outage does not resend stored snapshots. Only a cursor the
broker cannot serve any more asks the editor to resync.

An hourly `notebooks:yjs-snapshot-reconcile` schedule re-queues snapshots for
notes whose topic head moved past their stored cursor without a settled job,
for example after a crashed process or a lost enqueue. It scans all unlocked
notes in pages of 5000 stable note IDs, including notes that have never saved a
cursor. Empty topics do not enqueue snapshot jobs. This also provisions the
existing per-note Sync resources for notes that have never been opened: size
JetStream for the whole notebook inventory, not only recently active notes.

Verify a new edit survives saving, reconnecting, and an application restart.
Confirm the stored snapshot cursor reaches the note topic's latest sequence,
and inspect the new job's dead letters in Gateway Ops. Preserve old resources
and recovery backups until acceptance; any later cleanup needs exact-resource
review. After new edits arrive, an image-only rollback can strand new jobs and
requires the same drain-and-coverage discipline.
