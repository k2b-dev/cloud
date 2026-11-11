---
title: Mail background database work
navTitle: Mail database work
section: Operations
order: 1162
description: Check Mail sync history growth, background cleanup and disk reuse.
tags: [mail, operations, database]
updated: 2026-11-11
---

# Mail background database work

Mail keeps successful sync batches that imported messages, queued draft work,
changed flags, removed placements or reset UID validity for **three days**.
This covers a weekend and the following incident-response day. Failed,
cancelled and stale-fence runs remain for **30 days**. Running rows are
preserved. An empty successful batch is also retained when it clears a binding,
connection or resource error, or follows the folder's latest failed run. Other
empty successes leave no history row. A recovery can expire before its failure;
use current mailbox health alongside history when diagnosing older failures.

A waiting `sync` command uses one current checkpoint per folder, independent
of history retention. Health views use the resource's last-sync time; operator
counts and `cld mail sync runs` show recorded work and failures, rather than
every poll. A full batch briefly records its running fence; an empty successful
commit removes that row atomically with the folder checkpoint unless it records
error recovery.

## Quiet checks and write rates

A quiet IMAP `STATUS` check ends before claiming a fence or recording a run.
This needs CONDSTORE, completed import, no flag walk or reconciliation under
way, a full reconciliation less than six hours old, and settled connection,
binding, resource and mailbox health. Freshness advances at most once a minute.
The Drafts folder, servers without CONDSTORE, recovery and waiting commands
take a full batch; only error recovery keeps a successful history row when empty.
Binding last use follows full commits. Folder checkpoints advance on those
commits; UID metadata and mailbox/connection health change only as needed.

The minute scheduler can ask for 60 checks per folder per hour. Push requests
and multi-batch imports add turns; request coalescing and provider pacing can
reduce them. Before empty-run suppression, 212 folders checked each minute
could record about 305,280 runs per day. A count of 9.13 million over exactly
30 days would mean about 304,333 per day or 12,681 per hour; a planner estimate
alone does not establish that age distribution.

Each process logs `Mail folder sync activity` every ten active minutes. It
counts requests by trigger and batches by outcome, including unchanged and
failed checks. To measure retained history per mailbox/folder/hour, set
`resource_id` in psql to the chosen remote resource UUID:

```sql
SELECT resource.mailbox_id, run.stats ->> 'folderId' AS folder_id,
       date_trunc('hour', run.started_at) AS hour, run.state, count(*)
FROM mail.sync_runs run
JOIN mail.remote_resources resource ON resource.id = run.remote_resource_id
WHERE run.remote_resource_id = :'resource_id'::uuid
  AND run.started_at >= now() - interval '24 hours'
GROUP BY resource.mailbox_id, run.stats ->> 'folderId',
         date_trunc('hour', run.started_at), run.state
ORDER BY hour, folder_id, run.state;
```

## Cleanup and upgrades

`mail:runtime-history-cleanup` runs every minute while the Mail scheduler
worker runs. Each pass gives successful runs, other terminal runs, automation
logs and workflow ordering a separate 1.25-second share of a five-second work
budget. Unused time then goes to sync sources still returning full batches,
with at most 100 batches of 1,000 rows per source over the entire pass. Every
batch has its own transaction, a statement deadline and a lock wait of at most 250 ms.
Locked rows are skipped. An auxiliary-table failure cannot roll back committed
sync-history cleanup; it is logged and reported to the scheduler.

Partial age/order indexes cover the two sync states separately. Automation
logs use `(created_at, id)`; workflow ordering uses `(expires_at, event_id)`.
Deletion targets the already locked tuple locations, so a generic prepared
plan cannot replace the bounded delete with a hash join over the whole heap.

The upgrade adds one nullable folder checkpoint column. It builds the four
cleanup indexes with `CREATE INDEX CONCURRENTLY` after startup, using Mail's
existing index-build lease. Busy or failed builds are retried by subsequent
minute passes. The smaller auxiliary indexes build first. Sync-history cleanup
waits for its matching index to be valid; auxiliary cleanup continues with
bounded statements even before its new indexes exist. No startup migration
deletes the backlog or waits for these index builds. Fresh installations use
the same four retention indexes; the obsolete combined terminal index is no
longer created.

