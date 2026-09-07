# Grids record-event runtime cutover

PostgreSQL owns the committed record event and its snapshot. The outbox
publisher now reads those rows directly, with one publication in flight per
process and at most 500 claims per dispatch batch. Workflow consumers start
before the background outbox publisher; readiness does not wait for the backlog.
It claims the next eligible row immediately before publishing; a pending,
failed, or dead predecessor continues to block later events for that record.
Publication runs outside the outbox transaction. A successful database commit
is never replaced by a best-effort broker notification. Shutdown stops new
claims and gives accepted publication 30 seconds to finish. Exceeding that
deadline reports a shutdown error; unconfirmed rows remain recoverable.

The existing `grids:workflow-record-events` queue owns workflow-delivery retries
and dead letters. Its 32 partitions and record ordering keys remain unchanged.
Each delivery has 20 attempts, with exponential delays from one second up to
five minutes. A retry holds its partition, including other records hashing to
that partition. The full backoff sequence totals 58 minutes 31 seconds, plus
handler execution time. The budget follows native Sync delivery semantics; a
process crash and broker redelivery can repeat attempts rather than continuing
a PostgreSQL-owned lifetime counter. Exhaustion releases the partition and retains
the event in the native DLQ. Workflow invocation keys stay stable, so replay does not create a
second accepted run for the same workflow and event.

The application no longer increments a separate PostgreSQL workflow-delivery
budget or publishes a new delayed message on every failure. Transient invocation
refusals (409 and server errors) and thrown dispatch failures reach native retry;
other refusals remain logged without inventing an accepted workflow run.
PostgreSQL still owns the producer outbox retry budget and terminal producer
failures, because that work has not yet been confirmed by both destinations.

## Upgrade without deleting accepted work

1. Use the checkout's locked Sync version, at least 6.3.1, for native controls and
   correct partitioned dead-letter replay. Sync 6.2.0 loses ordering metadata
   when writing native dead letters; the corrected release preserves it. A dead letter
   already written by 6.2.0 may still lack its ordering metadata after upgrading.
   Retain it: Grids' preserved PostgreSQL failure payload can be explicitly
   replayed, or an operator can recover the native payload with its Record ID
   as the ordering key. Do not delete the original before confirmed publication.
2. Stop all old Grids producers and workers, and wait for their in-flight
   publication and handlers to finish. Keep the database and NATS streams.
   This is a full-stop cutover; mixed worker versions have different retry
   authority and must not run together.
3. Start the new Grids runtime against the same namespace and application
   identity. Keep `grids:workflow-record-events`, its 32 durable consumers, and
   its DLQ. Keep `grids:records` and all PostgreSQL outbox, snapshot, and failure
   rows. No topic cursor or record identity changes.
4. Verify that existing pending and delayed workflow messages execute, outbox
   pending/failed counts fall, and a native dead letter can be replayed with its
   original ordering key. Inspect the queue through the native Sync controls.
   Old PostgreSQL failures, including unfinished retry history, remain available
   through Grids' historical failure list and replay methods; they are not
   silently republished.

The change from four transport attempts to twenty native attempts requires no
stream or consumer rewrite: the installed Sync implementation keeps
`maxAttempts` and retry delays in the worker. Its broker declaration retains the
same acknowledgment wait, partition filters, and global one-in-flight limit
per partition. An isolated integration test provisions the old configuration,
reopens it with the new worker, and consumes previously accepted work without
resource drift.

The old `job/grids:record-event-outbox` stream, DLQ, and coalescing claim bucket
become unused. Their messages contain only PostgreSQL outbox IDs. Pending and
failed rows remain claimable after their existing 30-second claim expires;
delivered/dead rows remain terminal. Leave those broker resources in place
through verification. Any later removal is a separate operator action after
confirming their IDs still resolve to retained PostgreSQL rows or completed
work. The application does not delete them during startup.

No database migration, mass replay, acknowledgment reset, stream purge, or
user-data deletion is part of this cutover. Existing PostgreSQL workflow retry
history remains untouched; accepted delayed messages continue from the queue
under the new native budget. Both old terminal and unfinished PostgreSQL
failures retain their payload and explicit replay path. A historical `retrying` row does not prove that work is
still pending: the previous implementation did not clear it after success.
Inspect its accepted workflow event before choosing explicit replay. No new
workflow failure is written to that table.

## Focused verification

- `bun test packages/grids/src/service/workflow-record-events.test.ts packages/grids/src/service/record-event-outbox.test.ts`
- `GRIDS_RECORD_EVENTS_DB_TEST=1 bun test packages/grids/src/service/record-event-runtime.integration.test.ts`
- `GRIDS_SYNC_TEST=1 NATS_TEST_SERVERS=nats://127.0.0.1:14222 bun test packages/grids/src/service/record-event-native-retry.integration.test.ts`

The PostgreSQL test creates and removes its own local database. The NATS tests
use unique namespaces and remove only their own broker resources. They do not
change a running application's records, cursors, consumers, or retained work.
