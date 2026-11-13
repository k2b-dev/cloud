---
title: Mail collaborative drafts
navTitle: Collaborative drafts
section: Operations
order: 1200
description: Durability, lazy projections and operating limits for shared Mail drafts.
tags: [mail, collaboration, upgrade, scaling]
updated: 2026-11-13
---

# Mail collaborative drafts

Starting with Cloud 0.77, shared editing is the default for every new Mail
mailbox. Mail uses the platform [shared text room](../data/shared-text-documents.md)
so people with write access can edit a draft together. Existing mailboxes switch
to shared once after the draft log is ready.

Each process shares one room and one live Yjs base for each locally edited
draft. An edit travels from the browser through Mail and NATS to editors on
all nodes. Mail acknowledges it after the JetStream publish acknowledgement.
That log is the durability boundary; a SQL snapshot may still be pending. The
editor shows “Saved” only after retained server updates cover the visible input. A
transport echo, an unrelated peer update or offline device storage cannot provide
that receipt. While connected input awaits its receipt the editor shows “Saving…”;
offline input keeps the local-storage indicator and any storage error.

Edits, peer delivery and cursor updates execute no SQL. Each successful edit
checks lifecycle authority twice in JetStream: before validation and after
publication. Sender acknowledgement waits for the second check too.

Mail checks identity, mailbox access, assignment, draft editability and the
writing lease at join. Committed access and lifecycle events revoke affected
sockets on every node. There is no periodic access query. Deploy the matching
Core identity-event support and browser assets with Mail. Existing tabs that
cannot resume retain their local input and request reopening.

## Upgrade and switch back to lock

The one-time upgrade has the same draft-mode semantics as an administrator's
PATCH. It deliberately writes no audit entries or live invalidations, avoiding
10,000 audit rows and notification writes (DATA-13). Open drafts keep their
existing `edit_mode`, document generation and history. Open lock drafts remain
in lock mode until sent or discarded; new user drafts inherit the mailbox's
current setting.

Mail stores compatible upgrade progress in `mail.shared_drafts_default_migration`,
which Cloud 0.76 ignores. It adds no schema compatibility ledger entry, so older
replicas can restart during a rolling deployment or rollback. The row's `details`
contain the last mailbox ID, mailbox and batch counts, and `completed`. Each
transaction switches at most 100 mailboxes in ID order and commits its cursor.
An interrupted run resumes after that cursor. It never scans or locks drafts.

```sql
SELECT name, details FROM mail.shared_drafts_default_migration;
```

A mailbox administrator can switch a mailbox back to lock at any time:

```bash
cld mail configure --mailbox <id> --drafts lock
```

The API equivalent is `PATCH /api/mail/mailboxes/:mailboxId` with
`{"draftEditMode":"lock"}`. Mailbox settings currently have no draft-mode
selector; use the CLI or API for this setting. The explicit lock setting
survives restarts and later Mail upgrades. An explicit mode PATCH records
`draft_edit_mode_explicit` on the mailbox, so the migration skips that choice
even while log preparation is deferred or the mailbox lies ahead of its cursor.
A completed migration never reapplies settings.

During a mixed 0.76/0.77 rollout, send mode changes to a 0.77 replica. A 0.76
replica cannot record the explicit-choice flag: its lock selection ahead of the
cursor can still be overwritten. Reapply such selections through 0.77 or after
migration completion. Existing shared drafts keep working until
sent or discarded. Use `--drafts shared` to enable shared editing again.

While this process prepares its log policy, explicitly selecting shared via
PATCH returns `409 SHARED_DRAFTS_UNSUPPORTED`. Default creation still stores
shared; it never silently creates a lock mailbox or lock draft. Opening a
shared draft before history checks finish returns a clear starting/retry
error. A failed policy preparation is logged, leaves this upgrade's marker
unset, and retries on a later start. Existing lock mailboxes stay available
until preparation succeeds. Do not remove the marker or bypass readiness
with database writes.

An isolated PostgreSQL 17.11 run with 10,000 mailboxes and 50,000 open lock
drafts completed the switch in 1.134 seconds. `meterSql()` counted 100
nonempty batches, one terminal probe, 101 transactions and 908 statements
(including BEGIN/COMMIT). The longest transaction was 37 ms, measured from
PostgreSQL statement timestamps through COMMIT completion at 1 ms resolution.
This measures the setting migration after schema and log preparation.

Each batch takes the existing transaction-scoped migration advisory lock,
row locks on its marker and at most 100 mailboxes, and RowShare/RowExclusive
table locks on those two tables, plus the corresponding index locks. Ordinary
transaction and virtual-transaction ID locks also apply. The mailbox update trigger only
changes `updated_at`; no statement or trigger accesses `mail.drafts`. The
separate schema step sets the column default under the existing startup DDL
lock. These lock claims follow from the executed statements and trigger,
not a production latency guarantee.

## Projections and recovery

Mail queues a snapshot after three seconds without input and at most thirty
seconds after the first unsaved edit. It flushes synchronously on the last
local editor's leave, shutdown and send. One distributed writer saves each
draft. Successful snapshots update the body, subject, recipients, sender,
compose settings, human adoption, revision and provider export request.
Lifecycle markers advance coverage without changing a reviewed revision.