During the short deployment window with mixed Mail versions, a waiting
`sync --wait` can time out because an older process does not write the new
folder checkpoint. Synchronization continues without data loss; retry the
command after the deployment finishes.

The earlier age/order sync index existed in fresh-install SQL but was missing
from upgrade additions. The old hourly worker also shared a transaction and
five seconds across all three tables, and only checked its deadline between
batches. An index missing on an upgraded installation could therefore cause
repeated heap scans and long transactions.

Look for `Mail runtime history cleanup`: after deletions or errors it reports
committed row counts per table, duration and `rowsPerMinute` (the pass's rate,
normalized to one minute). Empty, healthy passes are silent. A budget warning
means that source used its turn; a sync source with full committed batches can
borrow spare time in the same pass, and the next minute retries any remainder.
An index warning means its background build is still needed. Check
`pg_stat_progress_create_index` and `pg_index.indisvalid` to distinguish an
active build from a failed one. Repeated errors or no cleanup logs despite
expired rows require checking scheduler registration and worker health in the
operator view. Code registration alone does not prove a job ran on a particular
installation.

In an isolated PostgreSQL fixture limited to one CPU, 40,001 expired runs
drained in 41 sync-delete batches over 11 passes in about 2.1 seconds. This is a small,
warm fixture, not a throughput promise for a 17 GB heap. Measure committed
rows/minute on the target: backlog falls only when deletion exceeds arrivals
into the expired set. The old theoretical ceiling was 2.4 million sync rows/day;
the new ceiling is 144 million/day per sync state, with the time budget normally
binding first.

## Reuse or reclaim disk space

Deletes make rows dead; the relation file can remain large. Autovacuum, or a
separately scheduled ordinary `VACUUM (ANALYZE) mail.sync_runs`, makes that
space reusable and refreshes planner statistics. Ordinary vacuum usually
keeps the existing file allocation.

To return substantial space to the filesystem, plan `VACUUM FULL` or
`pg_repack` separately with backups, disk headroom and a maintenance window.
`VACUUM FULL` rewrites the table under an `ACCESS EXCLUSIVE` lock and blocks
readers and writers. `pg_repack` requires its extension/tooling, additional
disk space and brief exclusive locks; check its prerequisites for the operator's
PostgreSQL version. Mail never runs `VACUUM FULL` automatically.

## Related history stores

| Store | Current cleanup |
| --- | --- |
| `mail.automation_log` | The minute Mail worker, after 30 days; rows linked to a resumable workflow remain. |
| `mail.workflow_effect_order`, `workflow_effect_claim` | The same worker removes old ordering rows after the audit window; pending dispatch or active sibling runs keep the ordering. Claims cascade with ordering. |
| `logging.entries` | Core queues cleanup every five minutes; default age 30 days, 10,000-row batches and a bounded pass. |
| `logging.trace_spans`, `trace_events`, `run_minutes` | The same Core job drains age batches, then enforces the configured trace payload budget (default 30 days and 1 GiB). Open spans remain; events cascade with spans. |
| `workflows.event`, `event_delivery` | Core sweeps at startup and every six hours: after 30 days from dispatch/failure, clear payloads and delete deliveries in batches; preserve slim cause/deduplication rows and resumable work. |
| `workflows.run`, `step_outcome` | No automatic age cleanup for execution payloads; workflow deletion cascades. Follow-up: [execution payload retention #3150](https://github.com/k2b-dev/cloud/issues/3150). |
| Pulse samples, events, state changes, rollups | Nightly `pulse:retention` at 03:17 UTC advances through bases in jobs; raw metric partitions drop only after all rows expire and replay/checkpoint guards permit it. ClickHouse TTL handles events, state changes, rollups and sensitive fields. Defaults: raw 30 days, rollups 365 days, sensitive fields 24 hours. Current states are durable state. |

Only the Mail cleanup had the confirmed missing/mismatched age-index and
shared-transaction problem addressed here. Other stores keep their own
retention and provenance contracts.
