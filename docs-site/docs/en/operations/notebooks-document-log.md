---
title: Size and migrate the Notebook document log
navTitle: Notebook document log
section: Operations
order: 1138
description: JetStream storage reserved for Notebook live editing, how it is sized, and how per-note topics from older releases are retired.
tags: [notebooks, nats, jetstream, storage, migration]
updated: 2026-10-26
---

# Size and migrate the Notebook document log

Notebook live editing keeps every collaborative update in one JetStream
document log shared by all notes, `cloud:notebooks:yjs`. Each note's updates
use the note ID as the Sync tenant. Snapshots in Postgres remain the durable
document state. The log only needs to hold updates until a snapshot covers
them.
The platform now provides the log through `@k2b/cloud/shared-text`; the topic
names and limits are unchanged.
The snapshot pipeline also comes from the platform, with the same job ID,
partitions, retries and reconcile schedule.
For a legacy note with Markdown but no binary snapshot, the first reader
persists a shared Yjs base before live editing begins. Editors, server writes
and the snapshot worker then start from the same content.

Releases up to 0.10 created one log per note. JetStream reserves every
stream's configured byte limit against the account, whether or not data is
stored. Each per-note topic had a 1 GiB log and a 1 GiB dead-letter stream,
which reserved 6 GiB per note at three replicas. On a bounded account, new
notes then stayed in the connecting state with
`insufficient storage resources available`.

## Reserved storage

The shared log reserves a fixed amount, however many notes exist:

| Stream | Byte limit | Age limit |
| --- | --- | --- |
| Document log | 1 GiB | 7 days |
| Document log dead letters | 16 MiB | 7 days |

With `SYNC_REPLICAS` replicas, the reservation is
`(1 GiB + 16 MiB) × SYNC_REPLICAS`. At the default three replicas, this is
3.05 GiB. The awareness topic, snapshot jobs, and other Notebook resources
reserve their own fixed limits. None of them grows with the number of notes.

Check the account against these limits with an authorized NATS context:

```sh
nats account info
nats stream report
```

## Why the log is this size

An update must stay in the log until the snapshot that covers it is written.
If byte eviction removed it first, the edit would be lost. The byte limit
therefore has to hold the peak update rate over the longest time an update
can stay unsnapshotted:

```text
log max_bytes >= peak update bytes per second × longest unsnapshotted time
```

The longest unsnapshotted time follows from the snapshot contract:

- An open editor queues a snapshot every 8 seconds while it has unsaved
  changes, and again when it closes.
- Eight partitions keyed by note serialize snapshot jobs across the
  deployment. Each process rebuilds one document at a time.
- A failing snapshot job retries up to 20 times. Each attempt can wait up to
  120 seconds for an acknowledgment, with 5 seconds between attempts. In the
  worst case, that is about 42 minutes.
- The hourly `notebooks:yjs-snapshot-reconcile` schedule queues snapshots again
  for notes whose log moved past their stored snapshot.

Together, these give about two hours when the snapshot pipeline fails. In
normal operation, an update is snapshotted within seconds. At 1 GiB, the log
holds about 149 KiB/s of update traffic for two hours. It also holds 132
updates at the 8.1 MB update limit between two snapshots. The 7-day age limit
exceeds the two-hour bound by a wide margin.

The dead-letter stream receives entries only from durable topic consumers, and
the document log has none. Its 16 MiB limit holds two dead letters of the
largest possible update.

If update traffic exceeds this budget for longer than the snapshot pipeline
can absorb, the oldest updates are evicted before their snapshot is written.
The affected note then reports a history gap. Recovery keeps the stored
snapshot and every retained update, saves the original as a protected version,
and marks the note's history as incomplete. This is the same recovery that
the [snapshot worker](/en/docs/operations/notebooks-snapshot-cutover) already
uses.

## Keep idle notes inside the window

All notes share one retention window. Each note stores the log position its
snapshot covers. When the snapshot worker saves a note, that position becomes
the log head, read before the note's latest update, rather than the note's own
latest update. The hourly reconcile moves the stored position of idle notes to
the head once it reaches the older half of the retained window. An idle note
therefore stays inside the window while other notes are edited, and a later
edit does not report a false history gap.

When an installation is stopped longer than the age limit, positions can fall
out of the window before the reconcile runs again. The next edit to such a note
reports a gap and marks its history incomplete, even though no update was lost.

## Retire per-note topics from older releases

