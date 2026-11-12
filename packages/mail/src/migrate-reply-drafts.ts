import { sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { eraseRetiredDraftInTransaction, retireDraftInTransaction } from "./service/draft-retirement";
import { removeUnsentOutboundMessage } from "./service/outbound-message-projection";

export const REPLY_DRAFT_MIGRATION_VERSION = 4;
export const REPLY_DRAFT_MIGRATION_NAME = "one_reply_draft";
const log = logger("mail:migrate");
export type ReplyDraftMigrationResult = { deletedDrafts: number; affectedConversations: number; completed: boolean };
// Same attachment count budget as a single draft mutation; at most 100 discarded rows per commit.
const BATCH_SIZE = 100;
const occupied = () => sql`intent <> 'new' AND state IN ('draft', 'scheduled', 'sending')`;

/** Refuse unsafe duplicate conversations before committing the compatibility marker or erasing content.
 * Operators can still start the predecessor to reconcile delivery when this preflight fails.
 */
const initialize = () =>
  sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('cloud.mail.migrations', 0))`;
    const [marker] = await tx`SELECT version FROM mail.schema_migrations WHERE version = ${REPLY_DRAFT_MIGRATION_VERSION}`;
    if (marker) return;
    const [unsafe] = await tx`SELECT d.id FROM mail.drafts d
    WHERE d.intent <> 'new' AND d.state IN ('draft', 'scheduled', 'sending')
      AND EXISTS (SELECT 1 FROM mail.drafts other WHERE other.conversation_id = d.conversation_id AND other.id <> d.id
        AND other.intent <> 'new' AND other.state IN ('draft', 'scheduled', 'sending'))
      AND ((d.state = 'sending' AND NOT EXISTS (SELECT 1 FROM mail.outbox_submissions o JOIN mail.commands c ON c.id = o.command_id
        WHERE o.draft_id = d.id AND o.state IN ('scheduled', 'undo_window') AND c.state = 'queued'))
      OR EXISTS (SELECT 1 FROM mail.outbox_submissions o JOIN mail.commands c ON c.id = o.command_id
        WHERE o.draft_id = d.id AND (o.state NOT IN ('cancelled', 'failed', 'reconciled_unsent', 'scheduled', 'undo_window')
          OR (o.state IN ('scheduled', 'undo_window') AND c.state <> 'queued')))) LIMIT 1`;
    if (unsafe)
      throw new Error(
        "F6 preflight: reconcile in-flight or uncertain deliveries in duplicate conversations using the previous Mail image, then stop it and retry; no F6 marker or deletions were committed",
      );
    await tx`INSERT INTO mail.schema_migrations (version, name, details)
    VALUES (${REPLY_DRAFT_MIGRATION_VERSION}, ${REPLY_DRAFT_MIGRATION_NAME},
      '{"deletedDrafts":0,"affectedConversations":0,"completed":false}')`;
  });

/** Each batch uses the runner's transaction advisory lock; no session locks, including behind poolers. */
const batch = () =>
  sql.begin(async (tx): Promise<ReplyDraftMigrationResult> => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('cloud.mail.migrations', 0))`;
    const [marker] = await tx<{ details: ReplyDraftMigrationResult }[]>`SELECT details FROM mail.schema_migrations
    WHERE version = ${REPLY_DRAFT_MIGRATION_VERSION} FOR UPDATE`;
    if (!marker) throw new Error("Reply draft migration marker is missing");
    const [countConstraint] = await tx<{ validated: boolean }[]>`SELECT convalidated AS validated FROM pg_constraint
      WHERE conrelid = 'mail.drafts'::regclass AND conname = 'drafts_consolidated_count_check'`;
    // VALIDATE uses SHARE UPDATE EXCLUSIVE after the metadata-only schema transaction committed; writes continue.
    if (countConstraint && !countConstraint.validated)
      await tx`ALTER TABLE mail.drafts VALIDATE CONSTRAINT drafts_consolidated_count_check`.simple();
    if (marker.details.completed) return marker.details;
    const [conversation] = await tx<
      { conversation_id: string; mailbox_id: string }[]
    >`SELECT conversation_id, min(mailbox_id::text)::uuid AS mailbox_id
    FROM mail.drafts WHERE ${occupied()} GROUP BY conversation_id HAVING count(*) > 1 ORDER BY conversation_id LIMIT 1`;
    if (!conversation) return marker.details;
    // Match send/cancellation's mailbox -> draft order. New creators also hold the conversation advisory lock.
    await tx`SELECT id FROM mail.mailboxes WHERE id = ${conversation.mailbox_id}::uuid FOR UPDATE`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mail:reply-draft:${conversation.conversation_id}`}, 0))`;
    // updated_at includes idle/adoption/checkpoint writes. Prefer actual content revision evidence; creation is the honest fallback.
    const rows = await tx<{ id: string; consolidated_count: number }[]>`SELECT d.id, d.consolidated_count FROM mail.drafts d
    WHERE d.conversation_id = ${conversation.conversation_id}::uuid AND d.intent <> 'new' AND d.state IN ('draft', 'scheduled', 'sending')
    ORDER BY coalesce(greatest(d.content_edited_at,
      (SELECT max(r.created_at) FROM mail.draft_document_revisions r WHERE r.draft_id = d.id AND r.revision > 1)),
      (SELECT max(s.created_at) FROM mail.draft_provider_snapshots s WHERE s.draft_id = d.id AND s.direction = 'export' AND s.cloud_revision > 1), d.created_at) DESC,
      d.created_at DESC, d.id DESC LIMIT ${BATCH_SIZE + 1} FOR UPDATE OF d`;
    const [survivor, ...losers] = rows;
    if (!survivor || !losers.length) return marker.details;
    for (const loser of losers) {
      const submissions = await tx<
        { id: string; command_id: string; state: string; command_state: string }[]
      >`SELECT o.id, o.command_id, o.state, c.state AS command_state
      FROM mail.outbox_submissions o JOIN mail.commands c ON c.id = o.command_id
      WHERE o.draft_id = ${loser.id}::uuid FOR UPDATE OF o, c`;
      for (const submission of submissions) {
        if (
          !["cancelled", "failed", "reconciled_unsent", "scheduled", "undo_window"].includes(submission.state) ||
          (["scheduled", "undo_window"].includes(submission.state) && submission.command_state !== "queued")
        )
          throw new Error("F6 cannot erase a draft with an in-flight or uncertain delivery; reconcile the send, then restart Mail");
        await tx`UPDATE mail.outbox_submissions SET state = 'cancelled', draft_snapshot = '{}', mime_blob_id = NULL
        WHERE id = ${submission.id}::uuid`;
        await tx`UPDATE mail.commands SET state = 'cancelled', finished_at = now() WHERE id = ${submission.command_id}::uuid`;
        await removeUnsentOutboundMessage(tx, submission.id);
      }
      await tx`UPDATE mail.automatic_reply_effects SET state = 'cancelled' WHERE draft_id = ${loser.id}::uuid AND state = 'queued'`;
      await tx`INSERT INTO mail.reply_draft_retirements (draft_id) VALUES (${loser.id}::uuid) ON CONFLICT DO NOTHING`;
      await retireDraftInTransaction(tx, loser.id);
      await eraseRetiredDraftInTransaction(tx, loser.id);
    }
    const previousCount = rows.reduce((sum, row) => sum + row.consolidated_count, 0);
    await tx`UPDATE mail.drafts SET consolidated_count = ${previousCount + losers.length} WHERE id = ${survivor.id}::uuid`;
    await tx`SELECT mail.enqueue_live_invalidation(${conversation.mailbox_id}::uuid, ${conversation.conversation_id}::uuid)`;
    const result = {
      deletedDrafts: marker.details.deletedDrafts + losers.length,
      affectedConversations: marker.details.affectedConversations + (previousCount === 0 ? 1 : 0),
      completed: false,
    };
    await tx`UPDATE mail.schema_migrations SET details = ${result}::jsonb WHERE version = ${REPLY_DRAFT_MIGRATION_VERSION}`;
    return result;
  });

