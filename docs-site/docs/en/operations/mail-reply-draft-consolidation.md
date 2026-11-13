---
title: Mail reply draft consolidation
navTitle: Mail draft upgrade
section: Operations
order: 6480
description: Prepare the irreversible F6 migration to one reply draft per conversation.
tags: [mail, upgrade, drafts]
updated: 2026-11-13
---

# Mail reply draft consolidation

Mail keeps one open reply draft per conversation. Reply, Reply all and Forward
are modes of that draft. New-message drafts remain independent. Internal notes
are conversation comments and do not occupy the reply draft.

## Before upgrading

Stop all older Mail processes before starting the new image. Start one upgraded
replica first, wait for F6 to finish, then start the remaining replicas. Back up the Mail
database before this upgrade. F6 permanently erases the other reply drafts;
there is no undo or SQL downgrade. Restoring the pre-upgrade backup is the
recovery path. Earlier images refuse schema marker `4 (one_reply_draft)`.

The reply box covers `origin = 'user'`: human drafts, untouched and adopted
service-account suggestions, and workflow review drafts with that origin.
`draft`, `scheduled` and `sending` occupy the box; `sent` and `discarded` release
it. Private automatic replies use `origin = 'workflow'` and remain outside the
box, including failed automatic replies that return to `draft`.

F6 never cancels a committed send. A draft in `scheduled` or `sending`, or with
any active outbox submission, has first priority. Active means every submission
state except `cancelled`, `failed` and `reconciled_unsent`, even if the draft
itself is still in `draft`. If a
conversation has two or more committed sends, startup refuses before marker 4
or any deletion. The error reports their count: let them send or cancel them
using the previous Mail image, stop it, then retry the upgrade. In-flight,
uncertain and inconsistent deliveries also require reconciliation first.

## When preflight keeps refusing

A submission in `accepted`, `sent`, `sent_sync_pending` or `reconciled_accepted`
can still belong to an open reply draft in a duplicate conversation. These
states also block consolidation; the previous image may offer no UI action that
resolves them. Use this read-only query to list those drafts and submissions:

```sql
WITH open_replies AS (
  SELECT id, short_id, conversation_id, state
  FROM mail.drafts
  WHERE origin = 'user' AND intent <> 'new'
    AND state IN ('draft', 'scheduled', 'sending')
), duplicates AS (
  SELECT conversation_id FROM open_replies
  GROUP BY conversation_id HAVING count(*) > 1
)
SELECT d.conversation_id, d.id AS draft_id, d.short_id AS draft_short_id,
  d.state AS draft_state, o.id AS submission_id, o.state AS submission_state
FROM open_replies d
JOIN duplicates c ON c.conversation_id = d.conversation_id
JOIN mail.outbox_submissions o ON o.draft_id = d.id
WHERE o.state IN ('accepted', 'sent', 'sent_sync_pending', 'reconciled_accepted')
ORDER BY d.conversation_id, d.id, o.id;
```

Keep the backup and contact support or the maintainer with the startup error
and query results. Delivery may already have happened. The maintainer must
verify the provider outcome and reconcile the draft lifecycle before retrying
F6. Do not reset submission states, delete drafts or migration markers, or
resend these messages to bypass the refusal.

## What F6 keeps and removes

A committed send has first priority. Otherwise human-authored and adopted
drafts rank ahead of untouched service-account suggestions. Within that
priority, drafts with edit evidence always beat drafts without it, even if the
empty draft was created later. F6 then compares edit timestamps, creation time
and ID, in that order. The edit timestamp is the later of `content_edited_at`
and stored shared-document revisions after revision 1; an exported provider
snapshot after revision 1 is the fallback when neither exists.

For revision-1 drafts without an edit timestamp, F6 also counts body text after
removing signature segments and generated reply or forward history. Signature
templates may have changed or been archived since creation; their marked
segments still do not count as text. This protects text supplied at creation
through `cld mail reply --body`, `mail.draft.create` under a user principal, or
the first compose autosave. The separately stored source quote (`quote_source`)
is not part of the editable body and does not count.

For legacy lock-mode rows, revision greater than 1 also counts as evidence.
A derived subject, reply recipients, a signature-only body and a quote-only
body do not prove an edit. Body and revision evidence take priority over a
newer untouched draft even without a recoverable edit timestamp. Between two
untouched drafts in the same priority, the newer one survives.
Revision is a historical proxy: content writes and send cancellation can
advance it, while idle checkpoints and adoption alone do not. `updated_at`
is excluded because adoption, document checkpoints and idle maintenance also
update it.