The `notebooks:yjs-legacy-migration` schedule runs every five minutes.
Runs never overlap across the deployment. Each run lists the per-note topics
that still exist on the broker, `cloud:notebooks:yjs:<noteId>`, and handles at
most 50 of them:

1. The first reader of a note, or the migration, points the stored snapshot at
   the shared log. The snapshot already covers the old topic up to its saved
   position, which is recorded in `notebooks.notes.yjs_legacy_seq`.
2. Updates in the old topic that the snapshot does not cover are merged and
   published to the shared log. The migration then records the captured
   sequence and queues a snapshot. Open editors receive these updates live.
3. The old topic's two streams are deleted only after all their updates are
   captured, the topic has received no update for one hour, and a fresh
   re-read shows no newer update. A topic whose note was deleted is removed
   once it has been quiet for one hour.

A failed topic is retried with backoff that starts at five minutes and grows
to at most six hours. Running the migration again is safe. A repeated publish
contains Yjs updates that editors have already applied, which changes nothing.
The migration never deletes a stream whose updates are not captured. Updates
that the old topic had already lost to its own retention mark the note's
history as incomplete.

### During a rolling deploy

Nodes still running 0.10 read and write the per-note topics, so editors
connected to old and new nodes do not see each other's live changes. Clients
on an old node reconnect repeatedly once their note points at the shared log.
Old-node writes stay in the per-note topic, and the next migration run moves
them to the shared log. An old node that writes after deletion recreates the
topic. The next run then captures all of its updates and deletes it again.

Finish the rollout within the one-hour quiet period. Afterward, an update can
be lost only when an old-release node writes in the brief interval between the
final re-read and the deletion.

### Observe the migration

- Application logs report `Legacy Yjs topic migration run finished` with
  `republished`, `deleted`, `waiting`, `failed`, and `remaining`.
  `remaining: 0` means every per-note topic is gone.
- `nats stream report` shows the per-note `S6_T_*` and `S6_TD_*` stream pairs
  decreasing until only the shared log remains.
- The `notebooks:yjs-legacy-migration` schedule appears with the other Notebook
  maintenance schedules in Gateway Ops.

## Recover a deployment whose account is exhausted

When editors stay in the connecting state or show **Live editing is
unavailable**, and the Notebooks logs contain
`insufficient storage resources available`:

1. Confirm the cause with `nats account info` and `nats stream report`.
   Reserved storage close to the account limit, with little stored data, is
   the #166 pattern.
2. Temporarily raise the JetStream account storage limit enough for the shared
   log's reservation. At three replicas, this is at least 3.05 GiB above the
   current reservation. Reload the NATS servers. Do not delete notebook streams
   to make room: an unmigrated topic can hold the only copy of recent edits.
3. Deploy this release. Watch the migration logs until `remaining` reaches 0.
   With the default quiet period, this takes about one hour plus the time for
   batches of 50 topics every five minutes.
4. Verify that the per-note stream pairs are gone and that a note opens and
   saves an edit. Then restore the original account limit.

The editor shows **Live editing is unavailable** while the broker refuses to
store updates. It retries five times over about a minute, then keeps the text
on screen read-only. The bar says storage is full and whether changes are saved,
and offers **Copy text** and **Reload**. Changes typed during the outage are
resent on each retry, so they are saved if the broker accepts updates again
within that minute. After the retries stop, they stay only in the open tab.

## Recover a suggestion operation

Passage comments, replies, and suggestion operations live in the Notebooks
Postgres schema and follow the note's backup lifecycle. Startup creates their
tables without rewriting existing page comments. No Chat service is required.

Accept and undo store a prepared Yjs transaction before publication. A marker
in that same transaction lets a retry recognize an edit already in the log,
including when the Postgres snapshot write failed. A failed or uncertain
request returns `ANNOTATION_OPERATION_PENDING` and `details.operationId`. Retry
the same operation ID; creating a new one while an operation is pending
returns 409. Completion updates the Markdown projection, saved history, and
comment state. Restore and locking rules still apply to retries. Concurrent
comment requests can return 409 while another request holds the note lock;
retry the unchanged request with its original identifiers. Annotation operations
use one dedicated Postgres transaction connection per replica and queue locally;
the shared text store uses the normal application pool. Reserve that additional
connection when sizing Postgres. Shutdown closes it after the workers drain.

Soft-deleted comments and replies remain restorable during their author's
original ten-minute mutation window. Later writes purge expired deleted rows
in bounded batches for that note or thread.
