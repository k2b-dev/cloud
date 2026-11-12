---
title: Mail reply draft consolidation
navTitle: Mail draft upgrade
section: Operations
order: 6480
description: Prepare the irreversible F6 migration to one reply draft per conversation.
tags: [mail, upgrade, drafts]
updated: 2026-11-12
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

A scheduled draft and a draft awaiting delivery occupy the same place as an
editable draft. The unique constraint covers `draft`, `scheduled` and `sending`,
for every origin: people, untouched or adopted service-account suggestions,
workflow review drafts and automatic replies. `sent` and `discarded` release
that place.

F6 cancels queued, cancellable sends belonging to removed drafts and removes
their unsent conversation entries. Before committing marker 4 or erasing anything, a preflight refuses duplicated
conversations with a running, accepted, uncertain or inconsistent pending send.
The predecessor can still start after that refusal: use it to reconcile the
delivery, stop it, then retry the upgrade. This prevents erasing evidence of a possible send.
The surviving draft keeps its delivery state and schedule.

## What F6 keeps and removes

For each conversation with multiple open reply drafts, F6 keeps the most recent
content edit. It uses the later of `content_edited_at` and stored shared-document
revisions after revision 1. When neither direct signal exists, an exported
provider revision snapshot after revision 1 is the best available proxy, though
export can lag behind the edit. Creation time is the final fallback; creation time and ID break ties.
Legacy rows without revision evidence have no trustworthy last-edit timestamp.
`updated_at` is deliberately excluded: adoption, document checkpoints and idle
maintenance also update it.

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
write access and changes no content revision.

## Observe and resume the migration

Operator logs contain **Mail F6 reply draft consolidation completed** with
`deletedDrafts` and `affectedConversations`. `migrate()` returns these counts;
`mail.schema_migrations.details` on marker 4 preserves them after a restart.
The final `completed` field means consolidation and the unique index succeeded.

The new columns use metadata-only defaults. The nonnegative-count check is
added without scanning under the column-addition lock and validated after that
transaction commits, while ordinary writes remain available.

F6 commits at most 100 discarded drafts per batch under Mail's existing
transaction-scoped migration lock. It locks the affected mailbox and draft
rows, without holding an exclusive table lock across consolidation. Progress
and each survivor's count commit with the deletions. An interrupted run resumes
from that checkpoint. The unique index is built with `CREATE UNIQUE INDEX
CONCURRENTLY`, outside the batch transactions; startup waits for it. If another
startup is building the draft index, retry startup after that build finishes.
A completed marker makes later starts skip the destructive work.

After startup, create a reply twice and confirm both requests return the same
ID. Switch its mode with its current revision, check recipients and attachments,
and acknowledge any consolidation notice after displaying it. An automatic
reply that finds an occupied reply draft is suppressed with
`reply_draft_exists`; it never sends the existing draft.
