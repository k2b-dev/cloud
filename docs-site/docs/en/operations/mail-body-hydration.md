---
title: Diagnose delayed Mail content
navTitle: Delayed Mail content
section: Operations
order: 1196
description: Distinguish body queue wait, provider contention, and delayed message discovery.
tags: [mail, operations, synchronization]
updated: 2026-11-01
---

# Diagnose delayed Mail content

When a message appears but its content is still synchronizing, inspect the
mailbox with `cld mail operator status --mailbox <mailbox> --json`. The mailbox operations
API, `GET /api/mail/mailboxes/:mailboxId/operations`, returns the same
`coverage.hydration.timing` values. Both require mailbox administration access
or platform administration access. The text operator status prints them too.
The platform-wide mailbox summary retains coverage counts; inspect an
individual mailbox for its timing samples.

- `queueWaitMs`: time from the durable mailbox request to its first worker
  delivery. A large value points to occupied hydration workers or broker delay.
- `leaseWaitMs`: time from that first delivery until the batch acquires the
  provider lease. This includes resubmitted contention and provider-throttle
  waits. A large value points to competing provider work or a provider pause.
- `batchMs`: elapsed time holding the provider lease for one source batch,
  including provider pacing, source download, parsing, persistence, and live
  invalidation. Failed batches also produce a sample.
- `batchFinishedAt`: when the latest measured batch finished. Values are
  `null` before a sample exists; they are latest samples, not percentiles.

Each Mail process runs up to four hydration jobs. One mailbox takes one batch
of at most 20 sources per turn. The first body batch after an incremental
arrival shares envelope sync priority once that import has no new-mail or
flag continuation left. Initial history, backfill, later body batches and
retries remain background work. A new incremental arrival can promote another
batch. A waiting envelope sync or command can end a body batch after its
current source. Each new body generation joins the lease line again so
commands still alternate with other provider work. Provider pacing, timeout
breakers, and throttling remain in force; provider failures and large messages
can take longer than a few seconds.
Opening a reader does not create a separate job. The arrival already requests
its first batch at this priority; a job per reader would add competing provider
work.

A body that has already failed or returned no source waits for a subsequent
scheduled pass instead of retrying continuously. A message has at most five
hydration attempts. The minute scheduler remains the recovery path for those
message failures; it is not required to wake newly imported messages.

## Separate discovery from body delay

A row that appears late is a different symptom. Compare the time Mail created
the row with its body completion time before investigating hydration. The
provider's `internal_date` is a message date, not proof of when Cloud could
first fetch the message. Delivery delay, provider visibility, push reconnects,
and folder sync duration require separate evidence.

Inspect `cld mail sync runs --mailbox <mailbox> --state failed` and the mailbox
sync status. A long batch may perform flag or UID reconciliation before its
envelopes commit. Body timings start after the envelope commit and cannot
explain time before that commit.

## Upgrade and recovery

Mail adds `mail.hydration_work` on startup. It holds one scheduling and timing
row per mailbox and is deleted with that mailbox. New envelope imports commit
their hydration request in the same transaction. Repeated requests merge;
a request made while the current job finishes gets a new job generation.
A bounded publisher pass retries unpublished generations every second and
recovers them after restart. No new environment setting is required.

Include this table in the existing Mail database backup. Rollback leaves the
additive table in place; an older Mail image uses its former scheduler and
can consume already published jobs but does not advance their durable
generations or update their timings. A later request republishes the generation.
Avoid running older and newer Mail workers together when verifying the new
timing and scheduling behavior.