List previews and search can therefore lag live editing by the snapshot delay
plus snapshot queue time. Provider copies also wait for the existing provider
export queue. These are queueing bounds, not a guarantee that an unavailable
provider finishes within thirty seconds. Startup and hourly reconciliation
recover work that outlived a process.

The document log retains accepted input until all replayable drafts have
covering SQL snapshots. Mail then prunes the covered prefix. A full log
rejects new edits; browsers keep unacknowledged input for retry. Incomplete
history requires explicit recovery and cannot be sent.

With Sync 7.1.1, a join whose missing prefix is covered by the SQL snapshot
rebases in place. A gap in the live stream reconnects with backoff and resends
pending input. For an uncovered gap, Mail saves the valid retained updates at
the captured head, preserves the original revision and marks history incomplete.
The next join requests recovery rather than reopening incomplete content for editing.

## Sending and Undo

The browser waits for its visible input to be accepted before reviewing and
submitting a send. Mail freezes the draft across nodes, drains accepted input
and flushes the exact state. It commits the send command, immutable content
snapshot and scheduled draft state in one SQL transaction, then releases the
freeze. Cancellation or rollback releases it too.

Undoable and scheduled sends hold no long-lived freeze. New joins check the
draft state. Existing editors lose access when the committed revocation event
reaches their node. During this revocation window, after thaw and before event
delivery, an existing editor can still publish an edit. At actual dispatch,
Mail briefly freezes again, checks the complete document against the command's
snapshot, then releases the freeze before contacting SMTP. A mismatch refuses
the dispatch and returns the draft for review and editing. Temporary room or
broker failures before SMTP use Mail's bounded send retries. Slow SMTP therefore
does not depend on a sixty-second lease.

A definite failure restores the same draft and room for editing. Undo and
cancel do the same through the existing revision and reconnect flow. They
continue the same document generation because the content was not replaced.
Accepted or uncertain outcomes keep the draft noneditable, preserving Mail's existing
send semantics. Their outcome transaction stores a durable close intent.
Mail drains a fresh freeze and closes the room, with an idempotent receipt so
startup can finish a close interrupted by a crash. Once the outcome has committed,
the sent draft state is authoritative: late room input is drained only into the
technical document snapshot and cannot change the outbound content or prevent
retirement. A definite snapshot rejection during dispatch releases its freeze
immediately, so a content mismatch returns an editable draft without waiting for
the lease to expire.

Changing reply or forward mode replaces document content. Mail checks lifecycle
authority under document admission, publishes the platform's ordered generation
marker, and anchors the replacement SQL snapshot to that cursor. A rolled-back
replacement restores its previous generation marker. Editors reconnect to the
replacement document; frozen and closed rooms reject replacement.

## Capacity and deployment

Keep all shared-text declarations identical across Mail nodes. The retained
document log reserves 1 GiB, awareness reserves 64 MiB, and lifecycle authority
reserves 16 MiB per replica. Snapshot jobs and dead letters have their own
platform budgets. Preserve lifecycle authority together with the document log
and SQL snapshots in backups. Drain older nodes without lifecycle admission
before enabling this release's shared editing path.

Connection, process buffer, payload and retained-history limits remain bounded.
Backpressure retains the browser's unconfirmed input. Watch process RSS,
JetStream storage, snapshot backlog and durable close errors when increasing
the number of simultaneous drafts. Keep inter-node clocks within the platform's
five-second freeze safety margin.

Mail retains closed lifecycle entries after send. Cleanup must wait until
the platform can prove every producer has drained; asynchronous close and
access events alone do not establish that boundary. Monitor lifecycle storage
as well as the retained content log. A full lifecycle stream rejects new
lifecycle transitions without evicting existing fences.
Safe retirement is tracked in [#3254](https://github.com/k2b-dev/cloud/issues/3254).

Each Mail process can open one additional PostgreSQL control connection,
created lazily on the first cancelled shared-draft transaction. It cancels
reserved transactions without waiting for a free slot in their application
pool, and closes after Mail's runtimes drain. Include this extra connection
when sizing PostgreSQL's connection limit.

An isolated sample of 100 closed drafts with seven-digit log sequences used
139 JSON bytes and about 377 JetStream-reported bytes per entry. At that size,
16 MiB holds roughly 44,500 closed entries before allowing for open or frozen
entries, longer values and operating headroom. This is a storage estimate,
not a supported draft count. Allow operating headroom as shared editing becomes
the default in 0.77.

An isolated two-node test with 4096-byte starting documents, one edit per
editor every two seconds and awareness traffic passed for 200 drafts with
two and three editors each. Each node had two CPUs, a 1536 MiB hard memory
limit and a 1024 MiB RSS abort budget. Cross-node p50/p95 was 240/600 ms for
two editors and 290/950 ms for three; edit and delivery SQL was zero. Peak
node RSS was 653/645 MiB and 791/822 MiB respectively. The 60-second runs
also exercised exact send, Undo, resumed editing and access revocation on
both nodes. A later 200-draft smoke covered reply/forward mode replacement.

At 500 drafts with two editors, the test stopped at 1037 MiB RSS; observed
cross-node p95 was 3330 ms. That configuration is outside the measured budget.
The 200-draft result has limited latency headroom and does not establish a
production concurrency guarantee. Measure with the operator's document sizes,
hardware and traffic before increasing concurrent editing. The shared mailbox
default does not increase these measured capacity limits.
