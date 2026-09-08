# Grids record-event runtime cutover

PostgreSQL owns the committed record event and its snapshot. The outbox
publisher reads those rows directly: it claims a slice of at most eight rows
immediately before publishing it, publishes that slice in parallel, and stops
after 500 rows per dispatch pass. A claim never contains a record that still
has an earlier pending, failed, or dead event, so parallel publication keeps
per-record order. Workflow consumers start before the background outbox
publisher; readiness does not wait for the backlog. Publication runs outside
the outbox transaction. A successful database commit is never replaced by a
best-effort broker notification. Shutdown stops new claims and gives accepted
publication 30 seconds to finish. Exceeding that deadline reports a shutdown
error; unconfirmed rows remain recoverable.

Combined-table targets receive the projected event on the `grids:records`
topic only. The workflow queue does not carry them: the committed snapshot
belongs to the source table, so a record-event trigger bound to a Combined
table has nothing to evaluate. Such a trigger never fires; workflows read
Combined data through queries instead.

## Workflow delivery retries

The `grids:workflow-record-events` queue keeps its 32 partitions and record
ordering keys. PostgreSQL owns the retry budget for workflow delivery:

- A failed dispatch is written to `grids.record_event_delivery_failures`
  (consumer group `workflow-kernel-queue-v1`, one row per accepted delivery,
  attempts incremented on every failure, `dead` at 20). The stored error names
  every workflow that failed for the event.
- If the row is not dead, the handler re-sends the same event to the same
  queue with the record as ordering key, the original tenant and metadata, a
  fresh idempotency key, and a delay of 1 s doubling to a five-minute cap. The
  original delivery is acknowledged. The retry waits at the tail of its
  partition; other records on that partition keep flowing. Nothing holds a
  partition for a broken workflow.
- A dead row acknowledges the delivery without re-sending. Deleting the base
  (foreign-key failure on the failure row) also acknowledges it.
- Only an unavailable failure store propagates to the transport. The queue
  allows three in-place attempts (1 s and 5 s apart) for that case before the
  delivery reaches the native dead-letter store. Payloads that fail schema
  validation take the same path; they are transport corruption, not workflow
  failures.

Workflow invocation keys stay stable across retries, so a re-sent event does
not create a second accepted run for the same workflow and event. Transient
invocation refusals (409 and server errors) and thrown dispatch failures count
as failed attempts; other refusals remain logged without inventing a run.
PostgreSQL also owns the producer outbox retry budget and terminal producer
failures, because that work has not yet been confirmed by both destinations.

## Inspecting and replaying failures

Failure inspection and replay are service methods without an HTTP route or
CLI command:

- `gridsService.workflow.runtime.listRecordEventFailures(baseId, limit)` and
  `replayRecordEventFailure(baseId, id)` read and republish rows of
  `grids.record_event_delivery_failures`, including historical rows and
  producer dead letters (`record-event-outbox`).
- `gridsService.record.eventOutboxStats()` and `redriveEventOutbox(id)`
  report and redrive the producer outbox.
- Native dead letters (failure store unavailable, invalid payload) are reached
  through `sync.controls()` for the `grids:workflow-record-events` queue.

Operators reach the service methods from a process that has started the Grids
application (a maintenance script importing `@valentinkolb/cloud-app-grids`),
or inspect the table directly in PostgreSQL. A `retrying` row proves that an
attempt failed; it does not prove that a retry is still queued. Compare it
with the accepted workflow event before choosing explicit replay: replay
publishes the event with a fresh replay key, which starts a new failure row.

## Upgrade without deleting accepted work

1. Use the checkout's locked Sync version, at least 6.3.1, for native controls
   and correct partitioned dead-letter replay. Sync 6.2.0 loses ordering
   metadata when writing native dead letters; the corrected release preserves
   it. A dead letter already written by 6.2.0 may still lack its ordering
   metadata after upgrading. Retain it: Grids' preserved PostgreSQL failure
   payload can be explicitly replayed, or an operator can recover the native
   payload with its Record ID as the ordering key. Do not delete the original
   before confirmed publication.
2. Stop all old Grids producers and workers, and wait for their in-flight
   publication and handlers to finish. Keep the database and NATS streams.
   This is a full-stop cutover; mixed worker versions have different retry
   authority and must not run together.
3. Start the new Grids runtime against the same namespace and application
   identity. Keep `grids:workflow-record-events`, its 32 durable consumers, and
   its DLQ. Keep `grids:records` and all PostgreSQL outbox, snapshot, and
   failure rows. No topic cursor or record identity changes.
4. Verify that existing pending and delayed workflow messages execute, outbox
   pending/failed counts fall, and a failed delivery produces a
   `record_event_delivery_failures` row and a delayed re-send instead of a
   native dead letter. Inspect the queue through the native Sync controls.

Changing the transport attempt budget requires no stream or consumer rewrite:
the installed Sync implementation keeps `maxAttempts` and retry delays in the
worker. Its broker declaration retains the same acknowledgment wait, partition
filters, and global one-in-flight limit per partition. An isolated integration
test provisions the previous configuration, reopens it with the new worker,
and consumes previously accepted work without resource drift. Messages that a
previous worker version had already re-queued or delayed continue under the
PostgreSQL budget; their first failure under the new worker starts a failure
row keyed by their message ID.

The old `job/grids:record-event-outbox` stream, DLQ, and coalescing claim bucket
become unused. Their messages contain only PostgreSQL outbox IDs. Pending and
failed rows remain claimable after their existing 30-second claim expires;
delivered/dead rows remain terminal. Leave those broker resources in place
through verification. Any later removal is a separate operator action after
confirming their IDs still resolve to retained PostgreSQL rows or completed
work. The application does not delete them during startup.

No database migration, mass replay, acknowledgment reset, stream purge, or
user-data deletion is part of this cutover. Existing PostgreSQL failure rows
retain their payload and explicit replay path.

## Focused verification

- `bun test packages/grids/src/service/workflow-record-events.test.ts packages/grids/src/service/record-event-outbox.test.ts`
- `GRIDS_DB_TEST=1 bun test packages/grids/src/service/record-event-delivery-failures.integration.test.ts`
- `GRIDS_RECORD_EVENTS_DB_TEST=1 bun test packages/grids/src/service/record-event-runtime.integration.test.ts`
- `GRIDS_SYNC_TEST=1 NATS_TEST_SERVERS=nats://127.0.0.1:14222 bun test packages/grids/src/service/record-event-retry.integration.test.ts`

The isolated PostgreSQL test creates and removes its own local database. The
NATS tests use unique namespaces and remove only their own broker resources.
They do not change a running application's records, cursors, consumers, or
retained work.