/** Startup waits for the unique index. Concurrent DDL keeps ordinary table writes available. */
export const migrateReplyDrafts = async (): Promise<ReplyDraftMigrationResult> => {
  await initialize();
  let result = await batch();
  if (result.completed) return result;
  for (;;) {
    const next = await batch();
    if (next.completed) return next;
    if (next.deletedDrafts === result.deletedDrafts) {
      result = next;
      break;
    }
    result = next;
  }
  const [index] = await sql<{ valid: boolean; building: boolean }[]>`SELECT
    coalesce((SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('mail.drafts_one_open_reply_idx')), false) AS valid,
    EXISTS (SELECT 1 FROM pg_stat_progress_create_index WHERE relid = 'mail.drafts'::regclass) AS building`;
  if (!index?.valid) {
    if (index?.building) throw new Error("Mail draft index is being built by another startup; retry startup when it completes");
    await sql`DROP INDEX CONCURRENTLY IF EXISTS mail.drafts_one_open_reply_idx`.simple();
    await sql`CREATE UNIQUE INDEX CONCURRENTLY drafts_one_open_reply_idx ON mail.drafts (conversation_id)
      WHERE intent <> 'new' AND state IN ('draft', 'scheduled', 'sending')`.simple();
  }
  // The conversation-wide constraint subsumes both historical suggestion slot indexes.
  await sql`DROP INDEX CONCURRENTLY IF EXISTS mail.drafts_untouched_suggestion_author_idx`.simple();
  await sql`DROP INDEX CONCURRENTLY IF EXISTS mail.drafts_untouched_suggestion_idx`.simple();
  return sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('cloud.mail.migrations', 0))`;
    const [marker] = await tx<{ details: ReplyDraftMigrationResult }[]>`SELECT details FROM mail.schema_migrations
      WHERE version = ${REPLY_DRAFT_MIGRATION_VERSION} FOR UPDATE`;
    if (!marker) throw new Error("F6 marker disappeared");
    const completed = { ...marker.details, completed: true };
    await tx`UPDATE mail.schema_migrations SET details = ${completed}::jsonb WHERE version = ${REPLY_DRAFT_MIGRATION_VERSION}`;
    if (!marker.details.completed) log.info("Mail F6 reply draft consolidation completed", completed);
    return completed;
  });
};