Removed drafts have no active submissions. F6 leaves their terminal
`failed`, `reconciled_unsent` and `cancelled` submissions and command history
unchanged. One `draft.discarded` activity per removed draft records
`reason: reply_draft_consolidation`, `count: 1` and the surviving draft ID.
The conversation shows that these drafts were removed during consolidation.

Every removed draft follows the discard and provider-retirement boundary. F6
erases its body, envelope, attachments, recovery copies and document snapshots,
revisions and freezes. A discarded lifecycle tombstone remains for transport
and audit references; it cannot restore the erased draft. Attachment blobs
shared by messages stay available; the normal blob collector reclaims blobs
with no remaining references. Provider retirement runs through the existing
reconciliation sweep. Lease invalidation is checkpointed in SQL and completed
at startup once Sync is available. Discarded generations cannot accept writes;
shared log events become eligible for the existing coverage-based pruning.

The survivor receives `consolidatedCount`, the number of removed drafts. Clients
can show that notice once and clear it with
`POST /api/mail/mailboxes/:mailboxId/drafts/:draftId/consolidation/acknowledge`,
`mail.draft.consolidation.acknowledge`, or
`cld mail draft acknowledge-consolidation <draft-id>`. Acknowledgement requires
a person with write access to an open draft; service accounts cannot acknowledge
it. Acknowledgement changes no content revision. The Mail reply box shows the
notice once as "There were n drafts here. The most recently edited one is in
the box." (n counts the survivor too) with **Got it**, which acknowledges it.
It offers no way to open the removed drafts, because they no longer exist.

## Observe and resume the migration

Operator logs contain **Mail F6 reply draft consolidation completed** with
`deletedDrafts` and `affectedConversations`. `migrate()` returns these counts;
`mail.schema_migrations.details` on marker 4 preserves them after a restart.
The final `completed` field means consolidation and the unique index succeeded.

The new columns use metadata-only defaults. The nonnegative-count check is
added without scanning under the column-addition lock and validated after that
transaction commits, before marker 4, while ordinary writes remain available.
Preflight also refuses consolidation counts or revision/generation counters
that would overflow during consolidation. These refusals leave marker 4 absent
and all drafts intact; resolve the reported data before retrying.

F6 builds a temporary supporting partial index concurrently, excluding sent,
discarded, new-message and private workflow drafts. Building it requires a
fixed number of scans over the table, including historical sent rows; it does
not rescan those millions of rows for each conversation. Each batch groups the
open reply index once, then handles several duplicate conversations, up to
100 deletions per transaction. A conversation with more than 100 losers spans
batches. The same index supports a bounded keyset pass that identifies legacy
source attachment copies before mode switching becomes available. Explicit source
copies created in Reply or Reply all remain personal files. Switching to Forward
does not duplicate copies with the same source message and content hash.
The supporting index is removed after the final unique index is valid.

Each batch uses Mail's existing transaction-scoped migration lock and locks the
affected mailbox and draft rows. It holds no exclusive table lock across
consolidation. Progress, activities and survivor counts commit together;
interrupted runs resume from that checkpoint. If startup fails after marker 4
because of a database outage, lock timeout or interrupted index build, restore
the infrastructure and restart the same upgraded image. The current batch rolls
back; earlier committed batches and their counts are preserved. Repeating
attachment classification and provider retirement is safe. Incomplete or invalid
concurrent indexes are rebuilt on retry. Keep the earlier image stopped: it
refuses marker 4 even while `completed` is false. Never delete the marker to
retry an earlier image.

The unique index is built with
`CREATE UNIQUE INDEX CONCURRENTLY`, outside batch transactions; startup waits
for it. Index-build detection checks that specific index, so unrelated draft
indexes do not block F6. If another startup is building a migration index, retry
after its build finishes. A completed marker skips the destructive work.

After startup, create a reply twice without content and confirm both requests
return the same ID. Supplied content to an occupied box must return
`DRAFT_REPLY_BOX_OCCUPIED` (409), with the existing draft ID in the message.
Switch modes with the current revision and inspect recipients and attachments.
Show any consolidation notice before acknowledging it.

Seed materialization rejects different editable content against another request's
draft with 409 and a structured `draftId`; signature segments are excluded from
that comparison. A retry with the original author's own idempotency key returns
the original stored draft, including for new and derived messages. A subsequent
revision-checked save persists text typed after the first request. The composer keeps local text in its device journal and offers the
existing draft; it does not save over it. Review-reply automation encountering
an occupied box finishes as skipped, with the reason in the automation log.
