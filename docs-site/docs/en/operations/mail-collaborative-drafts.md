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

Mail uses the platform [shared text room](../data/shared-text-documents.md) for
mailboxes configured for shared editing. Lock mode remains the default; this
release does not enable shared editing for other mailboxes.

Each process shares one room and one live Yjs base for each locally edited
draft. An edit travels from the browser through Mail and NATS to editors on
all nodes. Mail acknowledges it after the JetStream publish acknowledgement.
That log is the durability boundary; a SQL snapshot may still be pending.
Edits, peer delivery and cursor updates execute no SQL. Each successful edit
checks lifecycle authority twice in JetStream: before validation and after
publication. Sender acknowledgement waits for the second check too.

Mail checks identity, mailbox access, assignment, draft editability and the
writing lease at join. Committed access and lifecycle events revoke affected
sockets on every node. There is no periodic access query. Deploy the matching
Core identity-event support and browser assets with Mail. Existing tabs that
cannot resume retain their local input and request reopening.

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

Undoable and scheduled sends hold no long-lived freeze. Mail's noneditable
draft state and revocation events deny further editing. At actual dispatch,
Mail briefly freezes again, checks the complete document against the command's
snapshot, then releases the freeze before contacting SMTP. A mismatch refuses
the dispatch. Slow SMTP therefore does not depend on a sixty-second lease.

A definite failure restores the same draft and room for editing. Undo and
cancel do the same through the existing revision and reconnect flow. They
continue the same document generation because the content was not replaced.
Accepted or uncertain outcomes keep the draft noneditable, preserving Mail's existing
send semantics. Their outcome transaction stores a durable close intent.
Mail obtains a fresh verified freeze and closes the room, with an idempotent
receipt so startup can finish a close interrupted by a crash.

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
16 MiB holds roughly 44,000 closed entries before allowing for open or frozen
entries, longer values and operating headroom. This is a storage estimate,
not a supported draft count. Shared editing remains opt-in per mailbox in 0.76;
this release does not perform the broader mailbox migration.

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
hardware and traffic before increasing the opt-in population. Enabling shared
editing for all mailboxes remains a separate decision.
